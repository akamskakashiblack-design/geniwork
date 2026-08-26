/* ═══════════════════════════════════════════════════════════════
   GENIWORK — Conversion de devise serveur (Phase 6B-4)
   Miroir exact de _gwConvertToEUR()/_GW_XOF_PER_EUR (js/app.js) —
   même repli, même source, mais exécuté côté serveur pour que le
   montant PayPal ne dépende plus jamais d'une valeur calculée par
   le navigateur.
═══════════════════════════════════════════════════════════════ */

const https = require('https');

const XOF_PER_EUR = 655.957; /* Taux fixe — le Franc CFA est arrimé à l'euro */
const FALLBACK_USD_EUR = 0.92;

var _rateCache = null;
var _rateCacheAt = 0;

function _getUsdEurRate() {
  var now = Date.now();
  if (_rateCache && (now - _rateCacheAt) < 3600000) return Promise.resolve(_rateCache);
  return new Promise(function (resolve) {
    var req = https.get('https://api.frankfurter.app/latest?from=USD&to=EUR', function (resp) {
      var data = '';
      resp.on('data', function (c) { data += c; });
      resp.on('end', function () {
        try {
          var json = JSON.parse(data);
          if (json && json.rates && json.rates.EUR) {
            _rateCache = json.rates.EUR;
            _rateCacheAt = now;
            resolve(_rateCache);
            return;
          }
        } catch (e) { /* repli ci-dessous */ }
        resolve(FALLBACK_USD_EUR);
      });
    });
    req.on('error', function () { resolve(FALLBACK_USD_EUR); });
    req.setTimeout(4000, function () { req.destroy(); resolve(FALLBACK_USD_EUR); });
  });
}

async function convertToEUR(amount, currency) {
  amount = Number(amount) || 0;
  if (!currency || currency === 'EUR') return amount;
  if (currency === 'XOF') return amount / XOF_PER_EUR;
  if (currency === 'USD') {
    var rate = await _getUsdEurRate();
    return amount * rate;
  }
  return amount;
}

module.exports = { convertToEUR };
