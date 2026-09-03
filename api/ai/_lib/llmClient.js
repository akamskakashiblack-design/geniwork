const https = require('https');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

/* SYNC-161 (B1) : aucun timeout HTTP n'existait jusqu'ici sur cet appel — un
   provider qui ne répond jamais ni ne coupe la connexion bloquait la Promise
   indéfiniment côté application (voir rapport SYNC-160). 25s est un compromis
   volontairement documenté : assez large pour la plus grosse génération texte
   du catalogue de features (mini-site, 4000 tokens, HTML), assez court pour
   échouer proprement bien avant une limite de plateforme usuelle, transformant
   un blocage silencieux en erreur explicite capturée par chat.js. */
const LLM_TIMEOUT_MS = 25000;

/* Mode Recherche : une recherche longue peut renvoyer stop_reason:"pause_turn"
   (voir doc Anthropic web_search) — il faut renvoyer le tour de l'assistant
   tel quel pour que l'API poursuive. Plafonné pour ne jamais boucler
   indéfiniment (et donc ne jamais facturer des recherches sans fin). */
const MAX_SEARCH_TURNS = 4;

/* Extrait les sources (titre + URL) des blocs "web_search_tool_result" d'une
   réponse Anthropic — présents uniquement quand l'outil web_search a été
   utilisé. Dédupliqué par URL, jamais fabriqué : une source ici correspond
   toujours à un résultat de recherche réellement retourné par Anthropic. */
function extractSources(contentBlocks) {
  const sources = [];
  const seen = new Set();
  for (const block of contentBlocks) {
    if (block.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue;
    for (const item of block.content) {
      if (item.type === 'web_search_result' && item.url && !seen.has(item.url)) {
        seen.add(item.url);
        sources.push({ title: item.title || item.url, url: item.url });
      }
    }
  }
  return sources;
}

function requestOnce(payload, apiKey) {
  return new Promise((resolve, reject) => {
    /* SYNC-161 : garde anti double résolution — timeout, erreur réseau et
       réponse peuvent chacun déclencher leur propre chemin ; une seule issue
       doit jamais atteindre resolve()/reject() plus d'une fois. */
    let settled = false;
    const finish = (fn, arg) => { if (settled) return; settled = true; fn(arg); };

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (resp) => {
      let data = '';
      resp.on('data', (c) => (data += c));
      resp.on('error', (e) => finish(reject, e));
      resp.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (resp.statusCode >= 200 && resp.statusCode < 300) {
            finish(resolve, json);
          } else {
            finish(reject, new Error('Anthropic ' + resp.statusCode + ': ' + (json.error ? json.error.message : data)));
          }
        } catch (e) { finish(reject, e); }
      });
    });
    req.on('error', (e) => finish(reject, e));
    /* SYNC-161 (B1) : timer d'inactivité socket — ne s'arme qu'après connexion,
       se réinitialise à chaque octet échangé (comportement natif Node), donc ne
       coupe pas une génération longue tant que des données circulent encore. */
    req.setTimeout(LLM_TIMEOUT_MS, () => {
      finish(reject, new Error('Anthropic : timeout après ' + LLM_TIMEOUT_MS + 'ms'));
      req.destroy();
    });
    req.write(payload);
    req.end();
  });
}

async function callLLMChat({ systemPrompt, messages, maxTokens, webSearch }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY non configuree dans Vercel');

  const tools = webSearch ? [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }] : undefined;
  let convo = messages;
  let allText = '';
  const seenUrls = new Set();
  const allSources = [];
  /* Mission "Consommation + Coûts" : tokens/recherches RÉELLEMENT mesurés,
     sommés sur tous les tours (un pause_turn = plusieurs appels API pour
     une seule requête utilisateur — le coût réel est la somme des tours,
     jamais juste le dernier). */
  let inputTokens = 0;
  let outputTokens = 0;
  let webSearchRequests = 0;

  for (let turn = 0; turn < MAX_SEARCH_TURNS; turn++) {
    const payload = JSON.stringify(Object.assign({
      model: MODEL,
      max_tokens: maxTokens || 2000,
      system: systemPrompt,
      messages: convo,
    }, tools ? { tools } : {}));

    const json = await requestOnce(payload, apiKey);
    const blocks = json.content || [];
    const turnText = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (turnText) allText += (allText ? '\n' : '') + turnText;
    if (webSearch) {
      for (const s of extractSources(blocks)) {
        if (!seenUrls.has(s.url)) { seenUrls.add(s.url); allSources.push(s); }
      }
    }
    if (json.usage) {
      if (typeof json.usage.input_tokens === 'number') inputTokens += json.usage.input_tokens;
      if (typeof json.usage.output_tokens === 'number') outputTokens += json.usage.output_tokens;
      if (json.usage.server_tool_use && typeof json.usage.server_tool_use.web_search_requests === 'number') {
        webSearchRequests += json.usage.server_tool_use.web_search_requests;
      }
    }

    if (json.stop_reason === 'pause_turn' && webSearch && turn < MAX_SEARCH_TURNS - 1) {
      /* Renvoyer le tour de l'assistant tel quel (encrypted_content inclus)
         pour que l'API reprenne la recherche là où elle s'est arrêtée. */
      convo = convo.concat([{ role: 'assistant', content: blocks }]);
      continue;
    }
    break;
  }

  /* SYNC-161 (B2) : une réponse "succès" sans contenu texte exploitable ne
     doit jamais être facturée comme une génération réussie. */
  if (!allText || !allText.trim()) {
    throw new Error('Anthropic : réponse vide, aucun contenu exploitable');
  }
  return { text: allText, sources: allSources, usage: { inputTokens, outputTokens, webSearchRequests } };
}

module.exports = { callLLMChat };
