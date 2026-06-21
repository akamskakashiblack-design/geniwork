/* ═══════════════════════════════════════════════════════════════
   GENIWORK Business AI — POST /api/ai/chat
   Body: { feature, email, messages }
   Verifie/deduit les credits (Firebase, plan reel de l'utilisateur),
   appelle Anthropic (texte) ou OpenAI (image), renvoie le resultat.
═══════════════════════════════════════════════════════════════ */

const { FEATURES } = require('./_lib/features');
const { getCreditState, consumeCredits } = require('./_lib/credits');
const { callLLMChat } = require('./_lib/llmClient');
const { generateImage } = require('./_lib/imageClient');
const { marked } = require('marked');

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
  const { feature, email, messages } = body;

  if (!email) { res.status(401).json({ error: 'Connecte-toi pour utiliser Business AI.' }); return; }
  if (!feature || !FEATURES[feature]) { res.status(400).json({ error: 'Fonctionnalite inconnue: ' + feature }); return; }
  if (!Array.isArray(messages) || !messages.length) { res.status(400).json({ error: 'messages manquant' }); return; }

  const f = FEATURES[feature];

  try {
    const state = await getCreditState(email);

    if (state.credits < f.creditCost) {
      res.status(200).json({
        error: 'Credits insuffisants (cout: ' + f.creditCost + ', restant: ' + state.credits + ').',
        creditState: state,
      });
      return;
    }

    if (feature === 'image') {
      const promptText = extractLastUserText(messages);
      const b64 = await generateImage({ prompt: promptText });
      const newState = await consumeCredits(email, f.creditCost, state);
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
    const newState = await consumeCredits(email, f.creditCost, state);

    let payload;
    if (f.outputType === 'html') {
      payload = { outputType: 'html', html: cleaned, assistantText: cleaned };
    } else if (f.outputType === 'json') {
      payload = { outputType: 'json', text: cleaned, assistantText: cleaned };
    } else {
      payload = { outputType: 'markdown', html: marked.parse(cleaned), assistantText: cleaned };
    }

    res.status(200).json(Object.assign(payload, { creditState: newState }));
  } catch (err) {
    console.error('[Geniwork AI] erreur:', err.message);
    res.status(500).json({ error: err.message });
  }
};
