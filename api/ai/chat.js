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

  try {
    const rate = await checkRateLimit(email);
    if (!rate.ok) {
      res.status(429).json({ error: 'Trop de requetes. Reessayez dans ' + rate.wait + 's.' });
      return;
    }

    const state = await getCreditState(email);

    if (state.credits < f.creditCost) {
      res.status(200).json({
        error: 'Credits insuffisants (cout: ' + f.creditCost + ', restant: ' + state.credits + ').',
        creditState: state,
      });
      return;
    }

    /* ── Reservation ATOMIQUE du cout AVANT tout appel fournisseur
       (Phase AI-3) — plus jamais "generer puis deduire". ── */
    const reservation = await reserveCredits(email, f.creditCost);
    if (!reservation.ok) {
      res.status(200).json({
        error: 'Credits insuffisants (cout: ' + f.creditCost + ', restant: ' + reservation.credits + ').',
        creditState: Object.assign({}, state, { credits: reservation.credits != null ? reservation.credits : state.credits }),
      });
      return;
    }
    const newState = Object.assign({}, state, { credits: reservation.credits });

    try {
      if (feature === 'image') {
        const promptText = extractLastUserText(messages);
        const b64 = await generateImage({ prompt: promptText });
        res.status(200).json({
          outputType: 'image',
          image: b64,
          assistantText: '[Image generee a partir de : ' + promptText + ']',
          creditState: newState,
        });
        return;
      }

      const raw = await callLLMChat({ systemPrompt: f.systemPrompt, messages, maxTokens: f.maxTokens });
      const cleaned = stripCodeFence(raw.trim());

      let payload;
      if (f.outputType === 'html') {
        payload = { outputType: 'html', html: cleaned, assistantText: cleaned };
      } else if (f.outputType === 'json') {
        payload = { outputType: 'json', text: cleaned, assistantText: cleaned };
      } else {
        payload = { outputType: 'markdown', html: marked.parse(cleaned), assistantText: cleaned };
      }

      res.status(200).json(Object.assign(payload, { creditState: newState }));
    } catch (genErr) {
      /* Generation echouee APRES reservation : rembourse (best-effort)
         pour ne jamais facturer un appel qui a echoue. */
      await refundCredits(email, f.creditCost);
      throw genErr;
    }
  } catch (err) {
    console.error('[Geniwork AI] erreur:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};
