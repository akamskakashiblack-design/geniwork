/* ═══════════════════════════════════════════════════════════════
   GENIWORK — POST /api/groups/cover-delete (Phase GROUPS-FREE-04 etape 2)

   Supprime la couverture d'un groupe libre. Reserve au proprietaire
   et aux administrateurs (voir cover-upload.js). Idempotent : appeler
   sans couverture existante renvoie ok:true sans effet.

   Body : { authRefreshToken, groupId }
   Reponse : { ok:true } ou { ok:false, error }
═══════════════════════════════════════════════════════════════ */

const { dbRemove } = require('../admin/_lib/fbrest');
const { verify: verifyRefreshToken } = require('../auth/_lib/refreshToken');
const { loadGroupRole, isValidGroupId } = require('./_lib/perm');
const { gcsDelete } = require('./_lib/gcsrest');

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

    if (!isValidGroupId(body.groupId)) {
      res.status(400).json({ ok: false, error: 'groupId invalide' });
      return;
    }

    let role;
    try { role = await loadGroupRole(body.groupId, callerEmail); } catch (e) {
      res.status(500).json({ ok: false, error: 'Erreur serveur' });
      return;
    }
    if (!role) { res.status(404).json({ ok: false, error: 'Groupe introuvable' }); return; }
    if (!role.isMember || (!role.isOwner && !role.isAdmin)) {
      res.status(403).json({ ok: false, error: 'Seul le proprietaire ou un administrateur peut supprimer la couverture' });
      return;
    }

    if (!role.meta.coverPath) {
      res.status(200).json({ ok: true, alreadyEmpty: true });
      return;
    }

    try { await gcsDelete(role.meta.coverPath); } catch (e) {
      console.error('[Groupe libre] Echec suppression cover Storage:', e.message);
      res.status(500).json({ ok: false, error: 'Echec de la suppression' });
      return;
    }

    await dbRemove('/gw/group_msgs/' + body.groupId + '/meta/coverPath');
    await dbRemove('/gw/group_msgs/' + body.groupId + '/meta/coverUpdatedAt');

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[Geniwork Groupes] erreur cover-delete:', err.message);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
};
