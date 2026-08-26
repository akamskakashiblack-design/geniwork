/* ═══════════════════════════════════════════════════════════════
   GENIWORK — POST /api/marketplace/create-order (Phase 6B-4)
   Étape 1/2 de la sécurisation du paiement Marketplace (architecture
   validée en Phase 6B-2, prérequis confirmés absents en Phase 6B-3).

   MODE MOCK UNIQUEMENT pendant cette phase — voir _lib/paypal.js.
   Aucun appel PayPal réel, aucune transaction réelle. Toute réponse
   contient "mock:true" pour ne jamais être confondue avec une preuve
   de paiement réelle.

   Remplace, pour le calcul du montant/devise/commission/vendeur, ce
   que faisaient jusqu'ici _mkRenderPayPalBtn()/_mkRenderEbookPayPalBtn()/
   _cartLoadPayPal() côté client (js/app.js) : ces fonctions ne sont PAS
   modifiées dans cette phase (elles restent le chemin en production —
   voir rapport Phase 6B-4, section "Fichiers modifiés"), seul ce nouvel
   endpoint est créé et testé en parallèle, débranché du flux réel.

   Body :
   { authRefreshToken, listingId }                         — achat simple/ebook
   { authRefreshToken, cartItems: [{listingId, quantity}] } — panier

   Réponse : { ok:true, orderID, mock:true, amount, currency }
          ou { ok:false, error }

   Phase 9F-bis : resolveListing() ne lit plus que gw/mk_listings_v2 —
   le fallback vers l'ancien tableau gw/mk_listings a ete retire apres
   comparaison exhaustive LIVE (9F-bis.6) confirmant que v2 est un
   sur-ensemble complet par id de toutes les annonces (0 annonce
   presente uniquement dans le legacy).
═══════════════════════════════════════════════════════════════ */

const { dbGet, dbSet } = require('../admin/_lib/fbrest');
const { verify: verifyRefreshToken } = require('../auth/_lib/refreshToken');
const { createOrder: paypalCreateOrder } = require('./_lib/paypal');
const { convertToEUR } = require('./_lib/currency');

const COMMISSION_RATE = 0.01; /* identique à _GW_COMMISSION_RATE (js/app.js) */
const PLATFORM_PAYPAL_EMAIL_DEFAULT = 'geniwork.admin@gmail.com'; /* identique à _GW_PAYPAL_EMAIL par défaut */
const MAX_CART_ITEMS = 50;
const MAX_QTY = 20;

function isValidListingId(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
}

/* Phase 9F-bis : resout un listingId sans jamais faire confiance a un
   sellerUid fourni par le client (il n'en fournit d'ailleurs aucun).
   Ne cherche plus que dans gw/mk_listings_v2/{sellerUid}/{listingId}
   (le fallback vers l'ancien tableau gw/mk_listings a ete retire,
   cf. en-tete de fichier). Parcourt tous les vendeurs cote serveur
   (compte de service, lecture complete) — jamais une recherche cote
   sellerUid arbitraire transmis par le client. */
async function resolveListing(listingId, nestedListingsV2) {
  if (nestedListingsV2 && typeof nestedListingsV2 === 'object') {
    for (const sellerUid of Object.keys(nestedListingsV2)) {
      const bySeller = nestedListingsV2[sellerUid];
      if (bySeller && typeof bySeller === 'object' && bySeller[listingId]) return bySeller[listingId];
    }
  }
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Method not allowed' }); return; }

  try {
    const body = req.body || {};

    /* ── Identité de l'acheteur : dérivée UNIQUEMENT du jeton signé. ── */
    const ticketData = verifyRefreshToken(body.authRefreshToken);
    if (!ticketData || !ticketData.email) {
      res.status(401).json({ ok: false, error: 'Session expirée, reconnectez-vous.' });
      return;
    }
    const buyerEmail = ticketData.email;

    /* ── Forme de la requête : exactement une des deux formes. ── */
    const hasListingId = body.listingId !== undefined;
    const hasCart = body.cartItems !== undefined;
    if (hasListingId === hasCart) {
      res.status(400).json({ ok: false, error: 'Requête invalide : fournir soit listingId, soit cartItems, jamais les deux.' });
      return;
    }

    let requestedItems; /* [{ listingId, quantity }] */
    let kind;
    if (hasListingId) {
      if (!isValidListingId(body.listingId)) {
        res.status(400).json({ ok: false, error: 'listingId invalide' });
        return;
      }
      requestedItems = [{ listingId: body.listingId, quantity: 1 }];
      kind = 'single';
    } else {
      if (!Array.isArray(body.cartItems) || !body.cartItems.length || body.cartItems.length > MAX_CART_ITEMS) {
        res.status(400).json({ ok: false, error: 'cartItems invalide' });
        return;
      }
      requestedItems = [];
      for (const it of body.cartItems) {
        if (!it || !isValidListingId(it.listingId)) {
          res.status(400).json({ ok: false, error: 'cartItems : listingId invalide' });
          return;
        }
        const qty = Number(it.quantity);
        if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
          res.status(400).json({ ok: false, error: 'cartItems : quantity invalide' });
          return;
        }
        requestedItems.push({ listingId: it.listingId, quantity: qty });
      }
      kind = 'cart';
    }

    /* ── Vérification admin : paiements activés. Source serveur réelle
       (gw/plans_config), jamais le localStorage client. ── */
    let plansConfig;
    try { plansConfig = await dbGet('/gw/plans_config'); } catch (e) {
      res.status(500).json({ ok: false, error: 'Erreur serveur' });
      return;
    }
    const paypalEnabled = !!(plansConfig && plansConfig.paypalEnabled);
    if (!paypalEnabled) {
      res.status(403).json({ ok: false, error: 'Paiements temporairement désactivés' });
      return;
    }

    /* ── Résolution serveur des annonces — jamais le prix/vendeur du client.
       Lit gw/mk_listings_v2 une seule fois, réutilisé pour tous les
       items de la requête (Phase 9F-bis : fallback legacy retiré). ── */
    let nestedV2;
    try {
      nestedV2 = await dbGet('/gw/mk_listings_v2');
    } catch (e) {
      res.status(500).json({ ok: false, error: 'Erreur serveur' });
      return;
    }

    const resolvedItems = [];
    for (const req_ of requestedItems) {
      const listing = await resolveListing(req_.listingId, nestedV2);
      if (!listing) {
        res.status(404).json({ ok: false, error: 'Annonce introuvable : ' + req_.listingId });
        return;
      }
      if (listing.status !== 'active') {
        res.status(409).json({ ok: false, error: 'Annonce non disponible : ' + req_.listingId });
        return;
      }
      if (!listing.sellerEmail || listing.sellerEmail === buyerEmail) {
        res.status(403).json({ ok: false, error: 'Achat impossible sur votre propre annonce : ' + req_.listingId });
        return;
      }
      const price = Number(listing.price);
      if (!Number.isFinite(price) || price <= 0) {
        res.status(409).json({ ok: false, error: 'Prix invalide sur l\'annonce : ' + req_.listingId });
        return;
      }
      const unitPriceEUR = await convertToEUR(price, listing.currency || 'EUR');
      resolvedItems.push({
        listingId: listing.id,
        quantity: req_.quantity,
        title: listing.title || '',
        type: listing.type || 'service',
        sellerEmail: listing.sellerEmail,
        sellerPaypal: listing.sellerPaypal || '',
        unitPriceEUR: unitPriceEUR,
      });
    }

    /* ── Calcul du montant — reproduit fidèlement les deux modèles
       distincts déjà observés côté client (Phase 6B-2 §6) : achat
       simple/ebook = payé directement au vendeur, commission déduite
       de son net ; panier = commission ajoutée, payé à la plateforme. ── */
    let amountEUR, payeeEmail, description, commission;
    if (kind === 'single') {
      const item = resolvedItems[0];
      amountEUR = Math.round(item.unitPriceEUR * item.quantity * 100) / 100;
      commission = Math.round(amountEUR * COMMISSION_RATE * 100) / 100;
      payeeEmail = item.sellerPaypal;
      description = item.title || 'Commande Geniwork';
      if (!payeeEmail) {
        res.status(409).json({ ok: false, error: 'Le vendeur n\'a pas configuré son email PayPal' });
        return;
      }
    } else {
      const subtotal = resolvedItems.reduce((s, it) => s + it.unitPriceEUR * it.quantity, 0);
      commission = Math.round(subtotal * COMMISSION_RATE * 100) / 100;
      amountEUR = Math.round((subtotal + commission) * 100) / 100;
      payeeEmail = (plansConfig && plansConfig.paypalEmail) || PLATFORM_PAYPAL_EMAIL_DEFAULT;
      description = 'Commande Geniwork – ' + resolvedItems.length + ' article(s)';
    }

    if (amountEUR <= 0) {
      res.status(409).json({ ok: false, error: 'Montant invalide' });
      return;
    }

    /* ── MOCK : aucun appel réseau PayPal réel (voir _lib/paypal.js). ── */
    let order = null;
    let existing = true;
    /* Phase 6B-5 : garde défensive anti-collision — orderID généré par
       Date.now()+random (voir _lib/paypal.js), collision quasi
       impossible, mais on ne réutilise jamais silencieusement un
       gw/mk_pending_orders/{orderID} déjà occupé par une autre commande. */
    for (let attempt = 0; attempt < 3 && existing; attempt++) {
      order = await paypalCreateOrder({
        amount: amountEUR,
        currency: 'EUR',
        payeeEmail: payeeEmail,
        description: description,
      });
      let already;
      try { already = await dbGet('/gw/mk_pending_orders/' + order.orderID); } catch (e) {
        res.status(500).json({ ok: false, error: 'Erreur serveur' });
        return;
      }
      existing = !!already;
    }
    if (existing) {
      res.status(500).json({ ok: false, error: 'Erreur serveur (génération de commande)' });
      return;
    }

    /* ── État interne de corrélation (Phase 6B-2 §3) — écrit serveur
       uniquement, jamais lu ni modifié par le client. ── */
    await dbSet('/gw/mk_pending_orders/' + order.orderID, {
      orderID: order.orderID,
      mock: order.mock,
      kind: kind,
      buyerEmail: buyerEmail,
      items: resolvedItems,
      expectedAmount: amountEUR,
      expectedCurrency: 'EUR',
      commission: commission,
      payeeEmail: payeeEmail,
      createdAt: new Date().toISOString(),
      status: 'created',
    });

    res.status(200).json({ ok: true, orderID: order.orderID, mock: order.mock, amount: amountEUR, currency: 'EUR' });
  } catch (err) {
    console.error('[Geniwork Marketplace] erreur create-order:', err.message);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
};
