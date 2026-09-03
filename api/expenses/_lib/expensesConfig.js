/* ═══════════════════════════════════════════════════════════════
   AI-TOOL-32 : liste des categories du suivi des depenses — source
   unique (§5 : "La liste doit etre centralisee afin d'eviter des
   copies divergentes frontend/backend"). expenses.html importe cette
   meme liste via un GET (voir /api/expenses?meta=categories) plutot
   que de la dupliquer en dur cote client.

   Volontairement non-comptable (pas de plan comptable general) —
   comprehensible pour un freelance/TPE/PME (AI-TOOL-31 §9).
═══════════════════════════════════════════════════════════════ */

const EXPENSE_CATEGORIES = [
  'Logiciels / abonnements',
  'Transport',
  'Communication',
  'Marketing / publicité',
  'Fournitures',
  'Sous-traitance',
  'Locaux',
  'Frais bancaires',
  'Formation',
  'Autres',
];

module.exports = { EXPENSE_CATEGORIES };
