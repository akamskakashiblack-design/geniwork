/* ═══════════════════════════════════════════════════════════════
   GENIWORK — Vercel Serverless Function : envoie une notification FCM
   POST /api/notify  { token, title, body, tag }

   Utilise FCM HTTP v1 API (l'ancienne API Legacy /fcm/send est
   arrêtée par Google depuis juin 2024).

   Variable Vercel requise : FIREBASE_SERVICE_ACCOUNT
   → Valeur : contenu JSON du fichier de clé de compte de service
   → Firebase Console → Project Settings → Service Accounts
     → Generate new private key → copier le JSON complet
═══════════════════════════════════════════════════════════════ */

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST')    { res.status(405).json({ error: 'Method not allowed' }); return; }

  var body  = req.body || {};
  var token = body.token;
  var title = body.title || 'Geniwork';
  var text  = body.body  || '';
  var tag   = body.tag   || 'geniwork';
  var icon  = body.icon  || '/img/icon-192.png';

  if (!token) { res.status(400).json({ error: 'token manquant' }); return; }

  var saJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!saJson) {
    res.status(500).json({ error: 'FIREBASE_SERVICE_ACCOUNT non configurée dans Vercel' });
    return;
  }

  var sa;
  try { sa = JSON.parse(saJson); } catch (e) {
    res.status(500).json({ error: 'FIREBASE_SERVICE_ACCOUNT JSON invalide : ' + e.message });
    return;
  }

  if (!sa.client_email || !sa.private_key || !sa.project_id) {
    res.status(500).json({ error: 'Compte de service incomplet (client_email / private_key / project_id manquant)' });
    return;
  }

  try {
    var accessToken = await _getGoogleAccessToken(sa);

    var message = {
      message: {
        token: token,
        notification: {
          title: title,
          body:  text
        },
        webpush: {
          notification: {
            icon:  icon,
            badge: '/img/icon-96.png',
            tag:   tag
          },
          fcm_options: { link: '/' }
        },
        data: {
          tag:   tag,
          title: title,
          body:  text
        }
      }
    };

    var https   = require('https');
    var payload = JSON.stringify(message);

    var result = await new Promise(function(resolve, reject) {
      var opts = {
        hostname: 'fcm.googleapis.com',
        path:     '/v1/projects/' + sa.project_id + '/messages:send',
        method:   'POST',
        headers: {
          'Content-Type':   'application/json',
          'Authorization':  'Bearer ' + accessToken
        }
      };
      var r = https.request(opts, function(resp) {
        var data = '';
        resp.on('data', function(c) { data += c; });
        resp.on('end',  function() { resolve({ status: resp.statusCode, body: data }); });
      });
      r.on('error', reject);
      r.write(payload);
      r.end();
    });

    if (result.status >= 200 && result.status < 300) {
      console.log('[Geniwork] ✅ FCM v1 OK — status:', result.status);
      res.status(200).json({ ok: true, fcm: result.status });
    } else {
      console.error('[Geniwork] ❌ FCM v1 erreur', result.status, ':', result.body);
      res.status(502).json({ error: 'FCM erreur ' + result.status, detail: result.body });
    }

  } catch (err) {
    console.error('[Geniwork] ❌ Erreur notify:', err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── Génère un access token Google via JWT (RS256) + échange OAuth2 ── */
async function _getGoogleAccessToken(sa) {
  var crypto = require('crypto');
  var https  = require('https');

  var now     = Math.floor(Date.now() / 1000);
  var header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  var payload = Buffer.from(JSON.stringify({
    iss:   sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud:   'https://oauth2.googleapis.com/token',
    exp:   now + 3600,
    iat:   now
  })).toString('base64url');

  var sign = crypto.createSign('RSA-SHA256');
  sign.update(header + '.' + payload);
  var sig = sign.sign(sa.private_key, 'base64url');
  var jwt = header + '.' + payload + '.' + sig;

  var body = 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt;

  return new Promise(function(resolve, reject) {
    var opts = {
      hostname: 'oauth2.googleapis.com',
      path:     '/token',
      method:   'POST',
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    var r = https.request(opts, function(resp) {
      var data = '';
      resp.on('data', function(c) { data += c; });
      resp.on('end', function() {
        try {
          var json = JSON.parse(data);
          if (json.access_token) {
            resolve(json.access_token);
          } else {
            reject(new Error('Pas de access_token Google : ' + data));
          }
        } catch (e) { reject(e); }
      });
    });
    r.on('error', reject);
    r.write(body);
    r.end();
  });
}
