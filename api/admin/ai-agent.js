/* ═══════════════════════════════════════════════════════════════
   POST /api/admin/ai-agent — lecture seule, réservé Super Admin.

   Agrège la CONFIGURATION RÉELLE du module IA (catalogue d'outils,
   modèles, catégories mémoire, éligibilité recherche web) à partir des
   sources de vérité existantes (_lib/features.js, _lib/memoryConfig.js,
   _lib/webSearchConfig.js, variables d'environnement modèle) — jamais
   une copie à la main qui pourrait diverger.

   ⚠️ Ne renvoie AUCUNE statistique d'usage (requêtes, coûts, erreurs,
   consommation) : aucun système d'agrégation de ces données n'existe
   encore dans ce dépôt. Les sections correspondantes du panel Admin
   AI Agent affichent "Données indisponibles" plutôt que d'inventer un
   chiffre — voir mission "Intégration Admin AI Agent".

   ⚠️ Ne renvoie JAMAIS le contenu privé de la mémoire d'un utilisateur
   (gw/ai_memory/{emailKey}/.../facts) — uniquement la configuration
   (catégories autorisées), qui est commune à tous les utilisateurs et
   ne contient aucune donnée personnelle.
═══════════════════════════════════════════════════════════════ */

const { verify: verifyAdminSession } = require('./_lib/session');
const { FEATURES } = require('../ai/_lib/features');
const { GLOBAL_CATEGORIES, MEMORY_CONFIG, MEMORY_CAPABLE } = require('../ai/_lib/memoryConfig');
const { SEARCH_CAPABLE, WEB_SEARCH_SURCHARGE } = require('../ai/_lib/webSearchConfig');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const body = req.body || {};
  const session = verifyAdminSession(body.token);
  if (!session) {
    res.status(401).json({ error: 'Session admin invalide ou expiree, reconnectez-vous.' });
    return;
  }
  if (session.role !== 'Super Admin') {
    res.status(403).json({ error: 'Reserve au Super Admin.' });
    return;
  }

  try {
    const models = {
      text: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
      image: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1',
    };

    const tools = Object.keys(FEATURES).map((id) => {
      const f = FEATURES[id];
      return {
        id,
        label: f.label,
        description: f.description,
        icon: f.icon,
        group: f.group,
        outputType: f.outputType,
        creditCost: f.creditCost,
        maxTokens: f.maxTokens,
        systemPrompt: f.systemPrompt || null,
        memoryCapable: MEMORY_CAPABLE.includes(id),
        memoryCategories: MEMORY_CONFIG[id] || [],
        webSearchCapable: SEARCH_CAPABLE.includes(id),
        /* model : dérivé, pas une 2e config — le seul aiguillage réel est
           "image" → client OpenAI (imageClient.js), tout le reste → client
           Anthropic (llmClient.js). status : toute clé présente dans
           FEATURES est par construction un outil actif — il n'existe pas
           (encore) de flag désactivé/brouillon dans ce fichier. */
        model: id === 'image' ? models.image : models.text,
        status: 'active',
      };
    });

    res.status(200).json({
      tools,
      webSearch: { surcharge: WEB_SEARCH_SURCHARGE, capableToolIds: SEARCH_CAPABLE },
      memory: { globalCategories: GLOBAL_CATEGORIES, capableToolIds: MEMORY_CAPABLE },
      models,
    });
  } catch (err) {
    console.error('[Geniwork Admin] ai-agent erreur:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};
