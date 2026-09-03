/* ═══════════════════════════════════════════════════════════════
   GENIWORK Business AI — POST /api/ai/chat
   Body: { authRefreshToken, feature, messages }

   Phase AI-2 : l'identite de l'appelant vient EXCLUSIVEMENT de
   authRefreshToken (meme mecanisme deja utilise par tous les autres
   endpoints securises de ce depot — voir api/auth/_lib/refreshToken.js).
   Le client peut encore envoyer un champ "email" pour compatibilite
   descendante, mais il n'est plus jamais lu ni utilise comme preuve
   d'identite — seul ticketData.email (issu du jeton verifie) sert a
   lire/ecrire le profil et les credits.

   Phase AI-3 : le cout est reserve de maniere ATOMIQUE (ecriture
   conditionnelle ETag, voir _lib/credits.js) AVANT l'appel au
   fournisseur IA, jamais deduit apres coup — deux requetes concurrentes
   ne peuvent plus consommer/depasser le meme credit. Si le fournisseur
   echoue, le cout reserve est rembourse. Un rate limiting par
   utilisateur (meme mecanisme Firebase deja en place pour
   /api/auth/token, Phase 6) borne aussi le nombre d'appels reels
   possibles par minute, independamment du solde de credits.

   Verifie/reserve les credits (Firebase, plan reel de l'utilisateur),
   appelle Anthropic (texte) ou OpenAI (image), renvoie le resultat.
═══════════════════════════════════════════════════════════════ */

const { FEATURES } = require('./_lib/features');
const { getCreditState, reserveCredits, refundCredits } = require('./_lib/credits');
const { callLLMChat } = require('./_lib/llmClient');
const { generateImage } = require('./_lib/imageClient');
const { marked } = require('marked');
const { verify: verifyRefreshToken } = require('../auth/_lib/refreshToken');
const { dbGet, dbSet, emailKey } = require('../admin/_lib/fbrest');
const { MEMORY_CAPABLE } = require('./_lib/memoryConfig');
const { readMemoryContext, buildMemoryPromptBlock, buildMemorySystemNote, extractMemoryBlock, writeExtractedFacts } = require('./_lib/memory');
const { SEARCH_CAPABLE, WEB_SEARCH_SURCHARGE, WEB_SEARCH_SYSTEM_NOTE } = require('./_lib/webSearchConfig');
const { recordUsage } = require('./_lib/usageStats');
const crypto = require('crypto');

/* Phase AI-3 : rate limiting anti-abus — meme mecanisme deja en
   production pour api/auth/token.js/api/admin/login.js (stockage
   Firebase via le compte de service, partage entre toutes les
   instances Vercel). Fenetre fixe simple (comme le verrou de
   login_attempts) : le solde de credits reste la limite financiere
   stricte (verifiee de maniere atomique par reserveCredits), ce
   compteur borne seulement le DEBIT de requetes/minute, une petite
   marge de course sous forte concurrence est acceptable ici. */
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_MESSAGES = 30;
const MAX_PAYLOAD_CHARS = 60000;

/* SEARCH_CAPABLE / WEB_SEARCH_SURCHARGE / WEB_SEARCH_SYSTEM_NOTE : déplacés
   dans _lib/webSearchConfig.js (source unique, réutilisée par l'Admin AI
   Agent pour afficher la config réelle sans dupliquer cette liste). */

async function checkRateLimit(email) {
  const path = '/gw/ai_secrets/rate_limit/' + emailKey(email);
  const now = Date.now();
  const rec = (await dbGet(path)) || { windowStart: now, count: 0 };
  if (now - rec.windowStart > RATE_LIMIT_WINDOW_MS) {
    await dbSet(path, { windowStart: now, count: 1 });
    return { ok: true };
  }
  if (rec.count >= RATE_LIMIT_MAX) {
    const wait = Math.ceil((rec.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000);
    return { ok: false, wait };
  }
  await dbSet(path, { windowStart: rec.windowStart, count: rec.count + 1 });
  return { ok: true };
}

function stripCodeFence(text) {
  return text.replace(/^```[a-z]*\n/i, '').replace(/\n```$/, '');
}

function extractLastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      const content = messages[i].content;
      if (typeof content === 'string') return content;
      const textBlock = content.find((b) => b.type === 'text');
      return textBlock ? textBlock.text : '';
    }
  }
  return '';
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const body = req.body || {};
  const { feature, messages } = body;

  /* ── Identite : derivee UNIQUEMENT du jeton signe, jamais du champ
     "email" que le client peut encore envoyer (ignore comme autorite). ── */
  const ticketData = verifyRefreshToken(body.authRefreshToken);
  if (!ticketData || !ticketData.email) {
    res.status(401).json({ error: 'Connecte-toi pour utiliser Business AI.' });
    return;
  }
  const email = ticketData.email;

  if (!feature || !FEATURES[feature]) { res.status(400).json({ error: 'Fonctionnalite inconnue: ' + feature }); return; }
  if (!Array.isArray(messages) || !messages.length || messages.length > MAX_MESSAGES) {
    res.status(400).json({ error: 'messages invalide' });
    return;
  }
  if (JSON.stringify(messages).length > MAX_PAYLOAD_CHARS) {
    res.status(400).json({ error: 'Contenu trop volumineux' });
    return;
  }

  const f = FEATURES[feature];
  const useSearch = !!body.webSearch && SEARCH_CAPABLE.includes(feature);
  const cost = f.creditCost + (useSearch ? WEB_SEARCH_SURCHARGE : 0);

  try {
    const rate = await checkRateLimit(email);
    if (!rate.ok) {
      res.status(429).json({ error: 'Trop de requetes. Reessayez dans ' + rate.wait + 's.' });
      return;
    }

    const state = await getCreditState(email);

    if (state.credits < cost) {
      res.status(200).json({
        error: 'Credits insuffisants (cout: ' + cost + ', restant: ' + state.credits + ').',
        creditState: state,
      });
      return;
    }

    /* ── Reservation ATOMIQUE du cout AVANT tout appel fournisseur
       (Phase AI-3) — plus jamais "generer puis deduire". ── */
    const reservation = await reserveCredits(email, cost);
    if (!reservation.ok) {
      res.status(200).json({
        error: 'Credits insuffisants (cout: ' + cost + ', restant: ' + reservation.credits + ').',
        creditState: Object.assign({}, state, { credits: reservation.credits != null ? reservation.credits : state.credits }),
      });
      return;
    }
    const newState = Object.assign({}, state, { credits: reservation.credits });

    const requestId = crypto.randomUUID();
    const startedAt = Date.now();

    try {
      if (feature === 'image') {
        const promptText = extractLastUserText(messages);
        const b64 = await generateImage({ prompt: promptText });
        /* usage (tokens) non disponible ici — imageClient.js ne capture pas
           encore la reponse OpenAI, voir _lib/pricing.js pour le detail. */
        await recordUsage({
          requestId, toolId: feature, model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1',
          status: 'ok', durationMs: Date.now() - startedAt, creditsCost: cost,
          webSearchUsed: false, webSearchRequests: 0, inputTokens: null, outputTokens: null,
        }).catch(() => {});
        res.status(200).json({
          outputType: 'image',
          image: b64,
          assistantText: '[Image generee a partir de : ' + promptText + ']',
          creditState: newState,
        });
        return;
      }

      /* Mémoire persistante V1 : lecture jamais bloquante (échec Firebase →
         memoryCtx=null → mémoire simplement ignorée pour ce tour, la
         génération continue normalement). Le toggle global ET le toggle
         par outil doivent tous les deux être actifs (effectiveEnabled)
         pour lire OU écrire quoi que ce soit — §11. */
      const memoryCapable = MEMORY_CAPABLE.includes(feature);
      const memoryCtx = memoryCapable ? await readMemoryContext(email, feature).catch(() => null) : null;
      const memoryActive = !!(memoryCtx && memoryCtx.effectiveEnabled);

      let systemPrompt = f.systemPrompt;
      if (useSearch) systemPrompt += WEB_SEARCH_SYSTEM_NOTE;
      if (memoryActive) {
        systemPrompt += buildMemoryPromptBlock(memoryCtx.globalFacts, memoryCtx.toolFacts);
        systemPrompt += buildMemorySystemNote(feature);
      }

      const { text: rawWithMemory, sources, usage } = await callLLMChat({ systemPrompt, messages, maxTokens: f.maxTokens, webSearch: useSearch });

      /* Le bloc <!--MEMORY:{...}--> (s'il existe) est retiré AVANT tout
         traitement ultérieur — il ne doit jamais atteindre l'utilisateur
         ni être compté dans le HTML/JSON renvoyé. Écriture éventuelle
         best-effort : un échec ici (conflit ETag, Firebase indisponible)
         ne doit jamais transformer une génération réussie en erreur. */
      let raw = rawWithMemory;
      if (memoryActive) {
        const { text, extracted } = extractMemoryBlock(rawWithMemory);
        raw = text;
        if (extracted) {
          await writeExtractedFacts(email, feature, extracted).catch((e) => {
            console.error('[Geniwork AI] memoire: echec ecriture (non bloquant):', e.message);
          });
        }
      }
      const cleaned = stripCodeFence(raw.trim());

      let payload;
      if (f.outputType === 'html') {
        payload = { outputType: 'html', html: cleaned, assistantText: cleaned };
      } else if (f.outputType === 'json') {
        payload = { outputType: 'json', text: cleaned, assistantText: cleaned };
      } else {
        payload = { outputType: 'markdown', html: marked.parse(cleaned), assistantText: cleaned };
      }
      if (sources && sources.length) payload.sources = sources;

      await recordUsage({
        requestId, toolId: feature, model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
        status: 'ok', durationMs: Date.now() - startedAt, creditsCost: cost,
        webSearchUsed: useSearch, webSearchRequests: usage ? usage.webSearchRequests : 0,
        inputTokens: usage ? usage.inputTokens : null, outputTokens: usage ? usage.outputTokens : null,
      }).catch(() => {});

      res.status(200).json(Object.assign(payload, { creditState: newState }));
    } catch (genErr) {
      /* Generation echouee APRES reservation : rembourse (best-effort)
         pour ne jamais facturer un appel qui a echoue. */
      await refundCredits(email, cost);
      /* errorCode : code court et technique (jamais le message complet,
         qui pourrait a l'occasion contenir un fragment du payload) —
         voir usageStats.js, ALLOWED_LOG_FIELDS. */
      await recordUsage({
        requestId, toolId: feature, model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
        status: 'error', durationMs: Date.now() - startedAt, creditsCost: cost,
        webSearchUsed: useSearch, webSearchRequests: 0, inputTokens: null, outputTokens: null,
        errorCode: (genErr && genErr.message ? genErr.message : 'unknown').slice(0, 60),
      }).catch(() => {});
      throw genErr;
    }
  } catch (err) {
    console.error('[Geniwork AI] erreur:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};
