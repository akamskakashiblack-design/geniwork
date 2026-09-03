/* ═══════════════════════════════════════════════════════════════
   AI-TOOL-32 — /api/expenses : CRUD du suivi des depenses professionnelles.

   Fonctionnalite applicative persistante, PAS un outil conversationnel
   IA : n'utilise ni FEATURES/CATALOG, ni chat.js, ni credits.js, ni
   ai_memory. Les 4 verbes (GET liste+filtres+totaux, POST creation,
   PATCH modification, DELETE suppression) sont regroupes dans UN
   seul fichier, expenseId adresse en query string plutot qu'en
   segment de route dynamique — le reste du depot utilise une
   reecriture vercel.json vers une query string pour ce type
   d'identifiant (voir "/p/:id" -> "/api/post?id=:id"); la seule
   exception existante (api/ai/memory/[scope]/[key].js) porte elle-
   meme un commentaire signalant ce pattern comme non re-verifie au
   premier deploiement — rester sur la convention dominante et
   verifiable localement plutot que d'ajouter un deuxieme cas
   d'un pattern deja marque incertain (AI-TOOL-32 §2.8/§6).

   Stockage : /gw/expenses/{emailKey}/{expenseId}/ — meme patron que
   /gw/ai_memory/{emailKey}/ (AI-TOOL-31 §5) : AUCUNE entree dans
   database.rules.json (deny-by-default pour tout client Firebase),
   acces exclusif via le compte de service (admin/_lib/fbrest.js).
   Un enfant par expenseId (pas un tableau mute) : chaque creation/
   modification/suppression est une ecriture directe sur son propre
   chemin, jamais une lecture-modification-reecriture de toute la
   collection (AI-TOOL-31 §5, justification detaillee).

   Identite TOUJOURS derivee de authRefreshToken verifie cote serveur
   (verify() de auth/_lib/refreshToken, mecanisme d'auth standard de
   toute l'app — 41 routes l'utilisent deja) -> emailKey(). Jamais un
   email/uid/emailKey/chemin fourni par le client (AI-TOOL-32 §7).

   L'IA n'est jamais la source de verite : tous les calculs (totaux,
   regroupement par categorie) sont du JavaScript deterministe,
   aucun appel LLM, aucun cout en credits (AI-TOOL-32 §10/§17).
═══════════════════════════════════════════════════════════════ */

const crypto = require('crypto');
const { verify: verifyRefreshToken } = require('./auth/_lib/refreshToken');
const { dbGet, dbSet, dbUpdate, dbRemove, emailKey } = require('./admin/_lib/fbrest');
const { EXPENSE_CATEGORIES } = require('./expenses/_lib/expensesConfig');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LABEL_LEN = 200;
const MAX_DESC_LEN = 1000;
const MAX_PAYMENT_LEN = 100;
const MAX_CURRENCY_LEN = 10;
const DEFAULT_CURRENCY = 'EUR'; // meme defaut que api/marketplace/create-order.js et api/subscriptions/create-order.js

function round2(x) { return Math.round(x * 100) / 100; }

/* Round-trip via Date.UTC : rejette les dates calendaires impossibles
   (2026-13-45, 2026-02-30...) qu'une simple regex laisserait passer. */
function isValidDateStr(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function expensePath(key, expenseId) { return '/gw/expenses/' + key + '/' + expenseId; }
function collectionPath(key) { return '/gw/expenses/' + key; }

/* Valide les champs COMMUNS a la creation et a la modification ;
   `partial` = true en PATCH (seuls les champs presents sont valides,
   tout le reste peut etre absent). Ne corrige jamais silencieusement
   une valeur invalide (AI-TOOL-32 §8) — chaque erreur est listee. */
function validateFields(body, partial) {
  const errors = [];
  const out = {};

  if (!partial || body.date !== undefined) {
    if (!isValidDateStr(body.date)) errors.push('date invalide (format attendu : YYYY-MM-DD, date calendaire reelle)');
    else out.date = body.date;
  }

  if (!partial || body.amount !== undefined) {
    const amount = body.amount;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      errors.push('amount invalide (nombre fini strictement superieur a 0 attendu)');
    } else {
      out.amount = round2(amount);
    }
  }

  if (!partial || body.category !== undefined) {
    if (typeof body.category !== 'string' || !EXPENSE_CATEGORIES.includes(body.category)) {
      errors.push('category invalide (categorie hors liste autorisee)');
    } else {
      out.category = body.category;
    }
  }

  if (!partial || body.label !== undefined) {
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    if (!label) errors.push('label obligatoire');
    else if (label.length > MAX_LABEL_LEN) errors.push('label trop long (' + MAX_LABEL_LEN + ' caracteres max)');
    else out.label = label;
  }

  if (body.description !== undefined) {
    if (typeof body.description !== 'string' || body.description.length > MAX_DESC_LEN) {
      errors.push('description invalide (' + MAX_DESC_LEN + ' caracteres max)');
    } else {
      out.description = body.description.trim();
    }
  }

  if (body.paymentMethod !== undefined) {
    if (typeof body.paymentMethod !== 'string' || body.paymentMethod.length > MAX_PAYMENT_LEN) {
      errors.push('paymentMethod invalide (' + MAX_PAYMENT_LEN + ' caracteres max)');
    } else {
      out.paymentMethod = body.paymentMethod.trim();
    }
  }

  if (body.currency !== undefined) {
    if (typeof body.currency !== 'string' || !body.currency.trim() || body.currency.trim().length > MAX_CURRENCY_LEN) {
      errors.push('currency invalide');
    } else {
      out.currency = body.currency.trim().toUpperCase();
    }
  } else if (!partial) {
    out.currency = DEFAULT_CURRENCY;
  }

  return { errors, out };
}

/* Aucun arrondi intermediaire par ligne (derive flottante evitee,
   AI-TOOL-31 §5/§15) : on accumule les sommes brutes puis on arrondit
   UNE SEULE FOIS le resultat final, par devise. Jamais d'addition
   silencieuse entre devises differentes (AI-TOOL-32 §10) — regroupees
   sous totalsByCurrency ; total/byCategory au premier niveau ne sont
   remplis que s'il n'existe qu'une seule devise parmi les resultats
   filtres (cas dominant, currency par defaut = EUR partout). */
function computeTotals(expenses) {
  const sums = {};
  for (const e of expenses) {
    const cur = e.currency || DEFAULT_CURRENCY;
    if (!sums[cur]) sums[cur] = { total: 0, byCategory: {} };
    sums[cur].total += e.amount;
    sums[cur].byCategory[e.category] = (sums[cur].byCategory[e.category] || 0) + e.amount;
  }
  const totalsByCurrency = {};
  for (const cur of Object.keys(sums)) {
    const byCategory = {};
    for (const cat of Object.keys(sums[cur].byCategory)) byCategory[cat] = round2(sums[cur].byCategory[cat]);
    totalsByCurrency[cur] = { total: round2(sums[cur].total), byCategory };
  }
  const currencies = Object.keys(totalsByCurrency);
  const multiCurrency = currencies.length > 1;
  return {
    totalsByCurrency,
    multiCurrency,
    total: multiCurrency ? null : (currencies.length === 1 ? totalsByCurrency[currencies[0]].total : 0),
    byCategory: multiCurrency ? null : (currencies.length === 1 ? totalsByCurrency[currencies[0]].byCategory : {}),
  };
}

async function handleGet(req, res, email) {
  const key = emailKey(email);
  const { from, to, category } = req.query;

  if (from !== undefined && !isValidDateStr(from)) { res.status(400).json({ error: 'from invalide (YYYY-MM-DD attendu)' }); return; }
  if (to !== undefined && !isValidDateStr(to)) { res.status(400).json({ error: 'to invalide (YYYY-MM-DD attendu)' }); return; }
  if (category !== undefined && !EXPENSE_CATEGORIES.includes(category)) { res.status(400).json({ error: 'category invalide' }); return; }

  let doc;
  try { doc = await dbGet(collectionPath(key)); } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
    return;
  }
  let expenses = doc && typeof doc === 'object' ? Object.values(doc) : [];
  if (from !== undefined) expenses = expenses.filter((e) => e.date >= from);
  if (to !== undefined) expenses = expenses.filter((e) => e.date <= to);
  if (category !== undefined) expenses = expenses.filter((e) => e.category === category);
  expenses.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || 0) - (a.createdAt || 0)));

  const totals = computeTotals(expenses);
  res.status(200).json({
    ok: true,
    expenses,
    total: totals.total,
    byCategory: totals.byCategory,
    multiCurrency: totals.multiCurrency,
    totalsByCurrency: totals.totalsByCurrency,
  });
}

async function handlePost(req, res, email) {
  const body = req.body || {};
  const { errors, out } = validateFields(body, false);
  if (errors.length) { res.status(400).json({ error: errors.join(' ; ') }); return; }

  const key = emailKey(email);
  const expenseId = crypto.randomUUID();
  const now = Date.now();
  const expense = Object.assign({ expenseId, createdAt: now, updatedAt: now }, out);

  try {
    await dbSet(expensePath(key, expenseId), expense);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
    return;
  }
  res.status(200).json({ ok: true, expense });
}

async function handlePatch(req, res, email) {
  const expenseId = req.query.expenseId;
  if (!expenseId || typeof expenseId !== 'string') { res.status(400).json({ error: 'expenseId manquant' }); return; }

  const body = req.body || {};
  const { errors, out } = validateFields(body, true);
  if (errors.length) { res.status(400).json({ error: errors.join(' ; ') }); return; }
  if (!Object.keys(out).length) { res.status(400).json({ error: 'aucun champ a modifier' }); return; }

  const key = emailKey(email);
  const path = expensePath(key, expenseId);

  let existing;
  try { existing = await dbGet(path); } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
    return;
  }
  if (!existing) { res.status(404).json({ error: 'Depense introuvable' }); return; }

  /* Whitelist stricte : jamais un Object.assign(existing, body) — seuls
     les champs valides issus de validateFields() atteignent Firebase.
     createdAt/expenseId jamais inclus dans `out`, donc jamais ecrases ;
     updatedAt toujours regenere cote serveur (AI-TOOL-32 §11). */
  const patch = Object.assign({}, out, { updatedAt: Date.now() });
  try {
    await dbUpdate(path, patch);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
    return;
  }
  res.status(200).json({ ok: true, expense: Object.assign({}, existing, patch) });
}

async function handleDelete(req, res, email) {
  const expenseId = req.query.expenseId;
  if (!expenseId || typeof expenseId !== 'string') { res.status(400).json({ error: 'expenseId manquant' }); return; }

  const key = emailKey(email);
  const path = expensePath(key, expenseId);

  let existing;
  try { existing = await dbGet(path); } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
    return;
  }
  if (!existing) { res.status(404).json({ error: 'Depense introuvable' }); return; }

  try {
    await dbRemove(path);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
    return;
  }
  res.status(200).json({ ok: true });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  /* GET/DELETE : authRefreshToken en query (coherent avec
     api/ai/memory.js pour GET et api/ai/memory/[scope]/[key].js pour
     DELETE — un DELETE via fetch() n'a pas de body cote client par
     defaut). POST/PATCH : authRefreshToken dans le body JSON, comme
     api/jobs/apply.js. Identite TOUJOURS re-derivee ici, jamais prise
     ailleurs dans la requete. */
  const token = (req.method === 'GET' || req.method === 'DELETE')
    ? req.query.authRefreshToken
    : (req.body || {}).authRefreshToken;
  const ticketData = verifyRefreshToken(token);
  if (!ticketData || !ticketData.email) {
    res.status(401).json({ error: 'Connecte-toi pour utiliser le suivi des depenses.' });
    return;
  }

  try {
    if (req.method === 'GET') { await handleGet(req, res, ticketData.email); return; }
    if (req.method === 'POST') { await handlePost(req, res, ticketData.email); return; }
    if (req.method === 'PATCH') { await handlePatch(req, res, ticketData.email); return; }
    if (req.method === 'DELETE') { await handleDelete(req, res, ticketData.email); return; }
    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[Geniwork Expenses] erreur:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports.EXPENSE_CATEGORIES = EXPENSE_CATEGORIES;
