/* ═══════════════════════════════════════════════════════════════
   Tarification réelle — jamais des chiffres inventés.

   Source : https://platform.claude.com/docs/en/about-claude/pricing
   Consultée le 2026-09-03. Modèle "claude-sonnet-4-6" = ligne "Claude
   Sonnet 4.6" de la table officielle : $3/MTok input, $15/MTok output.
   Recherche web : $10 pour 1000 recherches (indépendant du modèle).

   Image (gpt-image-1, OpenAI) : facturé au token par OpenAI (image
   input $10/MTok, image output $40/MTok — developers.openai.com/api/docs/pricing,
   consulté 2026-09-03) MAIS api/ai/_lib/imageClient.js ne capture pas
   encore `usage` depuis la réponse OpenAI. Tant que cette capture
   n'existe pas, calculer un coût par image serait deviner un nombre —
   interdit. `available:false` documente ce manque explicitement plutôt
   que de l'ignorer.
═══════════════════════════════════════════════════════════════ */

const PRICING = {
  text: {
    model: 'claude-sonnet-4-6',
    inputPerMTok: 3,
    outputPerMTok: 15,
    currency: 'USD',
    source: 'https://platform.claude.com/docs/en/about-claude/pricing',
    fetchedAt: '2026-09-03',
  },
  webSearch: {
    perThousandSearches: 10,
    currency: 'USD',
    source: 'https://platform.claude.com/docs/en/about-claude/pricing',
    fetchedAt: '2026-09-03',
  },
  image: {
    model: 'gpt-image-1',
    available: false,
    reason: 'usage (tokens) non capturé par imageClient.js — coût non calculable sans deviner un chiffre',
    inputPerMTok: 10,
    outputPerMTok: 40,
    currency: 'USD',
    source: 'https://developers.openai.com/api/docs/pricing',
    fetchedAt: '2026-09-03',
  },
};

/* Coût réel en USD pour un appel texte donné, à partir de tokens
   RÉELLEMENT mesurés (usage.input_tokens/output_tokens de la réponse
   Anthropic) — jamais une estimation à partir d'un texte. */
function computeTextCostUsd(inputTokens, outputTokens) {
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') return null;
  return (inputTokens / 1e6) * PRICING.text.inputPerMTok + (outputTokens / 1e6) * PRICING.text.outputPerMTok;
}

function computeWebSearchCostUsd(searchCount) {
  if (typeof searchCount !== 'number') return null;
  return (searchCount / 1000) * PRICING.webSearch.perThousandSearches;
}

module.exports = { PRICING, computeTextCostUsd, computeWebSearchCostUsd };
