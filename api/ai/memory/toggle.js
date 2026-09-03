/* ═══════════════════════════════════════════════════════════════
   POST /api/ai/memory/toggle — active/désactive la mémoire, globale ou
   pour un outil précis. Body : { authRefreshToken, scope, enabled }.
   scope = "global" | un toolId de MEMORY_CAPABLE.

   Désactiver ne supprime rien (§11) : les faits déjà stockés restent en
   base jusqu'à suppression explicite via DELETE /api/ai/memory/:scope/:key
   — seuls la lecture et l'écriture sont coupées tant que c'est désactivé.
═══════════════════════════════════════════════════════════════ */

const { verify: verifyRefreshToken } = require('../../auth/_lib/refreshToken');
const { setToggle } = require('../_lib/memory');
const { MEMORY_CAPABLE } = require('../_lib/memoryConfig');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const body = req.body || {};
  const ticketData = verifyRefreshToken(body.authRefreshToken);
  if (!ticketData || !ticketData.email) {
    res.status(401).json({ error: 'Connecte-toi pour utiliser Business AI.' });
    return;
  }

  const { scope, enabled } = body;
  if (typeof enabled !== 'boolean') { res.status(400).json({ error: 'enabled invalide' }); return; }
  if (scope !== 'global' && !MEMORY_CAPABLE.includes(scope)) { res.status(400).json({ error: 'scope invalide' }); return; }

  try {
    const result = await setToggle(ticketData.email, scope, enabled);
    if (!result.ok) { res.status(500).json({ error: 'Echec de mise a jour' }); return; }
    res.status(200).json({ ok: true, scope, enabled });
  } catch (err) {
    console.error('[Geniwork AI] memoire toggle erreur:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};
