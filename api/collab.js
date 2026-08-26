/* ═══════════════════════════════════════════════════════════════
   GENIWORK — Vercel Serverless Function : demandes de collaboration
   POST /api/collab  { authRefreshToken, action, ...champs selon action }
   Actions : create, apply, close

   Phase 9D-ter-bis : bascule vers gw/collab_requests_v2/{ownerUid}/
   {requestId} (métadonnées publiques + photos) + gw/collab_request_docs_v2/
   {ownerUid}/{requestId} (document privé, jamais dans les métadonnées
   publiques). gw/collab_requests (v1, tableau global) N'EST PLUS ÉCRIT
   par cet endpoint — reste intact en lecture seule pour rollback (cf.
   rapport Phase 9D-ter-bis). L'architecture ID-keyed élimine le besoin
   d'ETag/retry pour apply/close (chaque écriture cible une clé unique,
   plus de lecture-modification-réécriture d'un tableau partagé) — seul
   create reste une composition de 2 écritures (métadonnées + document
   optionnel), sans risque de conflit puisqu'un requestId est toujours
   nouveau.
═══════════════════════════════════════════════════════════════ */

const { dbGet, dbSet, emailKey, checkRateLimit } = require('./admin/_lib/fbrest');
const { verify: verifyRefreshToken } = require('./auth/_lib/refreshToken');

var MAX_TITLE = 200, MAX_DESC = 3000, MAX_SKILLS = 20, MAX_SKILL_LEN = 40;
var MAX_IMGS = 4, MAX_DOCS = 1, MAX_ATTACH_B64 = 7 * 1024 * 1024; /* ~5 Mo binaires + marge base64 */

function validAttachment(a, wantImg) {
  if (!a || typeof a !== 'object') return false;
  if (typeof a.name !== 'string' || a.name.length > 200) return false;
  if (typeof a.type !== 'string' || a.type.length > 100) return false;
  if (typeof a.data !== 'string' || a.data.length > MAX_ATTACH_B64 || a.data.indexOf('data:') !== 0) return false;
  return !!a.isImg === !!wantImg;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  var body = req.body || {};

  var ticketData = verifyRefreshToken(body.authRefreshToken);
  if (!ticketData || !ticketData.email) {
    res.status(401).json({ error: 'Session expirée, reconnectez-vous.' });
    return;
  }
  var callerEmail = ticketData.email;
  var callerUid = emailKey(callerEmail);

  if (body.action === 'create') {
    /* Phase SYNC-64 : rate-limit fail-closed — jusqu'à 4 photos + 1 document
       en base64 (MAX_ATTACH_B64=7 Mo par pièce jointe), un profil de charge
       au moins équivalent à groups/cover-upload.js (seul précédent upload
       du projet, 10/h fail-closed) ; seuil aligné sur ce précédent plutôt
       qu'inventé, avant tout traitement des pièces jointes ci-dessous. */
    var rl = await checkRateLimit('collab:create:' + callerUid, 10, 60 * 60 * 1000);
    if (rl.ok === false) { res.status(429).json({ error: 'Trop de demandes de collaboration récentes. Réessayez dans ' + rl.retryAfterSec + 's.' }); return; }
    if (rl.ok === null) { res.status(503).json({ error: 'Service de protection anti-abus temporairement indisponible.' }); return; }

    var title = typeof body.title === 'string' ? body.title.trim().slice(0, MAX_TITLE) : '';
    var description = typeof body.description === 'string' ? body.description.trim().slice(0, MAX_DESC) : '';
    if (!title || !description) { res.status(400).json({ error: 'Titre et description requis' }); return; }

    var domain = typeof body.domain === 'string' ? body.domain.slice(0, 30) : 'autre';
    var duration = typeof body.duration === 'string' ? body.duration.slice(0, 30) : 'indeter';
    var remote = !!body.remote;
    var budget = { amount: 0, type: 'fixed' };
    if (body.budget && typeof body.budget === 'object') {
      budget.amount = typeof body.budget.amount === 'number' && isFinite(body.budget.amount) ? Math.max(0, body.budget.amount) : 0;
      budget.type = typeof body.budget.type === 'string' ? body.budget.type.slice(0, 20) : 'fixed';
    }
    var skills = [];
    if (Array.isArray(body.skills)) {
      skills = body.skills.filter(function(s) { return typeof s === 'string'; }).slice(0, MAX_SKILLS).map(function(s) { return s.slice(0, MAX_SKILL_LEN); });
    }

    /* Photos : publiques par conception (déjà le comportement produit avant
       la bascule) — restent dans les métadonnées. Document : jamais dans
       les métadonnées, toujours écrit séparément dans collab_request_docs_v2. */
    var photos = [];
    var document = null;
    if (Array.isArray(body.attachments)) {
      if (body.attachments.length > MAX_IMGS + MAX_DOCS) { res.status(400).json({ error: 'Trop de pièces jointes' }); return; }
      for (var i = 0; i < body.attachments.length; i++) {
        var a = body.attachments[i];
        if (a && a.isImg) {
          if (!validAttachment(a, true)) { res.status(400).json({ error: 'Photo invalide' }); return; }
          if (photos.length >= MAX_IMGS) { res.status(400).json({ error: 'Maximum ' + MAX_IMGS + ' photos' }); return; }
          photos.push(a);
        } else if (a) {
          if (!validAttachment(a, false)) { res.status(400).json({ error: 'Document invalide' }); return; }
          if (document) { res.status(400).json({ error: 'Maximum ' + MAX_DOCS + ' document' }); return; }
          document = a;
        }
      }
    }

    var profile;
    try { profile = await dbGet('/gw/profiles/' + callerUid); } catch (e) { profile = null; }
    var nom = (profile && profile.nom) || callerEmail;

    var requestId = 'collabv2_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    var request = {
      id: requestId, title: title, description: description, domain: domain, skills: skills,
      duration: duration, remote: remote, budget: budget,
      postedBy: callerEmail, postedByNom: nom,
      photos: photos, hasDocument: !!document,
      date: new Date().toISOString(), status: 'active', applicants: {},
    };

    try {
      await dbSet('/gw/collab_requests_v2/' + callerUid + '/' + requestId, request);
      if (document) await dbSet('/gw/collab_request_docs_v2/' + callerUid + '/' + requestId, document);
    } catch (e) {
      res.status(500).json({ error: 'Échec de la publication' });
      return;
    }
    res.status(200).json({ ok: true, request: request });
    return;
  }

  if (body.action === 'apply') {
    if (typeof body.ownerUid !== 'string' || !body.ownerUid || body.ownerUid.length > 200) { res.status(400).json({ error: 'ownerUid invalide' }); return; }
    if (typeof body.requestId !== 'string' || !body.requestId || body.requestId.length > 100) { res.status(400).json({ error: 'requestId invalide' }); return; }

    var meta;
    try { meta = await dbGet('/gw/collab_requests_v2/' + body.ownerUid + '/' + body.requestId); }
    catch (e) { res.status(500).json({ error: 'Erreur serveur' }); return; }
    if (!meta) { res.status(404).json({ error: 'Demande introuvable' }); return; }
    if (meta.postedBy && meta.postedBy.toLowerCase() === callerEmail.toLowerCase()) {
      res.status(400).json({ error: 'Vous ne pouvez pas postuler à votre propre demande' });
      return;
    }
    if (meta.applicants && meta.applicants[callerUid]) {
      res.status(200).json({ ok: true, alreadyApplied: true });
      return;
    }

    /* Écriture CIBLÉE sur une seule clé — aucune lecture-modification-
       réécriture de la demande entière, donc aucun risque de conflit avec
       une autre candidature simultanée (contrairement à v1). */
    try { await dbSet('/gw/collab_requests_v2/' + body.ownerUid + '/' + body.requestId + '/applicants/' + callerUid, true); }
    catch (e) { res.status(500).json({ error: 'Échec de la candidature' }); return; }
    res.status(200).json({ ok: true });
    return;
  }

  if (body.action === 'close') {
    if (typeof body.requestId !== 'string' || !body.requestId || body.requestId.length > 100) { res.status(400).json({ error: 'requestId invalide' }); return; }

    var meta2;
    try { meta2 = await dbGet('/gw/collab_requests_v2/' + callerUid + '/' + body.requestId); }
    catch (e) { res.status(500).json({ error: 'Erreur serveur' }); return; }
    if (!meta2) { res.status(404).json({ error: 'Demande introuvable' }); return; }
    if (!meta2.postedBy || meta2.postedBy.toLowerCase() !== callerEmail.toLowerCase()) {
      res.status(403).json({ error: 'Vous n\'êtes pas l\'auteur de cette demande' });
      return;
    }

    /* Champ ciblé uniquement — photos/document jamais touchés. */
    try { await dbSet('/gw/collab_requests_v2/' + callerUid + '/' + body.requestId + '/status', 'closed'); }
    catch (e) { res.status(500).json({ error: 'Échec de la clôture' }); return; }
    res.status(200).json({ ok: true });
    return;
  }

  res.status(400).json({ error: 'Action inconnue' });
};
