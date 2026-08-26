/* ═══════════════════════════════════════════════════════════════
   GENIWORK — POST /api/groups/invite-accept (Phase GROUPS-FREE-07)

   Seul point d'entrée capable de faire passer une invitation
   group_invites/{token} à status="accepted" (les Rules RTDB
   n'autorisent le client qu'à la faire passer à "declined" ou
   "revoked" — jamais "accepted", réservé au compte de service).

   Vérifie : token existant, status==="pending", non expiré (7 jours
   depuis createdAt), groupe cible toujours un groupe libre existant.
   Écrit ensuite en UNE seule opération atomique multi-chemin (PATCH
   sur la racine) : meta/members/{uid}=true, meta/memberEmails,
   status=accepted+acceptedBy+acceptedAt, et l'entrée group_inboxes
   du nouveau membre (même charge utile que _writeFreeGroupInbox
   côté client, pour que son app découvre le groupe au prochain
   listener/poll sans rien inventer de nouveau).

   Body : { authRefreshToken, token }
   Réponse : { ok:true, groupId } ou { ok:false, error }
═══════════════════════════════════════════════════════════════ */

const { dbGet, dbUpdate, emailKey } = require('../admin/_lib/fbrest');
const { verify: verifyRefreshToken } = require('../auth/_lib/refreshToken');

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function isValidToken(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(v);
}

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
      res.status(401).json({ ok: false, error: 'Connecte-toi pour rejoindre ce groupe.' });
      return;
    }
    const callerEmail = ticketData.email;
    const myUid = emailKey(callerEmail);

    if (!isValidToken(body.token)) {
      res.status(400).json({ ok: false, error: 'Invitation invalide' });
      return;
    }

    let invite;
    try { invite = await dbGet('/gw/group_invites/' + body.token); } catch (e) {
      res.status(500).json({ ok: false, error: 'Erreur serveur' });
      return;
    }
    if (!invite || !invite.groupId) {
      res.status(404).json({ ok: false, error: 'Invitation introuvable' });
      return;
    }
    if (invite.status === 'accepted') {
      res.status(200).json({ ok: true, groupId: invite.groupId, alreadyMember: true });
      return;
    }
    if (invite.status !== 'pending') {
      res.status(410).json({ ok: false, error: invite.status === 'declined' ? 'Invitation refusée' : 'Invitation révoquée' });
      return;
    }
    if (!invite.createdAt || (Date.now() - invite.createdAt) > INVITE_TTL_MS) {
      res.status(410).json({ ok: false, error: 'Invitation expirée' });
      return;
    }

    let meta;
    try { meta = await dbGet('/gw/group_msgs/' + invite.groupId + '/meta'); } catch (e) {
      res.status(500).json({ ok: false, error: 'Erreur serveur' });
      return;
    }
    if (!meta || !meta.isFreeGroup) {
      res.status(404).json({ ok: false, error: 'Groupe introuvable' });
      return;
    }
    if (meta.members && meta.members[myUid] === true) {
      /* Déjà membre (ajouté directement entre-temps, ou double-acceptation) —
         on referme proprement l'invitation sans erreur bloquante. */
      const patchAlready = {};
      patchAlready['gw/group_invites/' + body.token + '/status'] = 'accepted';
      patchAlready['gw/group_invites/' + body.token + '/acceptedBy'] = myUid;
      patchAlready['gw/group_invites/' + body.token + '/acceptedAt'] = Date.now();
      try { await dbUpdate('/', patchAlready); } catch (e) { /* best-effort */ }
      res.status(200).json({ ok: true, groupId: invite.groupId, alreadyMember: true });
      return;
    }

    const now = Date.now();
    const patch = {};
    patch['gw/group_msgs/' + invite.groupId + '/meta/members/' + myUid] = true;
    patch['gw/group_msgs/' + invite.groupId + '/meta/memberEmails/' + myUid] = callerEmail;
    patch['gw/group_invites/' + body.token + '/status'] = 'accepted';
    patch['gw/group_invites/' + body.token + '/acceptedBy'] = myUid;
    patch['gw/group_invites/' + body.token + '/acceptedAt'] = now;
    patch['gw/group_inboxes/free_' + myUid + '/' + invite.groupId] = {
      groupId: invite.groupId, name: meta.name, ownerEmail: meta.ownerEmail, createdAt: meta.createdAt,
    };

    try { await dbUpdate('/', patch); } catch (e) {
      console.error('[Groupe libre] Échec écriture acceptation invitation:', e.message);
      res.status(500).json({ ok: false, error: 'Erreur serveur' });
      return;
    }

    res.status(200).json({ ok: true, groupId: invite.groupId });
  } catch (err) {
    console.error('[Geniwork Groupes] erreur invite-accept:', err.message);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
};
