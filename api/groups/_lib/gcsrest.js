/* ═══════════════════════════════════════════════════════════════
   GENIWORK — Acces Cloud Storage via le meme compte de service que
   api/admin/_lib/fbrest.js (FIREBASE_SERVICE_ACCOUNT), scope Storage
   distinct du scope Realtime Database. Sert exclusivement les
   endpoints /api/groups/cover-*.js (Phase GROUPS-FREE-04 etape 2).

   Choix architectural : la couverture de groupe reste un chemin
   PRIVE (storage.rules : allow read/write:false via le fallback
   deny-all existant, aucune regle dediee ajoutee — voir storage.rules
   pour l'audit complet). Storage Rules ne peut pas interroger la RTDB
   (aucun equivalent de root.child() cote Storage, limitation deja
   documentee pour chat_images/chat_videos/chat_docs) : une regle
   Storage ne peut donc PAS honnetement verifier "est membre du
   groupe X". Seul un acces server-side (ce module, compte de
   service, bypass total des Storage Rules comme des RTDB Rules) peut
   appliquer la permission reelle proprietaire/admin en ecriture et
   membre en lecture — d'ou le choix de ne jamais exposer d'URL
   Storage directe au client, uniquement des octets transmis via les
   endpoints apres verification d'appartenance.
═══════════════════════════════════════════════════════════════ */

const https = require('https');
const crypto = require('crypto');

const BUCKET = 'geniwork-be35c.firebasestorage.app';

function getServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT non configuree dans Vercel');
  const sa = JSON.parse(raw);
  if (!sa.client_email || !sa.private_key || !sa.project_id) {
    throw new Error('Compte de service incomplet (client_email / private_key / project_id manquant)');
  }
  return sa;
}

function getGoogleAccessToken(sa, scope) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: scope,
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  })).toString('base64url');

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(header + '.' + payload);
  const sig = sign.sign(sa.private_key, 'base64url');
  const jwt = header + '.' + payload + '.' + sig;

  const body = 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt;

  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const r = https.request(opts, (resp) => {
      let data = '';
      resp.on('data', (c) => (data += c));
      resp.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) resolve(json.access_token);
          else reject(new Error('Pas de access_token Google (storage) : ' + data));
        } catch (e) { reject(e); }
      });
    });
    r.on('error', reject);
    r.write(body);
    r.end();
  });
}

let cachedToken = null;
let cachedTokenExpiry = 0;

async function getStorageAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry) return cachedToken;
  const sa = getServiceAccount();
  cachedToken = await getGoogleAccessToken(sa, 'https://www.googleapis.com/auth/devstorage.read_write');
  cachedTokenExpiry = Date.now() + 55 * 60 * 1000;
  return cachedToken;
}

function gcsRequest(method, path, accessToken, headers, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'storage.googleapis.com',
      path: path,
      method: method,
      headers: Object.assign({ Authorization: 'Bearer ' + accessToken }, headers || {}),
    };
    const req = https.request(opts, (resp) => {
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => {
        resolve({ status: resp.statusCode, body: Buffer.concat(chunks), headers: resp.headers });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/* Ecrit (cree ou remplace) un objet. objectPath ex: 'group_covers/gw_grp_.../cover.jpg'. */
async function gcsUpload(objectPath, buffer, contentType) {
  const token = await getStorageAccessToken();
  const path = '/upload/storage/v1/b/' + encodeURIComponent(BUCKET) + '/o?uploadType=media&name=' + encodeURIComponent(objectPath);
  const r = await gcsRequest('POST', path, token, { 'Content-Type': contentType, 'Content-Length': buffer.length }, buffer);
  if (r.status < 200 || r.status >= 300) {
    throw new Error('GCS upload ' + r.status + ': ' + r.body.toString('utf8').slice(0, 300));
  }
  return true;
}

/* Supprime un objet. Tolerant : 404 traite comme succes (idempotence). */
async function gcsDelete(objectPath) {
  const token = await getStorageAccessToken();
  const path = '/storage/v1/b/' + encodeURIComponent(BUCKET) + '/o/' + encodeURIComponent(objectPath);
  const r = await gcsRequest('DELETE', path, token, {});
  if (r.status !== 204 && r.status !== 404 && (r.status < 200 || r.status >= 300)) {
    throw new Error('GCS delete ' + r.status + ': ' + r.body.toString('utf8').slice(0, 300));
  }
  return true;
}

/* Lit un objet. Retourne null si absent (404) plutot que de lever. */
async function gcsDownload(objectPath) {
  const token = await getStorageAccessToken();
  const path = '/storage/v1/b/' + encodeURIComponent(BUCKET) + '/o/' + encodeURIComponent(objectPath) + '?alt=media';
  const r = await gcsRequest('GET', path, token, {});
  if (r.status === 404) return null;
  if (r.status < 200 || r.status >= 300) {
    throw new Error('GCS download ' + r.status + ': ' + r.body.toString('utf8').slice(0, 300));
  }
  const contentType = r.headers['content-type'] || 'application/octet-stream';
  return { buffer: r.body, contentType: contentType };
}

module.exports = { gcsUpload, gcsDelete, gcsDownload, BUCKET };
