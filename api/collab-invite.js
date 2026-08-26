/* ═══════════════════════════════════════════════════════════════
   GENIWORK — Vercel Serverless Function : invitation de collaboration
   POST /api/collab-invite  { authRefreshToken, action, ...champs }

   Phase 9D : gw/collab_invites/{userFbKey} passait auparavant par une
   écriture CLIENT DIRECTE cross-user (_saveCollabInvites(targetEmail,...)
   → .set() dans la boîte d'un AUTRE utilisateur, sans aucune preuve
   métier — un attaquant pouvait injecter une fausse invitation
   (ownerEmail/projTitle arbitraires) dans la boîte de n'importe qui, et
   écraser au passage ses invitations existantes). Désormais :
     1. L'identité de l'appelant vient UNIQUEMENT de authRefreshToken
        (jamais un champ "ownerEmail" fourni par le client).
     2. Le serveur revérifie que l'appelant possède RÉELLEMENT le projet
        cité (gw/projects/{callerUid}/{projId}) avant de créer
        l'invitation — jamais une simple affirmation.
     3. Le serveur (compte de service) écrit lui-même
        gw/collab_invites/{targetUid}, via écriture conditionnelle ETag
        (mutateArrayAtPath) pour ne jamais écraser une invitation
        concurrente d'un tiers vers la même boîte.
   Phase 9D-bis : gw/projects/{userFbKey}.write est désormais scopé au
   propriétaire (auth.uid === $userFbKey, voir database.rules.json) — mais
   _acceptCollabInvite()/_declineCollabInvite() avaient légitimement besoin
   d'écrire UN SEUL champ (collaborators[].status) dans le projet du
   PROPRIÉTAIRE depuis le navigateur de l'INVITÉ. Firebase Rules ne peut
   pas exprimer "l'invité ne peut modifier que l'entrée collaborators
   correspondant à son propre email" sur un tableau réordonné côté client
   (mêmes limites structurelles que gw/collab_requests en 9D — pas d'index
   stable). D'où les actions 'accept'/'decline' ci-dessous : le serveur
   résout l'invitation RÉELLE depuis gw/collab_invites/{callerUid} (jamais
   projId/ownerEmail fournis par le client comme autorité), en déduit le
   VRAI propriétaire et le VRAI projet, puis modifie UNIQUEMENT l'entrée
   collaborators correspondant à l'appelant (ETag, mutateArrayAtPath).
═══════════════════════════════════════════════════════════════ */

const { dbGet, emailKey, mutateArrayAtPath, checkRateLimit } = require('./admin/_lib/fbrest');
const { verify: verifyRefreshToken } = require('./auth/_lib/refreshToken');

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

  /* Phase SYNC-55 : rate-limit fail-open — social/faible risque, une
     indisponibilite Firebase ne doit pas bloquer une invitation legitime. */
  var rl = await checkRateLimit('collab:invite:' + callerUid, 20, 60 * 60 * 1000);
  if (rl.ok === false) { res.status(429).json({ error: 'Trop d\'invitations recentes. Reessayez dans ' + rl.retryAfterSec + 's.' }); return; }
  /* rl.ok === null (indisponible) : fail-open, on continue normalement. */

  if (body.action === 'accept' || body.action === 'decline') {
    if (typeof body.inviteId !== 'string' || !body.inviteId || body.inviteId.length > 100) {
      res.status(400).json({ error: 'inviteId invalide' });
      return;
    }
    /* ── Preuve : résout l'invitation RÉELLE depuis la boîte de L'APPELANT
       lui-même (jamais un projId/ownerEmail fourni par le client) ── */
    var myInvites;
    try { myInvites = await dbGet('/gw/collab_invites/' + callerUid); }
    catch (e) { res.status(500).json({ error: 'Erreur serveur' }); return; }
    var invite = Array.isArray(myInvites) ? myInvites.find(function(i) { return i && i.id === body.inviteId; }) : null;
    if (!invite || !invite.ownerEmail || !invite.projId) {
      res.status(404).json({ error: 'Invitation introuvable' });
      return;
    }
    var ownerUid = emailKey(invite.ownerEmail);
    var projId = invite.projId;
    var mutOutcome = null;

    var r = await mutateArrayAtPath('/gw/projects/' + ownerUid, function(list) {
      var idx = list.findIndex(function(p) { return p && String(p.id) === String(projId); });
      if (idx === -1) { mutOutcome = 'project_gone'; return null; }
      var proj = list[idx];
      var collabs = Array.isArray(proj.collaborators) ? proj.collaborators.slice() : [];
      var cIdx = collabs.findIndex(function(c) { return c && c.email && c.email.toLowerCase() === callerEmail.toLowerCase(); });
      if (body.action === 'accept') {
        if (cIdx === -1) { mutOutcome = 'not_invited'; return null; }
        collabs[cIdx] = Object.assign({}, collabs[cIdx], { status: 'accepted' });
      } else {
        if (cIdx === -1) { mutOutcome = 'noop'; return null; }
        collabs = collabs.filter(function(c) { return !(c && c.email && c.email.toLowerCase() === callerEmail.toLowerCase()); });
      }
      var nextList = list.slice();
      nextList[idx] = Object.assign({}, proj, { collaborators: collabs });
      mutOutcome = 'ok';
      return nextList;
    });

    if (mutOutcome === 'project_gone') { res.status(404).json({ error: 'Projet introuvable' }); return; }
    if (mutOutcome === 'not_invited') { res.status(409).json({ error: 'Invitation déjà traitée ou incohérente' }); return; }
    if (mutOutcome === 'noop') { res.status(200).json({ ok: true, ownerEmail: invite.ownerEmail, projId: projId, projTitle: invite.projTitle }); return; }
    if (!r.ok) { res.status(500).json({ error: 'Échec de la mise à jour' }); return; }

    res.status(200).json({ ok: true, ownerEmail: invite.ownerEmail, projId: projId, projTitle: invite.projTitle });
    return;
  }

  if (body.action !== 'invite') {
    res.status(400).json({ error: 'Action inconnue' });
    return;
  }

  if (typeof body.toEmail !== 'string' || !body.toEmail.trim() || body.toEmail.length > 320 || body.toEmail.indexOf('@') === -1) {
    res.status(400).json({ error: 'Destinataire invalide' });
    return;
  }
  var toEmail = body.toEmail.trim().toLowerCase();
  if (toEmail === callerEmail.toLowerCase()) {
    res.status(400).json({ error: 'Impossible de s\'inviter soi-même' });
    return;
  }
  var targetUid = emailKey(toEmail);

  if (body.projId === undefined || body.projId === null || String(body.projId).length > 40) {
    res.status(400).json({ error: 'projId invalide' });
    return;
  }
  var ownerName = typeof body.ownerName === 'string' ? body.ownerName.slice(0, 100) : callerEmail;
  var ownerPhoto = typeof body.ownerPhoto === 'string' && body.ownerPhoto.length <= 500000 ? body.ownerPhoto : null;

  /* ── Preuve : le projet cité appartient RÉELLEMENT à l'appelant ── */
  var ownProjects, proj;
  try { ownProjects = await dbGet('/gw/projects/' + callerUid); }
  catch (e) { res.status(500).json({ error: 'Erreur serveur' }); return; }
  if (Array.isArray(ownProjects)) {
    proj = ownProjects.find(function(p) { return p && String(p.id) === String(body.projId); });
  }
  if (!proj) {
    res.status(403).json({ error: 'Projet introuvable ou non autorisé' });
    return;
  }

  var invite = {
    id: 'srv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    projId: proj.id,
    projTitle: proj.title,
    ownerEmail: callerEmail,
    ownerName: ownerName,
    ownerPhoto: ownerPhoto,
    at: Date.now(),
  };

  var result = await mutateArrayAtPath('/gw/collab_invites/' + targetUid, function(list) {
    /* Dédoublonnage : n'ajoute pas une 2e invitation en attente pour le même projet du même invitant */
    if (list.some(function(i) { return i && i.projId === proj.id && i.ownerEmail && i.ownerEmail.toLowerCase() === callerEmail.toLowerCase(); })) {
      return null;
    }
    list.unshift(invite);
    return list;
  });

  if (!result.ok && result.reason !== 'aborted') {
    res.status(500).json({ error: 'Échec de l\'envoi de l\'invitation' });
    return;
  }

  res.status(200).json({ ok: true, alreadyInvited: result.reason === 'aborted' });
};
