/* ═══════════════════════════════════════════════════════════════
   GENIWORK — POST /api/groups/cover-upload (Phase GROUPS-FREE-04 etape 2)

   Ajoute/remplace la couverture d'un groupe libre. Reserve au
   proprietaire et aux administrateurs (meta/admins/{uid}===true —
   vide tant que GROUPS-FREE-04 etape 3 n'a pas ete implementee,
   donc equivalent a "proprietaire seul" pour l'instant, sans code a
   revoir plus tard). Fichier stocke prive (aucune Storage Rule
   dediee, voir api/groups/_lib/gcsrest.js) ; seul meta/coverPath et
   meta/coverUpdatedAt sont ecrits en RTDB (jamais coverUrl — aucune
   URL publique n'est jamais generee pour ce chemin).

   Body : { authRefreshToken, groupId, imageBase64, contentType }
   Reponse : { ok:true, coverUpdatedAt } ou { ok:false, error }
═══════════════════════════════════════════════════════════════ */

const { dbSet, emailKey, checkRateLimit } = require('../admin/_lib/fbrest');
const { verify: verifyRefreshToken } = require('../auth/_lib/refreshToken');
const { loadGroupRole, isValidGroupId } = require('./_lib/perm');
const { gcsUpload, gcsDelete } = require('./_lib/gcsrest');

const ALLOWED_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_BYTES = 5 * 1024 * 1024;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Method not allowed' }); return; }

  try {
    const body = req.body || {};

    const ticketData = verifyRefreshToken(body.authRefreshToken);
    if (!ticketData || !ticketData.email) {
      res.status(401).json({ ok: false, error: 'Connecte-toi pour modifier ce groupe.' });
      return;
    }
    const callerEmail = ticketData.email;

    /* Phase SYNC-55 : rate-limit fail-closed — upload (cout bande passante/stockage). */
    const rl = await checkRateLimit('groups:cover-upload:' + emailKey(callerEmail), 10, 60 * 60 * 1000);
    if (rl.ok === false) { res.status(429).json({ ok: false, error: 'Trop de televersements recents. Reessayez dans ' + rl.retryAfterSec + 's.' }); return; }
    if (rl.ok === null) { res.status(503).json({ ok: false, error: 'Service de protection anti-abus temporairement indisponible.' }); return; }

    if (!isValidGroupId(body.groupId)) {
      res.status(400).json({ ok: false, error: 'groupId invalide' });
      return;
    }

    const contentType = body.contentType;
    const ext = ALLOWED_TYPES[contentType];
    if (!ext) {
      res.status(400).json({ ok: false, error: 'Format non supporte (JPG, PNG ou WebP uniquement)' });
      return;
    }

    if (typeof body.imageBase64 !== 'string' || !body.imageBase64) {
      res.status(400).json({ ok: false, error: 'Image manquante' });
      return;
    }
    let buffer;
    try { buffer = Buffer.from(body.imageBase64, 'base64'); } catch (e) {
      res.status(400).json({ ok: false, error: 'Image invalide' });
      return;
    }
    if (!buffer.length || buffer.length > MAX_BYTES) {
      res.status(400).json({ ok: false, error: 'Image trop volumineuse (5 Mo max)' });
      return;
    }

    let role;
    try { role = await loadGroupRole(body.groupId, callerEmail); } catch (e) {
      res.status(500).json({ ok: false, error: 'Erreur serveur' });
      return;
    }
    if (!role) { res.status(404).json({ ok: false, error: 'Groupe introuvable' }); return; }
    /* isMember exige en plus : une entree meta/admins/{uid} orpheline (membre
       retire par un autre admin, qui ne peut pas nettoyer cette entree lui-meme
       cote Rules) ne doit jamais suffire a garder ce droit apres exclusion. */
    if (!role.isMember || (!role.isOwner && !role.isAdmin)) {
      res.status(403).json({ ok: false, error: 'Seul le proprietaire ou un administrateur peut modifier la couverture' });
      return;
    }

    const newPath = 'group_covers/' + body.groupId + '/cover.' + ext;
    const oldPath = role.meta.coverPath;

    try { await gcsUpload(newPath, buffer, contentType); } catch (e) {
      console.error('[Groupe libre] Echec upload cover:', e.message);
      res.status(500).json({ ok: false, error: 'Echec de l\'upload' });
      return;
    }

    /* Remplacement avec extension differente (ex: png -> jpg) : nettoie
       l'ancien fichier orphelin. Best-effort, ne bloque jamais la reponse. */
    if (oldPath && oldPath !== newPath) {
      try { await gcsDelete(oldPath); } catch (e) { /* best-effort */ }
    }

    const coverUpdatedAt = Date.now();
    await dbSet('/gw/group_msgs/' + body.groupId + '/meta/coverPath', newPath);
    await dbSet('/gw/group_msgs/' + body.groupId + '/meta/coverUpdatedAt', coverUpdatedAt);

    res.status(200).json({ ok: true, coverUpdatedAt });
  } catch (err) {
    console.error('[Geniwork Groupes] erreur cover-upload:', err.message);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
};
