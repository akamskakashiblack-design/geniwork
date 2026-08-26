/* ═══════════════════════════════════════════════════════════════
   GENIWORK — POST /api/groups/invite-send (Phase GROUPS-FREE-07)

   "Partager dans Geniwork" — un membre quelconque (pas seulement
   owner/admin, voir §2 du mandat "invitation par les membres")
   invite un ou plusieurs contacts internes. Passe par le serveur
   UNIQUEMENT parce que la notification cross-utilisateur
   (gw/notifs/{cible}) est fermée à l'écriture client (voir
   _admApproveRecruiterVerif — même contrainte). La création du
   group_invites elle-même serait autorisée côté client (Rules
   membre-only déjà testées), mais est faite ici aussi pour garantir
   qu'une notification n'existe jamais sans invitation correspondante
   (même écriture serveur, cohérence garantie).

   Ne transmet jamais d'email dans la notification (fromUser.email
   volontairement laissé à null, voir _renderFreeGroupInfoBody /
   renderNotifs — seul le nom public est utilisé).

   Body : { authRefreshToken, groupId, targetEmails: string[] }
   Réponse : { ok:true, sent:string[], skipped:string[] } ou { ok:false, error }
═══════════════════════════════════════════════════════════════ */

const crypto = require('crypto');
const { dbGet, dbUpdate, emailKey, appendNotification } = require('../admin/_lib/fbrest');
const { verify: verifyRefreshToken } = require('../auth/_lib/refreshToken');

const MAX_TARGETS = 20;

function isValidGroupId(v) {
  return typeof v === 'string' && /^gw_grp_adhoc_[A-Za-z0-9_]{1,64}$/.test(v);
}
function isValidEmail(v) {
  return typeof v === 'string' && v.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}
function genToken() {
  return crypto.randomBytes(18).toString('base64url');
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
      res.status(401).json({ ok: false, error: 'Connecte-toi pour inviter.' });
      return;
    }
    const callerEmail = ticketData.email;
    const myUid = emailKey(callerEmail);

    if (!isValidGroupId(body.groupId)) {
      res.status(400).json({ ok: false, error: 'groupId invalide' });
      return;
    }

    const targetEmails = Array.isArray(body.targetEmails) ? body.targetEmails : [];
    const uniqueTargets = Array.from(new Set(targetEmails.filter(isValidEmail).map((e) => String(e))))
      .filter((e) => e.toLowerCase() !== callerEmail.toLowerCase())
      .slice(0, MAX_TARGETS);
    if (!uniqueTargets.length) {
      res.status(400).json({ ok: false, error: 'Aucun destinataire valide' });
      return;
    }

    let meta;
    try { meta = await dbGet('/gw/group_msgs/' + body.groupId + '/meta'); } catch (e) {
      res.status(500).json({ ok: false, error: 'Erreur serveur' });
      return;
    }
    if (!meta || !meta.isFreeGroup) {
      res.status(404).json({ ok: false, error: 'Groupe introuvable' });
      return;
    }
    if (!meta.members || meta.members[myUid] !== true) {
      res.status(403).json({ ok: false, error: 'Réservé aux membres du groupe' });
      return;
    }

    let inviterName = callerEmail.split('@')[0];
    try {
      const myProfile = await dbGet('/gw/profiles/' + myUid);
      if (myProfile && myProfile.nom) inviterName = myProfile.nom;
    } catch (e) { /* best-effort, garde le repli */ }

    const now = Date.now();
    const patch = {};
    const invitations = []; // { targetEmail, targetUid, token }
    const skipped = [];

    for (const targetEmail of uniqueTargets) {
      const targetUid = emailKey(targetEmail);
      if (meta.members[targetUid] === true) { skipped.push(targetEmail); continue; }
      const token = genToken();
      patch['gw/group_invites/' + token] = {
        groupId: body.groupId, inviterUid: myUid, inviterEmail: callerEmail, status: 'pending', createdAt: now,
      };
      invitations.push({ targetEmail, targetUid, token });
      /* group_inboxes/notifs restent en dehors du patch atomique : appendNotification
         gère son propre cycle lecture-ETag-réécriture (protégé contre les écritures
         concurrentes sur la même boîte, voir mutateArrayAtPath), incompatible avec un
         simple PATCH multi-chemin classique. */
    }

    if (Object.keys(patch).length) {
      try { await dbUpdate('/', patch); } catch (e) {
        console.error('[Groupe libre] Échec écriture invitations:', e.message);
        res.status(500).json({ ok: false, error: 'Erreur serveur' });
        return;
      }
    }

    await Promise.all(invitations.map((inv) => appendNotification(inv.targetUid, {
      id: 'grpinv_' + inv.token, unread: true, at: now, type: 'group_invite',
      fromUser: { email: null, nom: inviterName },
      msg: inviterName + ' vous a invité à rejoindre le groupe « ' + (meta.name || 'Groupe') + ' »',
      inviteToken: inv.token,
    }, (n) => n.type === 'group_invite' && n.fromUser && n.fromUser.nom === inviterName && n.msg && n.msg.indexOf(meta.name || '') !== -1).catch(() => false)));

    res.status(200).json({ ok: true, sent: invitations.map((inv) => inv.targetEmail), skipped });
  } catch (err) {
    console.error('[Geniwork Groupes] erreur invite-send:', err.message);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
};
