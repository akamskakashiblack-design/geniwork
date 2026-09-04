/* ═══════════════════════════════════════════════════════════════
   POST /api/admin/ai-agent-stats — lecture seule, réservé Super Admin.

   Source de vérité : gw/ai_usage_stats/{toolId}/{YYYY-MM} (compteurs
   agrégés, écrits par api/ai/_lib/usageStats.js à chaque appel IA) et
   gw/ai_logs (tableau plafonné des derniers événements techniques).

   Deux lectures Firebase au total (un GET sur chaque nœud) — jamais un
   scan par utilisateur, conformément à "ne pas scanner Firebase à
   chaque ouverture". Le coût est calculé ici (jamais stocké en dur) à
   partir de _lib/pricing.js, pour rester toujours cohérent avec la
   config de tarification actuelle.
═══════════════════════════════════════════════════════════════ */

const { verify: verifyAdminSession } = require('./_lib/session');
const { dbGet } = require('./_lib/fbrest');
const { PRICING, computeTextCostUsd, computeWebSearchCostUsd } = require('../ai/_lib/pricing');

function emptyToolAgg() {
  return { requests: 0, errors: 0, creditsSpent: 0, creditsRefunded: 0, webSearchRequests: 0, inputTokens: 0, outputTokens: 0 };
}
function addAgg(a, b) {
  a.requests += b.requests || 0;
  a.errors += b.errors || 0;
  a.creditsSpent += b.creditsSpent || 0;
  a.creditsRefunded += b.creditsRefunded || 0;
  a.webSearchRequests += b.webSearchRequests || 0;
  a.inputTokens += b.inputTokens || 0;
  a.outputTokens += b.outputTokens || 0;
  return a;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const body = req.body || {};
  const session = verifyAdminSession(body.token);
  if (!session) { res.status(401).json({ error: 'Session admin invalide ou expiree, reconnectez-vous.' }); return; }
  if (session.role !== 'Super Admin') { res.status(403).json({ error: 'Reserve au Super Admin.' }); return; }

  try {
    const [statsRoot, logs] = await Promise.all([
      dbGet('/gw/ai_usage_stats'),
      dbGet('/gw/ai_logs'),
    ]);

    /* statsRoot = { [toolId]: { [YYYY-MM]: {requests,errors,...} } } */
    const byTool = {};
    const byMonth = {};
    const totals = emptyToolAgg();
    if (statsRoot && typeof statsRoot === 'object') {
      Object.keys(statsRoot).forEach((toolId) => {
        const months = statsRoot[toolId] || {};
        byTool[toolId] = emptyToolAgg();
        Object.keys(months).forEach((monthKey) => {
          const m = months[monthKey] || {};
          addAgg(byTool[toolId], m);
          addAgg(totals, m);
          if (!byMonth[monthKey]) byMonth[monthKey] = emptyToolAgg();
          addAgg(byMonth[monthKey], m);
        });
      });
    }

    /* Coût calculé, jamais stocké : toujours cohérent avec la config de
       tarification actuelle (_lib/pricing.js), recalculé à la volée. */
    function withCost(agg) {
      return Object.assign({}, agg, {
        textCostUsd: computeTextCostUsd(agg.inputTokens, agg.outputTokens),
        webSearchCostUsd: computeWebSearchCostUsd(agg.webSearchRequests),
      });
    }
    Object.keys(byTool).forEach((k) => { byTool[k] = withCost(byTool[k]); });
    Object.keys(byMonth).forEach((k) => { byMonth[k] = withCost(byMonth[k]); });
    const totalsWithCost = withCost(totals);

    res.status(200).json({
      hasData: totals.requests > 0,
      totals: totalsWithCost,
      byTool,
      byMonth,
      logs: Array.isArray(logs) ? logs : [],
      pricing: PRICING,
    });
  } catch (err) {
    console.error('[Geniwork Admin] ai-agent-stats erreur:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};
