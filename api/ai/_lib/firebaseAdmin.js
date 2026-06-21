/* ═══════════════════════════════════════════════════════════════
   GENIWORK-AI — Acces admin a la Realtime Database via compte de
   service (meme pattern que /api/notify.js, scope different).
   Bypass les regles de securite (.read/.write) comme firebase-admin,
   sans ajouter de dependance npm.
═══════════════════════════════════════════════════════════════ */

const https = require('https');
const crypto = require('crypto');

const DB_URL = 'https://geniwork-be35c-default-rtdb.europe-west1.firebasedatabase.app';

function getServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT non configuree dans Vercel');
  const sa = JSON.parse(raw);
  if (!sa.client_email || !sa.private_key || !sa.project_id) {
    throw new Error('Compte de service incomplet (client_email / private_key / project_id manquant)');
  }
  return sa;
}

function getGoogleAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
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
          else reject(new Error('Pas de access_token Google : ' + data));
        } catch (e) { reject(e); }
      });
    });
    r.on('error', reject);
    r.write(body);
    r.end();
  });
}

function dbRequest(method, path, accessToken, body) {
  return new Promise((resolve, reject) => {
    const url = DB_URL + path + '.json?access_token=' + accessToken;
    const payload = body !== undefined ? JSON.stringify(body) : undefined;

    const req = https.request(url, {
      method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
    }, (resp) => {
      let data = '';
      resp.on('data', (c) => (data += c));
      resp.on('end', () => {
        if (resp.statusCode >= 200 && resp.statusCode < 300) {
          try { resolve(data ? JSON.parse(data) : null); } catch (e) { resolve(null); }
        } else {
          reject(new Error('Firebase REST ' + resp.statusCode + ': ' + data));
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sanitizeEmailKey(email) {
  return String(email).toLowerCase().replace(/\./g, '__d__').replace(/@/g, '__a__');
}

let cachedToken = null;
let cachedTokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry) return cachedToken;
  const sa = getServiceAccount();
  cachedToken = await getGoogleAccessToken(sa);
  cachedTokenExpiry = Date.now() + 55 * 60 * 1000;
  return cachedToken;
}

async function readProfile(email) {
  const token = await getAccessToken();
  const key = sanitizeEmailKey(email);
  const data = await dbRequest('GET', '/gw/profiles/' + key, token);
  return { key, data: data || {} };
}

async function patchProfile(email, patch) {
  const token = await getAccessToken();
  const key = sanitizeEmailKey(email);
  await dbRequest('PATCH', '/gw/profiles/' + key, token, patch);
}

module.exports = { readProfile, patchProfile, sanitizeEmailKey };
