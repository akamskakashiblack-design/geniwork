/* ═══════════════════════════════════════════════════════════════
   Mémoire persistante V1 — lecture/fusion/écriture/suppression.

   Stockage : gw/ai_memory/{emailKey}/ — délibérément HORS de gw/profiles/
   (qui est .read:true public, voir database.rules.json ligne 13). Ce
   nœud n'a AUCUNE entrée dans database.rules.json, donc deny-by-default
   pour tout client Firebase (même pattern que gw/ai_secrets déjà en
   prod) — seul ce module y accède, via le compte de service (fbrest.js,
   déjà utilisé par chat.js pour le rate limit, donc déjà le canal
   éprouvé pour /api/ai/*).

   Schéma :
     gw/ai_memory/{emailKey}/
       global/
         enabled: true|false        (absent = true, opt-out)
         facts/{cle}: { value, source, toolId, updatedAt }
       tools/{toolId}/
         enabled: true|false        (absent = true, opt-out)
         facts/{cle}: { value, source, toolId, updatedAt }

   Isolation stricte : un outil ne lit/écrit jamais tools/{autreToolId} —
   structurellement impossible ici puisque chaque fonction prend un
   toolId unique et construit un chemin Firebase qui ne contient QUE ce
   toolId, jamais une lecture de tools/ entier.
═══════════════════════════════════════════════════════════════ */

const { dbGet, dbSet, dbRemove, emailKey, mutateObjectAtPath } = require('../../admin/_lib/fbrest');
const { GLOBAL_CATEGORIES, MEMORY_CONFIG } = require('./memoryConfig');

const MAX_FACT_VALUE_LEN = 200;
/* mutateObjectAtPath (lecture ETag → mutation → écriture conditionnelle,
   retry sur conflit 412) vit désormais dans admin/_lib/fbrest.js, à côté
   de son équivalent tableau mutateArrayAtPath — plus de copie locale ici
   (mission "Consommation + Coûts", qui en avait besoin aussi). */

function scopePath(key, scope, toolId) {
  return scope === 'global' ? '/gw/ai_memory/' + key + '/global' : '/gw/ai_memory/' + key + '/tools/' + toolId;
}

/* Lit l'état complet (toggles + facts) pour un outil donné, en une seule
   lecture du document — nécessaire à chat.js avant chaque appel LLM.
   Ne lève jamais : une erreur Firebase renvoie un état "indisponible"
   plutôt que de bloquer la génération (état "erreur Firebase", §14). */
async function readMemoryContext(email, toolId) {
  const key = emailKey(email);
  let doc;
  try { doc = (await dbGet('/gw/ai_memory/' + key)) || {}; } catch (e) { return null; }
  const global = doc.global || {};
  const toolNode = (doc.tools && doc.tools[toolId]) || {};
  const globalEnabled = global.enabled !== false;
  const toolEnabled = toolNode.enabled !== false;
  return {
    emailKeyValue: key,
    globalEnabled,
    toolEnabled,
    effectiveEnabled: globalEnabled && toolEnabled,
    globalFacts: global.facts || {},
    toolFacts: toolNode.facts || {},
  };
}

/* Lit le document complet pour l'endpoint GET /api/ai/memory (tous les
   outils capables, pas seulement celui en cours). */
async function readFullMemory(email) {
  const key = emailKey(email);
  const doc = (await dbGet('/gw/ai_memory/' + key)) || {};
  return { global: doc.global || {}, tools: doc.tools || {} };
}

/* Bloc court injecté dans le system prompt — jamais toute la mémoire :
   plafonné en nombre de faits ET en caractères (§10), les plus
   récemment mis à jour d'abord. Renvoie '' si rien à injecter (mémoire
   vide, §14) — aucune ligne "mémoire vide" n'est ajoutée au prompt,
   pour ne pas gaspiller de tokens sur un état négatif. */
const MAX_INJECTED_FACTS = 10;
const MAX_INJECTED_CHARS = 600;

function buildMemoryPromptBlock(globalFacts, toolFacts) {
  const entries = [];
  Object.entries(globalFacts || {}).forEach(([k, v]) => {
    if (v && v.value) entries.push({ k, v: v.value, t: v.updatedAt || 0, scope: 'global' });
  });
  Object.entries(toolFacts || {}).forEach(([k, v]) => {
    if (v && v.value) entries.push({ k, v: v.value, t: v.updatedAt || 0, scope: 'outil' });
  });
  if (!entries.length) return '';
  entries.sort((a, b) => b.t - a.t);
  const lines = [];
  let total = 0;
  for (const e of entries.slice(0, MAX_INJECTED_FACTS)) {
    const line = '- (' + e.scope + ') ' + e.k + ' : ' + e.v;
    if (total + line.length > MAX_INJECTED_CHARS) break;
    lines.push(line);
    total += line.length;
  }
  if (!lines.length) return '';
  return '\n\nCe que tu sais déjà sur cet utilisateur (mémoire, à utiliser sans le répéter mot pour mot sauf si pertinent) :\n' + lines.join('\n');
}

/* Instruction d'extraction — n'autorise QUE les catégories déclarées
   pour cet outil + les catégories globales communes (§5). Le modèle
   n'écrit rien s'il n'a rien de nouveau/changé à signaler. */
function buildMemorySystemNote(toolId) {
  const toolCategories = MEMORY_CONFIG[toolId] || [];
  return '\n\nMémoire : tu peux retenir des informations durables et utiles sur cet utilisateur, UNIQUEMENT dans ces catégories : '
    + 'global(' + GLOBAL_CATEGORIES.join(', ') + '), outil(' + toolCategories.join(', ') + '). '
    + 'Si une information nouvelle ou différente de ces catégories apparaît CLAIREMENT dans ce message (jamais devinée, jamais supposée), '
    + 'termine ta réponse par une ligne, seule sur sa ligne, EXACTEMENT sous cette forme (elle sera retirée avant affichage, n\'en parle jamais à l\'utilisateur) : '
    + '<!--MEMORY:{"global":{"cle":"valeur"},"tool":{"cle":"valeur"}}-->. '
    + 'N\'inclus QUE des clés listées ci-dessus, uniquement si vraiment nouvelles ou changées. Sinon n\'ajoute rien du tout.';
}

const MEMORY_BLOCK_RE = /\n?<!--MEMORY:([\s\S]*?)-->\s*$/;

/* Extrait le bloc mémoire caché en fin de réponse et le retire du texte
   AVANT tout traitement ultérieur (stripCodeFence/marked.parse) — il ne
   doit jamais atteindre l'utilisateur. Un JSON malformé est ignoré
   silencieusement (extracted:null) plutôt que de casser la réponse. */
function extractMemoryBlock(rawText) {
  const m = rawText.match(MEMORY_BLOCK_RE);
  if (!m) return { text: rawText, extracted: null };
  const text = rawText.slice(0, m.index).trimEnd();
  let extracted = null;
  try {
    const parsed = JSON.parse(m[1]);
    if (parsed && typeof parsed === 'object') extracted = parsed;
  } catch (e) { extracted = null; }
  return { text, extracted };
}

function filterAllowed(obj, allowedKeys) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (allowedKeys.includes(k) && typeof v === 'string' && v.trim()) {
      out[k] = v.trim().slice(0, MAX_FACT_VALUE_LEN);
    }
  }
  return out;
}

/* Fusionne (jamais n'accumule en doublon, §7) les faits extraits dans
   Firebase, avec provenance (§6) : value/source/toolId/updatedAt.
   Écriture ETag-safe (§8). N'écrit RIEN si rien de valide après filtrage
   (évite un round-trip Firebase inutile). */
async function writeExtractedFacts(email, toolId, extracted) {
  if (!extracted) return { ok: true, wrote: false };
  const key = emailKey(email);
  const toolAllowed = MEMORY_CONFIG[toolId] || [];
  const globalFiltered = filterAllowed(extracted.global, GLOBAL_CATEGORIES);
  const toolFiltered = filterAllowed(extracted.tool, toolAllowed);
  const now = Date.now();
  const jobs = [];

  if (Object.keys(globalFiltered).length) {
    jobs.push(mutateObjectAtPath('/gw/ai_memory/' + key + '/global/facts', (existing) => {
      const merged = Object.assign({}, existing);
      for (const [k, v] of Object.entries(globalFiltered)) {
        merged[k] = { value: v, source: 'auto', toolId, updatedAt: now };
      }
      return merged;
    }));
  }
  if (Object.keys(toolFiltered).length) {
    jobs.push(mutateObjectAtPath('/gw/ai_memory/' + key + '/tools/' + toolId + '/facts', (existing) => {
      const merged = Object.assign({}, existing);
      for (const [k, v] of Object.entries(toolFiltered)) {
        merged[k] = { value: v, source: 'auto', toolId, updatedAt: now };
      }
      return merged;
    }));
  }
  if (!jobs.length) return { ok: true, wrote: false };
  const results = await Promise.all(jobs);
  const failed = results.find((r) => !r.ok);
  if (failed) return { ok: false, reason: failed.reason };
  return { ok: true, wrote: true };
}

/* Toggle : un booléen isolé, pas un objet à fusionner — une écriture
   directe (dernier écrivain gagne) est déjà sûre ici (aucun risque de
   "lost update" partiel comme pour facts, qui a plusieurs clés
   indépendantes) ; ETag n'apporterait rien de plus pour une valeur
   scalaire unique. */
async function setToggle(email, scope, enabled) {
  const key = emailKey(email);
  const path = scopePath(key, scope === 'global' ? 'global' : 'tool', scope) + '/enabled';
  try {
    await dbSet(path, !!enabled);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'write_failed' };
  }
}

/* Suppression d'un souvenir précis (§ "supprimer un souvenir"). Chemin
   indépendant des autres clés du même objet facts → une suppression
   directe est sûre (pas de fusion concurrente à protéger ici, contraint
   au strict opposé de writeExtractedFacts qui DOIT fusionner). */
async function deleteFact(email, scope, factKey) {
  const key = emailKey(email);
  const path = scopePath(key, scope === 'global' ? 'global' : 'tool', scope) + '/facts/' + factKey;
  try {
    await dbRemove(path);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'write_failed' };
  }
}

module.exports = {
  readMemoryContext,
  readFullMemory,
  buildMemoryPromptBlock,
  buildMemorySystemNote,
  extractMemoryBlock,
  writeExtractedFacts,
  setToggle,
  deleteFact,
};
