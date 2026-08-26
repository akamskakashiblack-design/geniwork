/* ═══════════════════════════════════════════════════════════════
   GENIWORK — POST /api/subscriptions/refund (Phase PAYPAL-SUB-FIX-01)

   Remboursement intégral, fenêtre de 7 jours UTC à compter de la date
   de capture (règle métier validée en PAYPAL-SUB-ARCH-APPROVAL). Un seul
   remboursement autorisé par transaction — verrou dédié
   gw/sub_refund_locks/{orderID} (ETag/If-Match, même pattern déjà
   validé sur gw/sub_pending_orders/{orderID}/status). Downgrade
   immédiat vers free en cas de succès (contrairement à une résiliation
   classique qui conserve l'accès jusqu'à expiration — le service est ici
   annulé rétroactivement).

   Le ledger d'origine (gw/payments) n'est JAMAIS muté : une nouvelle
   entrée de remboursement est ajoutée séparément, préservant la piste
   d'audit immuable.

   Body : { authRefreshToken, orderID }
   Réponse : { ok:true, refundStatus:'refunded', refundAt } ou { ok:false, error }
═══════════════════════════════════════════════════════════════ */

const { dbGet, dbSet, dbUpdate, dbGetWithETag, dbSetIfMatch, emailKey } = require('../admin/_lib/fbrest');
const { verify: verifyRefreshToken } = require('../auth/_lib/refreshToken');
const { refundCapture: paypalRefundCapture } = require('../marketplace/_lib/paypal');

const REFUND_WINDOW_MS = 7 * 24 * 3600 * 1000; /* 7 jours, UTC (Date.now()/Date.parse sont déjà en UTC) */

function isValidOrderId(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(v);
}
function toArray(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return Object.keys(v).sort((a, b) => Number(a) - Number(b)).map((k) => v[k]);
  return [];
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

    /* ── Ownership : retrouver la transaction dans le ledger, appartenant à l'appelant.
       Réponse volontairement identique (403) : transaction inexistante, ou
       appartenant à un tiers — jamais révéler laquelle. ── */
    let payments;
    try { payments = toArray(await dbGet('/gw/payments')); } catch (e) {
      res.status(500).json({ ok: false, error: 'Erreur serveur' });
      return;
    }
    /* status==='completed' exclut toute entrée de remboursement déjà
       ajoutée (append-only, même paypalTxId) — sans ce filtre, un 2e
       appel matcherait l'entrée de remboursement elle-même (dépourvue
       de paypalCaptureId) au lieu de l'achat d'origine, et renverrait
       409 au lieu du vrai statut "déjà traité". */
    const txn = payments.find((p) => p && p.paypalTxId === orderID && p.status === 'completed');
    if (!txn || txn.email !== callerEmail) {
      res.status(403).json({ ok: false, error: 'Transaction introuvable ou non autorisée' });
      return;
    }
    if (!txn.paypalCaptureId) {
      res.status(409).json({ ok: false, error: 'Capture introuvable pour cette transaction' });
      return;
    }

    /* ── Vérifie AVANT tout le statut du verrou (évite un 410 trompeur sur
       une transaction déjà remboursée dont la fenêtre serait aussi dépassée). ── */
    let lockRead;
    try { lockRead = await dbGetWithETag('/gw/sub_refund_locks/' + orderID + '/status'); } catch (e) {
      res.status(500).json({ ok: false, error: 'Erreur serveur' });
      return;
    }
    if (lockRead.value === 'refunded' || lockRead.value === 'processing') {
      res.status(403).json({ ok: false, error: 'Remboursement déjà traité' });
      return;
    }

    /* ── Fenêtre 7 jours UTC, à compter de la date de capture (txn.date). ── */
    const captureMs = Date.parse(txn.date || '');
    if (!Number.isFinite(captureMs) || (Date.now() - captureMs) > REFUND_WINDOW_MS) {
      try { await dbSet('/gw/sub_refund_locks/' + orderID, { orderID: orderID, status: 'denied', reason: 'window_expired', requestedAt: new Date().toISOString() }); } catch (e) {}
      res.status(410).json({ ok: false, error: 'Fenêtre de remboursement dépassée (7 jours)' });
      return;
    }

    /* ── Anti-double-remboursement atomique (ETag/If-Match). ── */
    let lock;
    try { lock = await dbSetIfMatch('/gw/sub_refund_locks/' + orderID + '/status', 'processing', lockRead.etag); } catch (e) {
      res.status(500).json({ ok: false, error: 'Erreur serveur' });
      return;
    }
    if (!lock.ok) {
      res.status(403).json({ ok: false, error: 'Remboursement déjà traité' });
      return;
    }

    /* ── Appel PayPal réel (ou mock), jamais initié par le client. ── */
    let refund;
    try {
      refund = await paypalRefundCapture({ captureId: txn.paypalCaptureId });
    } catch (e) {
      try { await dbSet('/gw/sub_refund_locks/' + orderID + '/status', 'denied'); } catch (e2) {}
      res.status(500).json({ ok: false, error: 'Erreur PayPal lors du remboursement' });
      return;
    }
    if (refund.status !== 'COMPLETED') {
      try { await dbSet('/gw/sub_refund_locks/' + orderID + '/status', 'denied'); } catch (e) {}
      res.status(409).json({ ok: false, error: 'Remboursement non confirmé par PayPal' });
      return;
    }

    const nowISO = new Date().toISOString();
    const key = emailKey(callerEmail);

    /* ── Downgrade immédiat (le service est annulé rétroactivement). ── */
    try {
      await dbUpdate('/gw/profiles/' + key, {
        planType: 'free', planBilling: null, planRenewalDate: null,
        planStatus: 'expired', planCancelled: false, planCancelledAt: null,
        subLastRefundStatus: 'refunded',
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: 'Erreur serveur' });
      return;
    }

    /* ── Nouvelle entrée ledger (append), la transaction d'origine n'est jamais mutée. ── */
    payments.unshift({
      id: 'refund_' + Date.now(),
      email: callerEmail,
      plan: txn.plan,
      billing: txn.billing,
      amount: txn.amount,
      paypalTxId: orderID,
      paypalRefundId: refund.refundId,
      mock: refund.mock,
      source: 'server_verified_mock',
      date: nowISO,
      status: 'refunded',
    });
    try { await dbSet('/gw/payments', payments); } catch (e) { /* non-bloquant pour la réponse client : le remboursement PayPal a déjà réussi */ }

    await dbSet('/gw/sub_refund_locks/' + orderID, { orderID: orderID, status: 'refunded', refundId: refund.refundId, refundAt: nowISO });

    res.status(200).json({ ok: true, refundStatus: 'refunded', refundAt: nowISO });
  } catch (err) {
    console.error('[Geniwork Subscriptions] erreur refund:', err.message);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
};
