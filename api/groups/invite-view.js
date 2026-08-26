/* ═══════════════════════════════════════════════════════════════
   GENIWORK — POST /api/groups/invite-view (Phase GROUPS-FREE-07)

   Aperçu d'une invitation AVANT acceptation, pour un utilisateur qui
   n'est PAS encore membre du groupe (donc ne peut pas lire
   gw/group_msgs/{groupId}/meta directement — Rule .read exige déjà
   membre). Compte de service, lecture seule, ne modifie jamais rien.

   Ne renvoie jamais d'email (ni le sien, ni celui de l'inviteur) —
   uniquement le nom d'affichage public de l'inviteur
   (gw/profiles, .read:true, même résolution que _gwPublicName côté
   client), jamais gw/users ni le champ inviterEmail brut de l'invite.

   Body : { authRefreshToken, token }
   Réponse : { ok:true, status, groupName, description, memberCount,
               coverDataUri, inviterName } ou { ok:false, error }
═══════════════════════════════════════════════════════════════ */

const { dbGet, emailKey } = require('../admin/_lib/fbrest');
const { verify: verifyRefreshToken } = require('../auth/_lib/refreshToken');
const { gcsDownload } = require('./_lib/gcsrest');

function isValidToken(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(v);
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
      res.status(401).json({ ok: false, error: 'Connecte-toi pour voir cette invitation.' });
      return;
    }

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

    let effectiveStatus = invite.status;
    if (effectiveStatus === 'pending' && invite.createdAt && (Date.now() - invite.createdAt) > INVITE_TTL_MS) {
      effectiveStatus = 'expired';
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

    let inviterName = 'Utilisateur';
    try {
      const inviterProfile = await dbGet('/gw/profiles/' + (invite.inviterUid || emailKey(invite.inviterEmail || '')));
      if (inviterProfile && inviterProfile.nom) inviterName = inviterProfile.nom;
    } catch (e) { /* best-effort, garde le fallback */ }

    let coverDataUri = null;
    if (meta.coverPath) {
      try {
        const file = await gcsDownload(meta.coverPath);
        if (file) coverDataUri = 'data:' + file.contentType + ';base64,' + file.buffer.toString('base64');
      } catch (e) { /* aperçu sans couverture plutôt qu'une erreur bloquante */ }
    }

    const memberCount = meta.members ? Object.keys(meta.members).length : 0;

    res.status(200).json({
      ok: true,
      status: effectiveStatus,
      groupId: invite.groupId,
      groupName: meta.name || '',
      description: meta.description || '',
      memberCount: memberCount,
      coverDataUri: coverDataUri,
      inviterName: inviterName,
    });
  } catch (err) {
    console.error('[Geniwork Groupes] erreur invite-view:', err.message);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
};
