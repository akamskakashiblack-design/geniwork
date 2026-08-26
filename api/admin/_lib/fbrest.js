/* ═══════════════════════════════════════════════════════════════
   GENIWORK — Acces Realtime Database via compte de service
   (meme pattern que api/notify.js et api/ai/_lib/firebaseAdmin.js).
   Bypass les regles .read/.write, reserve aux endpoints /api/admin/*.
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

/* ── Phase 6B-5 : écritures conditionnelles (ETag / If-Match) ──
   Additif uniquement — dbGet/dbSet/dbUpdate/dbRemove et dbRequest()
   restent inchangés, aucun des appelants existants n'est affecté.
   Permet un vrai "compare-and-swap" via l'API REST Firebase (le SDK
   Admin officiel expose .transaction(), inaccessible depuis ce canal
   REST ; le mécanisme ETag/If-Match est l'équivalent documenté par
   Firebase pour REST) — utilisé pour empêcher qu'une même commande
   Marketplace (gw/mk_pending_orders/{orderID}) soit capturée deux fois
   en cas de requêtes concurrentes/rejouées (Phase 6B-5). */
function dbRequestWithHeaders(method, path, accessToken, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const url = DB_URL + path + '.json?access_token=' + accessToken;
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const headers = Object.assign(
      payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      extraHeaders || {}
    );

    const req = https.request(url, { method, headers }, (resp) => {
      let data = '';
      resp.on('data', (c) => (data += c));
      resp.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch (e) { /* laisse parsed=null */ }
        resolve({ status: resp.statusCode, etag: resp.headers['etag'] || null, value: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/* Lit un chemin en demandant à Firebase de renvoyer son ETag actuel
   (nécessaire pour une écriture conditionnelle ultérieure au même
   chemin exact). */
async function dbGetWithETag(path) {
  const token = await getAccessToken();
  const r = await dbRequestWithHeaders('GET', path, token, undefined, { 'X-Firebase-ETag': 'true' });
  if (r.status < 200 || r.status >= 300) throw new Error('Firebase REST ' + r.status + ' (dbGetWithETag)');
  return { value: r.value, etag: r.etag };
}

/* Écrit un chemin UNIQUEMENT si son ETag actuel correspond encore à
   celui fourni (sinon 412 Precondition Failed — quelqu'un d'autre a
   déjà modifié ce chemin entre-temps). Retourne { ok:true } en cas de
   succès, { ok:false, conflict:true, currentValue } en cas de conflit —
   ne lève jamais d'exception pour un conflit, seulement pour une
   vraie erreur serveur. */
async function dbSetIfMatch(path, value, etag) {
  const token = await getAccessToken();
  const r = await dbRequestWithHeaders('PUT', path, token, value === undefined ? null : value, { 'if-match': etag });
  if (r.status === 412) return { ok: false, conflict: true, currentValue: r.value };
  if (r.status < 200 || r.status >= 300) throw new Error('Firebase REST ' + r.status + ' (dbSetIfMatch)');
  return { ok: true };
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

function emailKey(email) {
  return String(email || '').toLowerCase()
    .replace(/\./g, '__d__')
    .replace(/@/g, '__a__')
    .replace(/[#$[\]/]/g, '_');
}

async function dbGet(path) {
  const token = await getAccessToken();
  return dbRequest('GET', path, token);
}

async function dbSet(path, value) {
  const token = await getAccessToken();
  return dbRequest('PUT', path, token, value === undefined ? null : value);
}

async function dbUpdate(path, patch) {
  const token = await getAccessToken();
  return dbRequest('PATCH', path, token, patch);
}

async function dbRemove(path) {
  const token = await getAccessToken();
  return dbRequest('DELETE', path, token);
}

/* ── Phase 9C : ajoute UNE notification en tête de gw/notifs/{targetEmailKey}
   (limite 50, même sémantique que le client saveNotifs()/pushNotif()),
   via écriture conditionnelle ETag (dbGetWithETag/dbSetIfMatch, déjà
   utilisé Phase 6B-5) pour éviter qu'un envoi concurrent vers la même
   boîte n'écrase l'autre (pattern "lire tout → modifier → réécrire tout"
   identifié comme la seule vraie faiblesse du modèle tableau, cf. audit
   Phase 9C.5). Quelques tentatives avec retry en cas de conflit 412 ;
   après épuisement, échoue silencieusement (la notification n'est alors
   pas créée) plutôt que de risquer d'écraser une notification concurrente
   — comportement volontairement conservateur, une notification manquée
   est un défaut mineur, une notification perdue-par-écrasement l'est
   aussi mais ce mécanisme réduit fortement les deux risques. */
/* dedupPredicate optionnel(existingNotif) => true : retire les entrées
   existantes correspondantes avant d'ajouter la nouvelle (reproduit le
   dédoublonnage déjà présent côté client pour "follow" — évite deux
   notifications "X a commencé à vous suivre" en cas de
   désabonnement/réabonnement rapide, cf. Phase 9C). */
async function appendNotification(targetEmailKey, notif, dedupPredicate) {
  const path = '/gw/notifs/' + targetEmailKey;
  for (let attempt = 0; attempt < 6; attempt++) {
    let current;
    try { current = await dbGetWithETag(path); } catch (e) { return false; }
    let list = Array.isArray(current.value) ? current.value.slice() : [];
    if (typeof dedupPredicate === 'function') list = list.filter((n) => !dedupPredicate(n));
    list.unshift(notif);
    if (list.length > 50) list = list.slice(0, 50);
    let result;
    try { result = await dbSetIfMatch(path, list, current.etag); } catch (e) { return false; }
    if (result.ok) return true;
    /* conflit (412) : quelqu'un d'autre a écrit entre-temps, on relit et retente */
  }
  return false;
}

/* ── Phase 9D : version generalisee de appendNotification, pour tout
   chemin stockant un TABLEAU protege par ecriture conditionnelle ETag
   (meme pattern "lire tout -> modifier -> reecrire tout" que gw/notifs,
   desormais aussi gw/collab_requests et gw/collab_invites/{uid}).
   `mutateFn(list)` recoit une COPIE du tableau actuel et doit retourner
   soit le NOUVEAU tableau a ecrire, soit `null` pour abandonner sans
   ecrire (ex. la mutation n'est plus valide apres relecture — deja
   candidat, deja invite pour ce projet, etc.). Retry sur conflit 412
   jusqu'a 6 tentatives, memes garanties que appendNotification. */
async function mutateArrayAtPath(path, mutateFn) {
  for (let attempt = 0; attempt < 6; attempt++) {
    let current;
    try { current = await dbGetWithETag(path); } catch (e) { return { ok: false, reason: 'read_failed' }; }
    const list = Array.isArray(current.value) ? current.value.slice() : [];
    const next = mutateFn(list);
    if (next === null) return { ok: false, reason: 'aborted' };
    let result;
    try { result = await dbSetIfMatch(path, next, current.etag); } catch (e) { return { ok: false, reason: 'write_failed' }; }
    if (result.ok) return { ok: true, list: next };
  }
  return { ok: false, reason: 'conflict' };
}

module.exports = { dbGet, dbSet, dbUpdate, dbRemove, emailKey, dbGetWithETag, dbSetIfMatch, appendNotification, mutateArrayAtPath };
