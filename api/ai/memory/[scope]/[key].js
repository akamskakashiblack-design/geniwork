/* ═══════════════════════════════════════════════════════════════
   DELETE /api/ai/memory/:scope/:key — supprime un souvenir précis.
   scope = "global" | un toolId de MEMORY_CAPABLE. authRefreshToken en
   query string (DELETE n'a pas de body côté fetch() par défaut côté
   client de cette page).

   ⚠️ Seule route de ce lot qui introduit un segment de route dynamique
   ([scope]/[key], convention Vercel standard) — le reste du dépôt
   utilise plutôt une réécriture vercel.json vers une query string
   (voir "/p/:id" → "/api/post?id=:id"). Comportement natif Vercel,
   aucune config supplémentaire requise, mais à vérifier au premier
   déploiement puisque rien de comparable n'existait déjà ici.
═══════════════════════════════════════════════════════════════ */

const { verify: verifyRefreshToken } = require('../../../auth/_lib/refreshToken');
const { deleteFact } = require('../../_lib/memory');
const { MEMORY_CAPABLE } = require('../../_lib/memoryConfig');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'DELETE') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const ticketData = verifyRefreshToken(req.query.authRefreshToken);
  if (!ticketData || !ticketData.email) {
    res.status(401).json({ error: 'Connecte-toi pour utiliser Business AI.' });
    return;
  }

  const { scope, key } = req.query;
  if (scope !== 'global' && !MEMORY_CAPABLE.includes(scope)) { res.status(400).json({ error: 'scope invalide' }); return; }
  if (!key || typeof key !== 'string') { res.status(400).json({ error: 'key invalide' }); return; }

  try {
    const result = await deleteFact(ticketData.email, scope, key);
    if (!result.ok) { res.status(500).json({ error: 'Echec de suppression' }); return; }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[Geniwork AI] memoire delete erreur:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};
