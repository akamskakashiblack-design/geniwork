/* ═══════════════════════════════════════════════════════════════
   Mode Recherche (§4) — quels outils y ont droit, et à quel coût.
   Extrait de chat.js (où c'était défini en local) pour que l'Admin
   AI Agent puisse afficher la config réelle sans dupliquer la liste
   à la main (source unique — api/admin/ai-agent.js importe ce même
   fichier, jamais une copie).
═══════════════════════════════════════════════════════════════ */

const SEARCH_CAPABLE = ['business-plan', 'bilan', 'budget', 'strategie', 'idees-projet', 'marketing', 'document', 'chat', 'tva', 'marche', 'concurrents'];
const WEB_SEARCH_SURCHARGE = 2;
const WEB_SEARCH_SYSTEM_NOTE = '\n\nMode recherche active : tu as acces a une recherche web reelle. Utilise-la pour toute information recente, chiffree, reglementaire ou specifique a une localisation. Distingue clairement faits verifies (avec leur source), estimations et recommandations. Ne cite jamais une source que tu n\'as pas reellement trouvee via la recherche.';

module.exports = { SEARCH_CAPABLE, WEB_SEARCH_SURCHARGE, WEB_SEARCH_SYSTEM_NOTE };
