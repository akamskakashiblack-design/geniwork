/* ═══════════════════════════════════════════════════════════════
   GENIWORK — POST /api/subscriptions/capture-order (Phase 6C-2)

   MODE MOCK UNIQUEMENT (voir ../marketplace/_lib/paypal.js). Aucune
   capture PayPal réelle. Toute écriture produite ici porte "mock:true"
   / "source:'server_verified_mock'" et ne doit jamais être présentée
   comme une preuve de paiement réelle.

   Le client N'EST PAS ENCORE branché à cet endpoint (voir create-order.js
   — même principe que la Phase 6B-4 pour le Marketplace).

   Écrit gw/profiles UNIQUEMENT via PATCH (dbUpdate), jamais un .set()
   complet — ne touche que les champs liés à l'abonnement, ne doit
   jamais écraser bio/photo/skills/etc. déjà présents sur le profil.

   Body : { authRefreshToken, orderID }
   Réponse : { ok:true, mock:true, plan, billing, planRenewalDate }
          ou { ok:false, error }
═══════════════════════════════════════════════════════════════ */

const { dbGet, dbSet, dbUpdate, dbGetWithETag, dbSetIfMatch, emailKey } = require('../admin/_lib/fbrest');
const { verify: verifyRefreshToken } = require('../auth/_lib/refreshToken');
const { captureOrder: paypalCaptureOrder } = require('../marketplace/_lib/paypal');

const PENDING_ORDER_TTL_MS = 30 * 60 * 1000; /* 30 minutes, identique au Marketplace (6B-5) */
const BILLING_MS = { month: 30 * 24 * 3600 * 1000, year: 365 * 24 * 3600 * 1000 };

function toArray(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return Object.keys(v).sort((a, b) => Number(a) - Number(b)).map((k) => v[k]);
  return [];
}

function isValidOrderId(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(v);
}

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
    const callerEmail = ticketData.email;

    if (!isValidOrderId(body.orderID)) {
      res.status(400).json({ ok: false, error: 'orderID invalide' });
      return;
    }
    const orderID = body.orderID;

    let pending;
    try { pending = await dbGet('/gw/sub_pending_orders/' + orderID); } catch (e) {
      res.status(500).json({ ok: false, error: 'Erreur serveur' });
      return;
    }
    /* Réponse volontairement identique (403) : commande inexistante,
       déjà traitée, ou appartenant à un autre acheteur. Vérifié AVANT
       toute tentative de verrou, pour qu'un appelant non autorisé ne
       puisse jamais faire échouer la commande d'un tiers. */
    if (!pending || pending.status !== 'created' || pending.buyerEmail !== callerEmail) {
      res.status(403).json({ ok: false, error: 'Commande non autorisée ou déjà traitée' });
      return;
    }

    const createdAtMs = Date.parse(pending.createdAt || '');
    if (!Number.isFinite(createdAtMs) || (Date.now() - createdAtMs) > PENDING_ORDER_TTL_MS) {
      await dbSet('/gw/sub_pending_orders/' + orderID + '/status', 'expired');
      res.status(410).json({ ok: false, error: 'Commande expirée' });
      return;
    }

    /* ── Anti-rejeu atomique (ETag/If-Match) — identique au Marketplace 6B-5. ── */
    let statusRead;
    try { statusRead = await dbGetWithETag('/gw/sub_pending_orders/' + orderID + '/status'); } catch (e) {
      res.status(500).json({ ok: false, error: 'Erreur serveur' });
      return;
    }
    if (statusRead.value !== 'created') {
      res.status(403).json({ ok: false, error: 'Commande non autorisée ou déjà traitée' });
      return;
    }
    let lock;
    try { lock = await dbSetIfMatch('/gw/sub_pending_orders/' + orderID + '/status', 'capturing', statusRead.etag); } catch (e) {
      res.status(500).json({ ok: false, error: 'Erreur serveur' });
      return;
    }
    if (!lock.ok) {
      res.status(403).json({ ok: false, error: 'Commande non autorisée ou déjà traitée' });
      return;
    }

    /* ── MOCK : aucune capture PayPal réelle. ── */
    const capture = await paypalCaptureOrder({
      orderID: orderID,
      expectedAmount: pending.expectedAmount,
      expectedCurrency: pending.expectedCurrency,
    });

    const amountMatches = capture.status === 'COMPLETED'
      && Number(capture.amount) === Number(pending.expectedAmount)
      && capture.currency === pending.expectedCurrency;

    if (!amountMatches) {
      await dbSet('/gw/sub_pending_orders/' + orderID + '/status', 'failed');
      res.status(409).json({ ok: false, error: 'Capture non confirmée (montant/devise/statut non conformes)' });
      return;
    }

    /* ── Attribution du plan — PATCH uniquement (dbUpdate), jamais un
       .set() complet du profil : ne touche que les champs liés à
       l'abonnement, préserve bio/photo/skills/etc. déjà présents. ── */
    const now = new Date();
    const renewalMs = BILLING_MS[pending.billing] || BILLING_MS.month;
    const planRenewalDate = new Date(now.getTime() + renewalMs).toISOString();
    const profilePatch = {
      planType: pending.plan,
      planBilling: pending.billing,
      planSince: now.toISOString(),
      planCancelled: false,
      planRenewalDate: planRenewalDate,
      /* Phase PAYPAL-SUB-FIX-01 : cycle de vie explicite (Option B).
         Compatibilité : les profils créés avant cette phase n'ont pas ce
         champ — cancel.js/sync-status.js l'interprètent alors comme
         'active' par défaut (voir leur commentaire de compatibilité). */
      planStatus: 'active',
      badgeType: 'premium',
      badgeStatus: 'approved',
      badgeApprovedAt: now.toISOString(),
      badgeSource: 'subscription',
      identityVerified: true,
      /* Phase PAYPAL-SUB-FIX-01 : référence légère pour le bouton
         "Demander un remboursement" côté client (évite d'exposer le
         ledger global gw/payments aux utilisateurs non-admin). */
      subLastOrderId: orderID,
      subLastPaymentAt: now.toISOString(),
      subLastRefundStatus: 'none',
    };
    try {
      await dbUpdate('/gw/profiles/' + emailKey(callerEmail), profilePatch);
    } catch (e) {
      await dbSet('/gw/sub_pending_orders/' + orderID + '/status', 'failed');
      res.status(500).json({ ok: false, error: 'Erreur serveur' });
      return;
    }

    /* ── Registre des paiements — écrit serveur (canal admin), même
       structure que gw/payments déjà utilisée, provenance explicite. ── */
    let payments;
    try { payments = toArray(await dbGet('/gw/payments')); } catch (e) { payments = []; }
    const amountsLabel = {
      premium: { month: '4,99 €', year: '49,99 €' },
      business: { month: '14,99 €', year: '149,99 €' },
    };
    payments.unshift({
      id: 'pay_mock_' + Date.now(),
      email: callerEmail,
      plan: pending.plan,
      billing: pending.billing,
      amount: (amountsLabel[pending.plan] && amountsLabel[pending.plan][pending.billing]) || pending.expectedAmount + ' EUR',
      paypalTxId: orderID,
      /* Phase PAYPAL-SUB-FIX-01 : captureID réel PayPal, distinct de
         orderID — jamais persisté avant cette phase, requis par
         refund.js (/v2/payments/captures/{captureId}/refund). */
      paypalCaptureId: capture.captureId,
      mock: capture.mock,
      source: 'server_verified_mock',
      date: now.toISOString(),
      status: 'completed',
    });
    await dbSet('/gw/payments', payments);

    await dbSet('/gw/sub_pending_orders/' + orderID + '/status', 'captured');

    res.status(200).json({ ok: true, mock: capture.mock, plan: pending.plan, billing: pending.billing, planRenewalDate: planRenewalDate });
  } catch (err) {
    console.error('[Geniwork Subscriptions] erreur capture-order:', err.message);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
};
