/* ═══════════════════════════════════════════════════════════════
   GENIWORK — Vercel Serverless Function : envoie une notification FCM
   POST /api/notify  { token, title, body, tag }
═══════════════════════════════════════════════════════════════ */

module.exports = async function handler(req, res) {
  /* CORS pour les appels depuis le navigateur */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST')    { res.status(405).json({ error: 'Method not allowed' }); return; }

  var body   = req.body || {};
  var token  = body.token;
  var title  = body.title  || 'Geniwork';
  var text   = body.body   || '';
  var tag    = body.tag    || 'geniwork';
  var icon   = body.icon   || '/img/icon-192.png';

  if (!token) { res.status(400).json({ error: 'token manquant' }); return; }

  var serverKey = process.env.FCM_SERVER_KEY;
  if (!serverKey) { res.status(500).json({ error: 'FCM_SERVER_KEY non configurée' }); return; }

  var payload = JSON.stringify({
    to: token,
    notification: {
      title: title,
      body:  text,
      icon:  icon,
      badge: '/img/icon-96.png',
      tag:   tag,
      click_action: '/'
    },
    data: { tag: tag, title: title, body: text }
  });

  try {
    var https = require('https');
    var result = await new Promise(function(resolve, reject) {
      var options = {
        hostname: 'fcm.googleapis.com',
        path:     '/fcm/send',
        method:   'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': 'key=' + serverKey
        }
      };
      var reqHttp = https.request(options, function(r) {
        var data = '';
        r.on('data', function(chunk) { data += chunk; });
        r.on('end',  function() { resolve({ status: r.statusCode, body: data }); });
      });
      reqHttp.on('error', reject);
      reqHttp.write(payload);
      reqHttp.end();
    });
    res.status(200).json({ ok: true, fcm: result.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
