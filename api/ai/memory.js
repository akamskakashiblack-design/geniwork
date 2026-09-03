/* ═══════════════════════════════════════════════════════════════
   GET /api/ai/memory — liste la mémoire complète de l'utilisateur
   (tous les outils capables), pour l'écran de contrôle mémoire.

   Identité EXCLUSIVEMENT dérivée du authRefreshToken vérifié — jamais
   un email/uid pris dans la query (même garde que /api/ai/status et
   /api/ai/chat).
═══════════════════════════════════════════════════════════════ */

const { verify: verifyRefreshToken } = require('../auth/_lib/refreshToken');
const { readFullMemory } = require('./_lib/memory');
const { MEMORY_CAPABLE, MEMORY_CONFIG, GLOBAL_CATEGORIES } = require('./_lib/memoryConfig');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const ticketData = verifyRefreshToken(req.query.authRefreshToken);
  if (!ticketData || !ticketData.email) {
    res.status(401).json({ error: 'Connecte-toi pour utiliser Business AI.' });
    return;
  }

  try {
    const doc = await readFullMemory(ticketData.email);
    const tools = {};
    for (const toolId of MEMORY_CAPABLE) {
      const node = doc.tools[toolId] || {};
      tools[toolId] = {
        enabled: node.enabled !== false,
        facts: node.facts || {},
        categories: MEMORY_CONFIG[toolId],
      };
    }
    res.status(200).json({
      global: { enabled: doc.global.enabled !== false, facts: doc.global.facts || {}, categories: GLOBAL_CATEGORIES },
      tools,
    });
  } catch (err) {
    console.error('[Geniwork AI] memoire GET erreur:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};
