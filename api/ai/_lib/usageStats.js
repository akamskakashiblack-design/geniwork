/* ═══════════════════════════════════════════════════════════════
   Mission "Consommation + Coûts + Logs" — collecte technique réelle.

   Deux écritures par appel IA (best-effort, jamais bloquantes — voir
   recordUsage) :

   1. gw/ai_usage_stats/{toolId}/{YYYY-MM} — compteurs agrégés (ETag,
      mutateObjectAtPath). Sert Dashboard/Consommation/Coûts.

   2. gw/ai_logs — tableau UNIQUE, plafonné à MAX_LOG_ENTRIES, le plus
      récent en tête (même pattern que gw/notifs, ETag, mutateArrayAtPath).
      Sert l'onglet Logs, avec pagination CÔTÉ ADMIN (le tableau entier
      tient largement en mémoire à cette taille, la "pagination" se fait
      en tranchant côté client — pas besoin d'un vrai curseur serveur
      pour ce volume).

   ⚠️ AUCUN champ ne contient jamais de texte utilisateur : ni le
   message envoyé, ni la réponse générée, ni un extrait de document, ni
   un souvenir mémoire. Uniquement des métadonnées techniques. Le
   validateur ci-dessous (ALLOWED_LOG_FIELDS) refuse silencieusement
   tout champ non prévu plutôt que de le stocker "au cas où".
═══════════════════════════════════════════════════════════════ */

const { mutateObjectAtPath, mutateArrayAtPath } = require('../../admin/_lib/fbrest');

const MAX_LOG_ENTRIES = 300;
const STATS_PATH_PREFIX = '/gw/ai_usage_stats/';
const LOGS_PATH = '/gw/ai_logs';

function currentMonthKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

/* Liste blanche stricte des champs de log — toute clé absente d'ici est
   ignorée, jamais stockée. C'est la garde technique derrière "ne jamais
   logger de contenu privé" : même une erreur de programmation future ne
   peut pas faire fuiter un champ texte libre non prévu. */
const ALLOWED_LOG_FIELDS = ['ts', 'requestId', 'toolId', 'model', 'status', 'durationMs', 'errorCode', 'webSearchUsed', 'creditsCost', 'inputTokens', 'outputTokens'];

function sanitizeLogEntry(entry) {
  const out = {};
  for (const k of ALLOWED_LOG_FIELDS) {
    if (entry[k] !== undefined) out[k] = entry[k];
  }
  return out;
}

/* Jamais throw — appelée en best-effort par chat.js, un échec de
   comptabilisation ne doit jamais transformer une génération réussie
   (ou même échouée proprement) en erreur 500 supplémentaire. */
async function recordUsage(entry) {
  try {
    const toolId = entry.toolId;
    if (!toolId) return { ok: false, reason: 'missing_toolId' };
    const success = entry.status === 'ok';
    const month = currentMonthKey();

    const statsJob = mutateObjectAtPath(STATS_PATH_PREFIX + toolId + '/' + month, (existing) => ({
      requests: (existing.requests || 0) + 1,
      errors: (existing.errors || 0) + (success ? 0 : 1),
      creditsSpent: (existing.creditsSpent || 0) + (success ? (entry.creditsCost || 0) : 0),
      creditsRefunded: (existing.creditsRefunded || 0) + (!success ? (entry.creditsCost || 0) : 0),
      webSearchRequests: (existing.webSearchRequests || 0) + (entry.webSearchRequests || 0),
      inputTokens: (existing.inputTokens || 0) + (entry.inputTokens || 0),
      outputTokens: (existing.outputTokens || 0) + (entry.outputTokens || 0),
      lastUpdatedAt: Date.now(),
    }));

    const logEntry = sanitizeLogEntry({
      ts: Date.now(),
      requestId: entry.requestId,
      toolId,
      model: entry.model || null,
      status: entry.status,
      durationMs: entry.durationMs != null ? entry.durationMs : null,
      errorCode: entry.errorCode || null,
      webSearchUsed: !!entry.webSearchUsed,
      creditsCost: entry.creditsCost || 0,
      inputTokens: entry.inputTokens != null ? entry.inputTokens : null,
      outputTokens: entry.outputTokens != null ? entry.outputTokens : null,
    });
    const logJob = mutateArrayAtPath(LOGS_PATH, (list) => {
      list.unshift(logEntry);
      return list.length > MAX_LOG_ENTRIES ? list.slice(0, MAX_LOG_ENTRIES) : list;
    });

    const [statsResult, logResult] = await Promise.all([statsJob, logJob]);
    return { ok: statsResult.ok && logResult.ok };
  } catch (e) {
    return { ok: false, reason: 'exception', message: e.message };
  }
}

module.exports = { recordUsage, currentMonthKey, MAX_LOG_ENTRIES };
