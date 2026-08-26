/* ═══════════════════════════════════════════════════════════════
   GENIWORK — POST /api/groups/cover-view (Phase GROUPS-FREE-04 etape 2)

   Renvoie la couverture d'un groupe libre en data URI, uniquement si
   l'appelant est membre du groupe (owner/admin/membre simple —
   lecture seule pour ces deux derniers). Jamais d'URL Storage directe
   exposee : le chemin reste prive (storage.rules deny-all), seul cet
   endpoint (compte de service) peut lire l'objet.

   Body : { authRefreshToken, groupId }
   Reponse : { ok:true, dataUri: string|null, coverUpdatedAt } ou { ok:false, error }
═══════════════════════════════════════════════════════════════ */

const { verify: verifyRefreshToken } = require('../auth/_lib/refreshToken');
const { loadGroupRole, isValidGroupId } = require('./_lib/perm');
const { gcsDownload } = require('./_lib/gcsrest');

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
      res.status(401).json({ ok: false, error: 'Connecte-toi pour voir ce groupe.' });
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
    if (!role.isMember) {
      res.status(403).json({ ok: false, error: 'Reserve aux membres du groupe' });
      return;
    }

    if (!role.meta.coverPath) {
      res.status(200).json({ ok: true, dataUri: null, coverUpdatedAt: null });
      return;
    }

    let file;
    try { file = await gcsDownload(role.meta.coverPath); } catch (e) {
      console.error('[Groupe libre] Echec lecture cover Storage:', e.message);
      res.status(500).json({ ok: false, error: 'Erreur serveur' });
      return;
    }
    if (!file) {
      res.status(200).json({ ok: true, dataUri: null, coverUpdatedAt: null });
      return;
    }

    const dataUri = 'data:' + file.contentType + ';base64,' + file.buffer.toString('base64');
    res.status(200).json({ ok: true, dataUri, coverUpdatedAt: role.meta.coverUpdatedAt || null });
  } catch (err) {
    console.error('[Geniwork Groupes] erreur cover-view:', err.message);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
};
