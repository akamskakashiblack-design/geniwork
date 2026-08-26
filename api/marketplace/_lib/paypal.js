/* ═══════════════════════════════════════════════════════════════
   GENIWORK — Connecteur PayPal interne (Phase 6B-4)
   Utilisé par api/marketplace/create-order.js et capture-order.js.

   MODE MOCK (seul mode actif pendant cette phase) :
   - aucun appel réseau vers PayPal, aucune donnée PayPal réelle ;
   - orderID simulé, préfixé "MOCK_ORDER_" pour être reconnaissable
     sans ambiguïté dans toute donnée Firebase qu'il produit ;
   - la capture simulée renvoie exactement le montant/devise attendus
     transmis par l'appelant (elle ne "prouve" donc rien par elle-même —
     c'est le futur mode réel qui apportera la preuve indépendante).

   MODE RÉEL (Orders v2 API PayPal — écrit mais volontairement jamais
   activable pendant cette phase, même si les identifiants existaient) :
   - OAuth2 client_credentials (Basic Auth base64(client_id:client_secret))
     contre POST /v1/oauth2/token ;
   - POST /v2/checkout/orders (create) et
     POST /v2/checkout/orders/{id}/capture (capture) ;
   - hôte selon PAYPAL_ENVIRONMENT : "live" → api-m.paypal.com,
     tout le reste (y compris absent) → api-m.sandbox.paypal.com.

   Double verrou avant toute activation réelle :
   1) PAYPAL_CLIENT_ID et PAYPAL_CLIENT_SECRET doivent être présents ;
   2) REAL_MODE_ENABLED (constante ci-dessous) doit être mise à true —
      geste explicite réservé à une phase d'implémentation future
      validée, jamais un effet de bord de l'ajout des variables Vercel.
═══════════════════════════════════════════════════════════════ */

const https = require('https');

/* Phase PAYPAL-SANDBOX-01-TER : activé après confirmation manuelle que
   l'application PayPal configurée (PAYPAL_CLIENT_ID/SECRET, Vercel
   Production) est bien une application SANDBOX, et que PAYPAL_ENVIRONMENT
   n'est PAS "live" (paypalHost() ci-dessous route donc exclusivement vers
   api-m.sandbox.paypal.com, jamais api-m.paypal.com, indépendamment de ce
   flag). Ce flag ne sélectionne PAS Sandbox vs Live — il active seulement
   l'appel réseau réel (au lieu du mock) ; c'est PAYPAL_ENVIRONMENT qui
   détermine l'hôte. Repasser à false désactive tout appel réseau réel. */
const REAL_MODE_ENABLED = true;

function credentialsPresent() {
  return !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
}

function isRealModeActive() {
  return REAL_MODE_ENABLED && credentialsPresent();
}

function paypalHost() {
  return process.env.PAYPAL_ENVIRONMENT === 'live'
    ? 'api-m.paypal.com'
    : 'api-m.sandbox.paypal.com';
}

function _httpsJson(hostname, path, method, headers, body) {
  return new Promise(function (resolve, reject) {
    var payload = body !== undefined ? body : undefined;
    var req = https.request({ hostname: hostname, path: path, method: method, headers: headers }, function (resp) {
      var data = '';
      resp.on('data', function (c) { data += c; });
      resp.on('end', function () {
        var json = null;
        try { json = data ? JSON.parse(data) : null; } catch (e) { /* laisse json=null */ }
        resolve({ status: resp.statusCode, json: json, raw: data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/* ── Mode réel : jeton OAuth2 client_credentials ──
   N'est jamais appelée pendant cette phase (voir isRealModeActive()). */
async function _getRealAccessToken() {
  var clientId = process.env.PAYPAL_CLIENT_ID;
  var clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  var auth = Buffer.from(clientId + ':' + clientSecret).toString('base64');
  var body = 'grant_type=client_credentials';
  var resp = await _httpsJson(paypalHost(), '/v1/oauth2/token', 'POST', {
    'Authorization': 'Basic ' + auth,
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(body),
  }, body);
  if (!resp.json || !resp.json.access_token) {
    throw new Error('PayPal OAuth : pas de access_token (status ' + resp.status + ')');
  }
  return resp.json.access_token;
}

/* ── createOrder ──
   amount (nombre EUR), payeeEmail (string), description (string).
   Retour : { orderID, mock } — mock toujours true pendant cette phase. */
async function createOrder(params) {
  var amount = params.amount;
  var currency = params.currency || 'EUR';
  var payeeEmail = params.payeeEmail;
  var description = params.description || 'Commande Geniwork';

  if (!isRealModeActive()) {
    /* SIMULÉ — aucun appel réseau. orderID déterministe-unique, jamais
       présenté comme un vrai identifiant PayPal. */
    var mockOrderId = 'MOCK_ORDER_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
    return { orderID: mockOrderId, mock: true, status: 'CREATED' };
  }

  /* ── Mode réel (dormant, non exercé pendant cette phase) ── */
  var accessToken = await _getRealAccessToken();
  var body = JSON.stringify({
    intent: 'CAPTURE',
    purchase_units: [{
      description: description,
      amount: { currency_code: currency, value: amount.toFixed(2) },
      payee: { email_address: payeeEmail },
    }],
  });
  var resp = await _httpsJson(paypalHost(), '/v2/checkout/orders', 'POST', {
    'Authorization': 'Bearer ' + accessToken,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  }, body);
  if (!resp.json || !resp.json.id) {
    throw new Error('PayPal create order : réponse invalide (status ' + resp.status + ')');
  }
  return { orderID: resp.json.id, mock: false, status: resp.json.status };
}

/* ── captureOrder ──
   orderID (string), expectedAmount/expectedCurrency (pour le mode mock
   uniquement — la simulation échoue si elle ne peut pas répondre avec
   un montant cohérent ; le mode réel les ignore et interroge PayPal). */
async function captureOrder(params) {
  var orderID = params.orderID;

  if (!isRealModeActive()) {
    if (typeof orderID !== 'string' || orderID.indexOf('MOCK_ORDER_') !== 0) {
      /* Un orderID qui ne vient pas de notre propre createOrder() simulé
         ne peut pas être capturé en mode mock — jamais inventer un succès. */
      return { status: 'FAILED', mock: true, amount: null, currency: null, payer: 'MOCK_PAYER', captureId: null };
    }
    return {
      status: 'COMPLETED',
      mock: true,
      amount: params.expectedAmount,
      currency: params.expectedCurrency || 'EUR',
      payer: 'MOCK_PAYER',
      /* Phase PAYPAL-SUB-FIX-01 : captureId simulé, distinct de orderID —
         nécessaire pour que refund.js dispose d'un identifiant cohérent
         même en mode mock (jamais utilisé pour un vrai appel réseau). */
      captureId: 'MOCK_CAPTURE_' + Date.now(),
    };
  }

  /* ── Mode réel (dormant, non exercé pendant cette phase) ── */
  var accessToken = await _getRealAccessToken();
  var resp = await _httpsJson(paypalHost(), '/v2/checkout/orders/' + encodeURIComponent(orderID) + '/capture', 'POST', {
    'Authorization': 'Bearer ' + accessToken,
    'Content-Type': 'application/json',
    'Content-Length': 0,
  }, '');
  if (!resp.json) {
    throw new Error('PayPal capture order : réponse invalide (status ' + resp.status + ')');
  }
  var capture = resp.json.purchase_units && resp.json.purchase_units[0]
    && resp.json.purchase_units[0].payments && resp.json.purchase_units[0].payments.captures
    && resp.json.purchase_units[0].payments.captures[0];
  return {
    status: resp.json.status,
    mock: false,
    amount: capture ? Number(capture.amount.value) : null,
    currency: capture ? capture.amount.currency_code : null,
    payer: resp.json.payer ? resp.json.payer.email_address : null,
    /* Phase PAYPAL-SUB-FIX-01 : captureID réel PayPal, distinct de orderID —
       nécessaire pour l'API refund (/v2/payments/captures/{captureId}/refund),
       jamais persisté avant cette phase (champ auparavant ignoré). */
    captureId: capture ? capture.id : null,
  };
}

/* ── refundCapture ──
   captureId (string, jamais orderID). Retour : { status, mock, refundId }.
   Phase PAYPAL-SUB-FIX-01 — additif uniquement, ne modifie ni createOrder
   ni captureOrder. Remboursement intégral uniquement (pas de montant
   partiel transmis), conformément à la règle métier validée. */
async function refundCapture(params) {
  var captureId = params.captureId;

  if (!isRealModeActive()) {
    if (typeof captureId !== 'string' || captureId.indexOf('MOCK_CAPTURE_') !== 0) {
      /* Un captureId qui ne vient pas de notre propre captureOrder() simulé
         ne peut pas être remboursé en mode mock — jamais inventer un succès. */
      return { status: 'FAILED', mock: true, refundId: null };
    }
    return { status: 'COMPLETED', mock: true, refundId: 'MOCK_REFUND_' + Date.now() };
  }

  /* ── Mode réel (dormant, non exercé pendant cette phase) ── */
  var accessToken = await _getRealAccessToken();
  var resp = await _httpsJson(paypalHost(), '/v2/payments/captures/' + encodeURIComponent(captureId) + '/refund', 'POST', {
    'Authorization': 'Bearer ' + accessToken,
    'Content-Type': 'application/json',
    'Content-Length': 0,
  }, '');
  if (!resp.json || !resp.json.id) {
    throw new Error('PayPal refund : réponse invalide (status ' + resp.status + ')');
  }
  return { status: resp.json.status, mock: false, refundId: resp.json.id };
}

module.exports = { createOrder, captureOrder, refundCapture, isRealModeActive, credentialsPresent };
