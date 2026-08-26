/* ═══════════════════════════════════════════════════════════════
   GENIWORK — POST /api/marketplace/capture-order (Phase 6B-4/6B-5)
   Étape 2/2 de la sécurisation du paiement Marketplace.

   Phase 6B-5 : le verrou anti-rejeu "best-effort" de la Phase 6B-4
   (lecture puis écriture non atomiques) est remplacé par une écriture
   conditionnelle Firebase (ETag/If-Match, voir _lib/fbrest.js) — deux
   requêtes concurrentes/rejouées pour le même orderID ne peuvent plus
   jamais produire deux transactions/deux accès ebook. Ajout d'une
   expiration (30 min) des commandes en attente non capturées.

   MODE MOCK UNIQUEMENT pendant cette phase — voir _lib/paypal.js.
   Aucune capture PayPal réelle. Toute écriture produite par cet
   endpoint porte "mock:true" et ne doit jamais être présentée comme
   une preuve de paiement réelle.

   Remplace, pour l'écriture de la transaction, l'octroi d'accès ebook
   et la corrélation anti-rejeu, ce que faisait jusqu'ici le callback
   onApprove()/actions.order.capture() côté client. Les fonctions
   client (_cartCheckoutSuccess, onApprove des 2 boutons PayPal) ne
   sont PAS modifiées dans cette phase — cet endpoint est créé et
   testé en parallèle, débranché du flux réel (voir rapport Phase
   6B-4, section "Fichiers modifiés").

   Notification vendeur : hors périmètre explicite de cette phase
   (Phase 6B-2 §10 — modification d'/api/notify différée). Non
   déclenchée ici.

   Body : { authRefreshToken, orderID }
   Réponse : { ok:true, mock:true, txnId, ebookAccessGranted }
          ou { ok:false, error }
═══════════════════════════════════════════════════════════════ */

const { dbGet, dbSet, dbGetWithETag, dbSetIfMatch } = require('../admin/_lib/fbrest');
const { verify: verifyRefreshToken } = require('../auth/_lib/refreshToken');
const { captureOrder: paypalCaptureOrder } = require('./_lib/paypal');

const PENDING_ORDER_TTL_MS = 30 * 60 * 1000; /* 30 minutes — au-delà, une commande n'est plus capturable */

function toArray(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return Object.keys(v).sort((a, b) => Number(a) - Number(b)).map((k) => v[k]);
  return [];
}

function emailKey(email) {
  return String(email || '').toLowerCase()
    .replace(/\./g, '__d__').replace(/@/g, '__a__').replace(/[#$[\]/]/g, '_');
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

    /* ── Identité réelle de l'appelant — jamais un email séparé. ── */
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

    /* ── Corrélation (Phase 6B-2 §3) : jamais reconstruite depuis le
       client, uniquement depuis l'état interne écrit par create-order. ── */
    let pending;
    try { pending = await dbGet('/gw/mk_pending_orders/' + orderID); } catch (e) {
      res.status(500).json({ ok: false, error: 'Erreur serveur' });
      return;
    }
    /* Réponse volontairement identique (403) : commande inexistante,
       déjà traitée, ou appartenant à un autre acheteur — ne révèle pas
       laquelle de ces conditions a échoué. Cette vérification a lieu
       AVANT toute tentative de verrou (voir 6B-5) : un appelant non
       autorisé ne doit jamais pouvoir faire échouer/verrouiller la
       commande d'un tiers, même en perdant volontairement une course. */
    if (!pending || pending.status !== 'created' || pending.buyerEmail !== callerEmail) {
      res.status(403).json({ ok: false, error: 'Commande non autorisée ou déjà traitée' });
      return;
    }

    /* ── Expiration (Phase 6B-5) : une commande créée il y a trop
       longtemps n'est plus capturable — évite qu'un orderID ancien
       (prix potentiellement obsolète, ou jamais nettoyé) reste
       indéfiniment exploitable. ── */
    const createdAtMs = Date.parse(pending.createdAt || '');
    if (!Number.isFinite(createdAtMs) || (Date.now() - createdAtMs) > PENDING_ORDER_TTL_MS) {
      await dbSet('/gw/mk_pending_orders/' + orderID + '/status', 'expired');
      res.status(410).json({ ok: false, error: 'Commande expirée' });
      return;
    }

    /* ── Anti-rejeu (Phase 6B-5) : verrou ATOMIQUE réel via écriture
       conditionnelle Firebase (ETag/If-Match — équivalent REST d'une
       transaction). Si deux requêtes concurrentes/rejouées arrivent
       ici en même temps pour le même orderID, une seule peut gagner
       ce compare-and-swap ; l'autre échoue immédiatement sans jamais
       toucher gw/mk_txns/gw/ebook_access. Remplace le verrou
       "best-effort" non atomique de la Phase 6B-4. ── */
    let statusRead;
    try {
      statusRead = await dbGetWithETag('/gw/mk_pending_orders/' + orderID + '/status');
    } catch (e) {
      res.status(500).json({ ok: false, error: 'Erreur serveur' });
      return;
    }
    if (statusRead.value !== 'created') {
      res.status(403).json({ ok: false, error: 'Commande non autorisée ou déjà traitée' });
      return;
    }
    let lock;
    try {
      lock = await dbSetIfMatch('/gw/mk_pending_orders/' + orderID + '/status', 'capturing', statusRead.etag);
    } catch (e) {
      res.status(500).json({ ok: false, error: 'Erreur serveur' });
      return;
    }
    if (!lock.ok) {
      /* Conflit : une autre requête a gagné la course entre-temps —
         traité exactement comme une commande déjà traitée. */
      res.status(403).json({ ok: false, error: 'Commande non autorisée ou déjà traitée' });
      return;
    }

    /* ── MOCK : aucune capture PayPal réelle (voir _lib/paypal.js). ── */
    const capture = await paypalCaptureOrder({
      orderID: orderID,
      expectedAmount: pending.expectedAmount,
      expectedCurrency: pending.expectedCurrency,
    });

    const amountMatches = capture.status === 'COMPLETED'
      && Number(capture.amount) === Number(pending.expectedAmount)
      && capture.currency === pending.expectedCurrency;

    if (!amountMatches) {
      await dbSet('/gw/mk_pending_orders/' + orderID + '/status', 'failed');
      res.status(409).json({ ok: false, error: 'Capture non confirmée (montant/devise/statut non conformes)' });
      return;
    }

    /* ── Transaction fiable — écrite serveur, canal admin (contourne les
       règles client). Champs identiques à la structure gw/mk_txns déjà
       utilisée (Phase 6B-2 §4), avec provenance explicite ajoutée. ── */
    let txns;
    try { txns = toArray(await dbGet('/gw/mk_txns')); } catch (e) {
      await dbSet('/gw/mk_pending_orders/' + orderID + '/status', 'failed');
      res.status(500).json({ ok: false, error: 'Erreur serveur' });
      return;
    }

    const txnId = 'txn_mock_' + Date.now();
    const sellerEmails = Array.from(new Set(pending.items.map((it) => it.sellerEmail))).join(', ');
    const listingTitle = pending.kind === 'single'
      ? (pending.items[0] && pending.items[0].title) || 'Commande'
      : pending.items.length + ' article(s)';

    const newTxn = {
      id: txnId,
      orderID: orderID,
      mock: capture.mock,
      source: 'server_verified_mock',
      kind: pending.kind,
      listingId: pending.kind === 'single' ? pending.items[0].listingId : undefined,
      listingTitle: listingTitle,
      amount: pending.expectedAmount,
      currency: pending.expectedCurrency,
      commission: pending.commission,
      sellerNet: Math.round((pending.expectedAmount - pending.commission) * 100) / 100,
      sellerEmail: sellerEmails,
      buyerEmail: callerEmail,
      paypalOrderId: orderID,
      status: 'completed',
      date: new Date().toISOString(),
    };
    txns.unshift(newTxn);
    await dbSet('/gw/mk_txns', txns);

    /* ── Accès ebook — accordé serveur uniquement pour les listings de
       type 'ebook' du panier/achat, résolvant l'anomalie relevée en
       Phase 6B-1 (l'ancien flux client ne l'accordait jamais). ── */
    let ebookAccessGranted = false;
    for (const item of pending.items) {
      if (item.type === 'ebook') {
        await dbSet('/gw/ebook_access/' + item.listingId + '/' + emailKey(callerEmail), {
          email: callerEmail,
          grantedAt: new Date().toISOString(),
          downloaded: false,
          grantedVia: 'purchase_mock',
        });
        ebookAccessGranted = true;
      }
    }

    await dbSet('/gw/mk_pending_orders/' + orderID + '/status', 'captured');

    res.status(200).json({ ok: true, mock: capture.mock, txnId: txnId, ebookAccessGranted: ebookAccessGranted });
  } catch (err) {
    console.error('[Geniwork Marketplace] erreur capture-order:', err.message);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
};
