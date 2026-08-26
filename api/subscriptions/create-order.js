/* ═══════════════════════════════════════════════════════════════
   GENIWORK — POST /api/subscriptions/create-order (Phase 6C-2)
   Backend abonnement Premium/Business — architecture validée en
   Phase 6C-1, réutilisant telle quelle celle déjà construite et
   testée pour le Marketplace (Phases 6B-2/6B-4/6B-5).

   MODE MOCK UNIQUEMENT pendant cette phase (voir
   ../marketplace/_lib/paypal.js — REAL_MODE_ENABLED=false, double
   verrou credentials+flag explicite, aucun changement ici). Aucun
   appel PayPal réel, aucune transaction réelle.

   Le client est branché à cet endpoint depuis la Phase 6C-3
   (_subRenderPayPalBtn(), js/app.js). L'ancien chemin d'attribution
   client direct (ex-_subActivatePlan(), écriture gw/profiles depuis
   le navigateur) a été définitivement supprimé en Phase 6C-6.

   Body : { authRefreshToken, plan, billing }
     plan    : "premium" | "business"  (jamais "pro" — n'existe pas)
     billing : "month" | "year"
   Réponse : { ok:true, orderID, mock:true, amount, currency }
          ou { ok:false, error }
═══════════════════════════════════════════════════════════════ */

const { dbGet, dbSet, emailKey, checkRateLimit } = require('../admin/_lib/fbrest');
const { verify: verifyRefreshToken } = require('../auth/_lib/refreshToken');
const { createOrder: paypalCreateOrder } = require('../marketplace/_lib/paypal');

/* Miroir serveur de _subAmounts (js/app.js) — jamais transmis par le
   client, c'est précisément ce que cette phase corrige. */
const SUB_PRICES = {
  premium:  { month: 4.99,  year: 49.99 },
  business: { month: 14.99, year: 149.99 },
};
const PLATFORM_PAYPAL_EMAIL_DEFAULT = 'geniwork.admin@gmail.com'; /* identique à _GW_PAYPAL_EMAIL par défaut */
const MAX_CREATE_ATTEMPTS = 3;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Method not allowed' }); return; }

  try {
    const body = req.body || {};

    const ticketData = verifyRefreshToken(body.authRefreshToken);
    if (!ticketData || !ticketData.email) {
      res.status(401).json({ ok: false, error: 'Session expirée, reconnectez-vous.' });
      return;
    }
    const buyerEmail = ticketData.email;

    /* Phase SYNC-55 : rate-limit fail-closed — création de commande d'abonnement. */
    const rl = await checkRateLimit('subscriptions:create-order:' + emailKey(buyerEmail), 20, 60 * 60 * 1000);
    if (rl.ok === false) { res.status(429).json({ ok: false, error: 'Trop de commandes récentes. Réessayez dans ' + rl.retryAfterSec + 's.' }); return; }
    if (rl.ok === null) { res.status(503).json({ ok: false, error: 'Service de protection anti-abus temporairement indisponible.' }); return; }

    const plan = body.plan;
    const billing = body.billing;
    if (plan !== 'premium' && plan !== 'business') {
      res.status(400).json({ ok: false, error: 'Plan invalide' });
      return;
    }
    if (billing !== 'month' && billing !== 'year') {
      res.status(400).json({ ok: false, error: 'Périodicité invalide' });
      return;
    }

    /* ── Activation admin réelle du plan — source serveur (gw/plans_config),
       jamais le localStorage client. ── */
    let plansConfig;
    try { plansConfig = await dbGet('/gw/plans_config'); } catch (e) {
      res.status(500).json({ ok: false, error: 'Erreur serveur' });
      return;
    }
    const enabledKey = plan === 'premium' ? 'premiumEnabled' : 'businessEnabled';
    if (!plansConfig || !plansConfig[enabledKey]) {
      res.status(403).json({ ok: false, error: 'Ce plan est temporairement indisponible' });
      return;
    }

    const amountEUR = SUB_PRICES[plan][billing];
    const payeeEmail = (plansConfig && plansConfig.paypalEmail) || PLATFORM_PAYPAL_EMAIL_DEFAULT;
    const labels = { premium: 'Geniwork Premium', business: 'Geniwork Business Pro' };
    const description = labels[plan] + ' · ' + (billing === 'year' ? 'Annuel' : 'Mensuel');

    /* ── MOCK : aucun appel réseau PayPal réel. ── */
    let order = null;
    let existing = true;
    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS && existing; attempt++) {
      order = await paypalCreateOrder({ amount: amountEUR, currency: 'EUR', payeeEmail: payeeEmail, description: description });
      let already;
      try { already = await dbGet('/gw/sub_pending_orders/' + order.orderID); } catch (e) {
        res.status(500).json({ ok: false, error: 'Erreur serveur' });
        return;
      }
      existing = !!already;
    }
    if (existing) {
      res.status(500).json({ ok: false, error: 'Erreur serveur (génération de commande)' });
      return;
    }

    await dbSet('/gw/sub_pending_orders/' + order.orderID, {
      orderID: order.orderID,
      mock: order.mock,
      buyerEmail: buyerEmail,
      plan: plan,
      billing: billing,
      expectedAmount: amountEUR,
      expectedCurrency: 'EUR',
      payeeEmail: payeeEmail,
      createdAt: new Date().toISOString(),
      status: 'created',
    });

    res.status(200).json({ ok: true, orderID: order.orderID, mock: order.mock, amount: amountEUR, currency: 'EUR' });
  } catch (err) {
    console.error('[Geniwork Subscriptions] erreur create-order:', err.message);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
};
