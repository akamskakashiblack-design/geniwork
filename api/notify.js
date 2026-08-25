/* ═══════════════════════════════════════════════════════════════
   GENIWORK — Vercel Serverless Function : envoie une notification FCM
   POST /api/notify  { token, title, body, tag }

   Utilise FCM HTTP v1 API (l'ancienne API Legacy /fcm/send est
   arrêtée par Google depuis juin 2024).

   Variable Vercel requise : FIREBASE_SERVICE_ACCOUNT
   → Valeur : contenu JSON du fichier de clé de compte de service
   → Firebase Console → Project Settings → Service Accounts
     → Generate new private key → copier le JSON complet

   ── Phase 9F-BIS-TER-QUINQUIES ──────────────────────────────────
   POST /api/notify  { eventType: 'group_inbox', authRefreshToken, ... }
   Consolidation de l'ancien endpoint dédié api/group-inbox-notify.js
   dans celui-ci, pour rester sous la limite de 12 Serverless Functions
   du plan Vercel Hobby (le bundle group_inboxes aurait été la 13e).
   Branche AJOUTÉE, entièrement séparée : elle sort (return) avant
   toute ligne du chemin FCM existant ci-dessous, qui reste inchangé
   au caractère près. Le chemin FCM ne fournit jamais eventType, donc
   aucune collision possible avec les appels existants (_gwSendPushNotif,
   seul appelant réel de /api/notify, envoie {token,title,body,tag}).
   Logique métier identique à l'ancien api/group-inbox-notify.js —
   voir ce fichier (conservé jusqu'à validation complète) pour le
   détail du raisonnement sécurité. ── */
const { dbGet, emailKey, mutateArrayAtPath } = require('./admin/_lib/fbrest');
const { verify: verifyRefreshToken } = require('./auth/_lib/refreshToken');

const GI_MAX_STR = 300;

function _giIsValidEmail(v) {
  return typeof v === 'string' && v.length > 0 && v.length < GI_MAX_STR && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

/* Reproduit exactement _collabGroupFbKey(projId, ownerEmail) côté client
   (js/app.js) — même transformation, même clé Firebase. */
function _giCollabGroupFbKey(projId, ownerEmail) {
  var base = 'gw_grp_' + String(projId).replace(/[^a-z0-9]/gi, '_') +
             '___' + String(ownerEmail).replace(/[^a-z0-9@._-]/gi, '_');
  return base.replace(/\./g, '__d__').replace(/@/g, '__a__');
}

async function _handleGroupInboxNotify(req, res, body) {
  try {
    const ticketData = verifyRefreshToken(body.authRefreshToken);
    if (!ticketData || !ticketData.email) {
      res.status(401).json({ ok: false, error: 'Session expirée, reconnectez-vous.' });
      return;
    }
    const callerEmail = ticketData.email;

    const projId = body.projId;
    const ownerEmail = body.ownerEmail;
    const targetEmail = body.targetEmail;
    const groupMeta = body.groupMeta;

    if (!projId || typeof projId !== 'string' || projId.length > GI_MAX_STR) {
      res.status(400).json({ ok: false, error: 'projId invalide' });
      return;
    }
    if (!_giIsValidEmail(ownerEmail) || !_giIsValidEmail(targetEmail)) {
      res.status(400).json({ ok: false, error: 'ownerEmail/targetEmail invalide' });
      return;
    }
    if (targetEmail === callerEmail) {
      res.status(400).json({ ok: false, error: 'Impossible de notifier sa propre boîte' });
      return;
    }
    if (!groupMeta || typeof groupMeta !== 'object') {
      res.status(400).json({ ok: false, error: 'groupMeta invalide' });
      return;
    }

    /* ── Vérification serveur d'appartenance — lecture fraîche, jamais
       déduite d'un état client potentiellement pas encore synchronisé.
       L'identité de l'appelant vient UNIQUEMENT du token (callerEmail
       ci-dessus) — projId/ownerEmail/targetEmail ne servent qu'à
       construire le chemin à lire, jamais comme preuve d'appartenance. ── */
    const fbGrpKey = _giCollabGroupFbKey(projId, ownerEmail);
    let members;
    try { members = await dbGet('/gw/group_msgs/' + fbGrpKey + '/meta/members'); } catch (e) {
      res.status(500).json({ ok: false, error: 'Erreur serveur' });
      return;
    }
    const callerUid = emailKey(callerEmail);
    const targetUid = emailKey(targetEmail);
    if (!members || members[callerUid] !== true) {
      res.status(403).json({ ok: false, error: 'Vous n\'êtes pas membre de ce groupe' });
      return;
    }
    if (members[targetUid] !== true) {
      res.status(403).json({ ok: false, error: 'Le destinataire n\'est pas membre de ce groupe' });
      return;
    }

    /* ── Métadonnées d'affichage — champs bénins (nom, avatar, horodatage),
       jamais utilisés pour une décision de sécurité. id/projId/projOwnerEmail
       dérivés des paramètres déjà vérifiés serveur, jamais du corps brut. ── */
    const safeMeta = {
      id: typeof groupMeta.id === 'string' || typeof groupMeta.id === 'number' ? groupMeta.id : '',
      projId: projId,
      projOwnerEmail: ownerEmail,
      name: typeof groupMeta.name === 'string' ? groupMeta.name.slice(0, GI_MAX_STR) : '',
      avatar: groupMeta.avatar && typeof groupMeta.avatar === 'object' ? groupMeta.avatar : null,
      members: Array.isArray(groupMeta.members) ? groupMeta.members : null,
      at: Number.isFinite(groupMeta.at) ? groupMeta.at : Date.now(),
      time: typeof groupMeta.time === 'string' ? groupMeta.time.slice(0, 50) : '',
      lastMsg: typeof groupMeta.lastMsg === 'string' ? groupMeta.lastMsg.slice(0, GI_MAX_STR) : '',
      lastAt: Number.isFinite(groupMeta.lastAt) ? groupMeta.lastAt : Date.now(),
    };

    /* Même dédoublonnage que _writeGroupInbox (projId+projOwnerEmail),
       via mutateArrayAtPath (lire→modifier→réécrire conditionnel ETag)
       pour éviter qu'une notification concurrente vers la même boîte
       n'en écrase une autre. */
    const result = await mutateArrayAtPath('/gw/group_inboxes/' + targetUid, function(list) {
      const idx = list.findIndex(function(g) {
        return g && g.projId === safeMeta.projId && g.projOwnerEmail === safeMeta.projOwnerEmail;
      });
      if (idx === -1) list.push(safeMeta);
      else list[idx] = Object.assign({}, list[idx], safeMeta);
      return list;
    });

    if (!result.ok) {
      res.status(500).json({ ok: false, error: 'Erreur serveur (conflit d\'écriture)' });
      return;
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[Geniwork] erreur notify(group_inbox):', err.message);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST')    { res.status(405).json({ error: 'Method not allowed' }); return; }

  var body  = req.body || {};

  /* Phase 9F-BIS-TER-QUINQUIES : branche group_inbox, sortie immédiate,
     avant toute ligne du chemin FCM existant ci-dessous (inchangé). */
  if (body.eventType === 'group_inbox') { return _handleGroupInboxNotify(req, res, body); }

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
