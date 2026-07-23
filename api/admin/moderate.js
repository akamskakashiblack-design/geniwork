/* ═══════════════════════════════════════════════════════════════
   GENIWORK — POST /api/admin/moderate
   Ecritures globales reservees aux admins (bannissements, config des
   plans/support, logo officiel, activation du module Emploi).
   Avant : le client ecrivait directement ces noeuds Firebase, lisibles
   ET modifiables par n'importe quel visiteur (session anonyme).
   Body: { token, action, ...donnees selon l'action }
   Actions : setBans, setPlansConfig, setSupportConfig, setSettingsLogo,
             setJobsEnabled
═══════════════════════════════════════════════════════════════ */

const { dbSet } = require('./_lib/fbrest');
const { verify } = require('./_lib/session');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const body = req.body || {};
    const session = verify(body.token);
    if (!session) { res.status(401).json({ error: 'Session admin invalide ou expiree, reconnectez-vous.' }); return; }

    const action = body.action;

    if (action === 'setBans') {
      await dbSet('/gw/bans', Array.isArray(body.bans) ? body.bans : []);
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'setPlansConfig') {
      await dbSet('/gw/plans_config', body.config || {});
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'setSupportConfig') {
      await dbSet('/gw/support_config', body.config || {});
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'setSettingsLogo') {
      await dbSet('/gw/settings_logo', body.data || null);
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'setJobsEnabled') {
      await dbSet('/gw/settings_jobs_enabled', body.enabled ? 1 : 0);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ error: 'Action inconnue: ' + action });
  } catch (err) {
    console.error('[Geniwork Admin] erreur moderate:', err.message);
    res.status(500).json({ error: err.message });
  }
};
