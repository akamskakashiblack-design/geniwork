/* ═══════════════════════════════════════════════════════════════
   Mémoire persistante V1 — catégories autorisées, par portée.

   Un outil ne peut JAMAIS faire mémoriser une clé hors de cette liste :
   l'extraction produite par le modèle est filtrée contre ce schéma avant
   toute écriture (voir _lib/memory.js, filterAllowed()) — jamais fait
   confiance telle quelle, même si le modèle "invente" une clé plausible.

   MEMORY_CAPABLE = uniquement les outils en sortie markdown (texte libre
   conversationnel). Volontairement exclus : devis-facture/matching/
   moderation/feed (JSON strict — une instruction d'extraction en plus
   risquerait de casser le format attendu), mini-site (HTML), image
   (n'appelle pas ce client texte).
═══════════════════════════════════════════════════════════════ */

const GLOBAL_CATEGORIES = ['pays', 'ville', 'devise', 'secteur_activite', 'nom_entreprise', 'langue'];

const MEMORY_CONFIG = {
  'business-plan': ['secteur', 'cible', 'modele_economique', 'objectifs', 'budget_depart'],
  'bilan': ['devise_comptable', 'periode_habituelle', 'structure_comptable'],
  'budget': ['devise_comptable', 'postes_recurrents'],
  'strategie': ['objectif_principal', 'contraintes'],
  'idees-projet': ['competences', 'budget_disponible'],
  'marketing': ['cible_marketing', 'canaux_preferes', 'budget_marketing'],
  'document': ['type_documents_frequents'],
  'chat': ['sujets_recurrents'],
  /* AI-TOOL-03 : une seule categorie, volontairement restreinte a une
     caracteristique STABLE de l'entreprise (son propre regime fiscal
     declare, ex. "auto-entrepreneur"/"reel simplifie") — jamais un taux,
     un seuil ou une regle reglementaire, qui sont par nature temporaires
     et ne doivent jamais etre memorises comme un fait permanent (§7 de
     la mission). Le pays reste couvert par la categorie globale "pays"
     (GLOBAL_CATEGORIES), commune a tous les outils memory-capable. */
  'tva': ['regime_fiscal'],
  /* AI-TOOL-04 : une seule categorie, volontairement restreinte a une
     preference stable et non identifiante (le ton d'ecriture prefere,
     ex. "cordial"/"formel") — option A de la matrice de validation,
     pas de categorie "signature" (nom/titre) pour rester conservateur
     sur les donnees memorisees. */
  'email': ['ton_prefere'],
};

const MEMORY_CAPABLE = Object.keys(MEMORY_CONFIG);

module.exports = { GLOBAL_CATEGORIES, MEMORY_CONFIG, MEMORY_CAPABLE };
