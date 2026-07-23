/* ═══════════════════════════════════════════════════════════════
   GENIWORK — POST /api/auth/google-token
   Etape 3 de la migration d'authentification : verifie une connexion
   Google CÔTÉ SERVEUR (jamais l'email fourni par le navigateur, qui
   pourrait etre falsifie) puis renvoie un Firebase Custom Token avec
   uid = _gwFbKey(email verifie) — meme principe que /api/auth/token.js
   pour email+mot de passe.

   Body: { credential } (JWT One Tap/GIS credential)
      OU { accessToken } (jeton OAuth GIS fallback / Capacitor natif)

   - credential  → verifie via oauth2.googleapis.com/tokeninfo?id_token=
   - accessToken → verifie en appelant googleapis userinfo (echoue si
                   le jeton n'est pas un vrai jeton Google valide)
═══════════════════════════════════════════════════════════════ */

const crypto = require('crypto');
const { emailKey } = require('../admin/_lib/fbrest');
const { sign: signRefreshToken } = require('./_lib/refreshToken');

function getServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT non configuree dans Vercel');
  const sa = JSON.parse(raw);
  if (!sa.client_email || !sa.private_key) throw new Error('Compte de service incomplet');
  return sa;
}

function signCustomToken(uid, sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: sa.client_email,
    sub: sa.client_email,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat: now,
    exp: now + 3600,
    uid: uid,
  };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = b64(header) + '.' + b64(payload);
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(unsigned);
  const sig = sign.sign(sa.private_key, 'base64url');
  return unsigned + '.' + sig;
}

/* Verifie un ID token Google (JWT signe par Google) via l'endpoint
   tokeninfo officiel — Google valide signature + expiration pour nous. */
async function verifyIdToken(idToken) {
  const resp = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
  if (!resp.ok) return null;
  const data = await resp.json();
  if (!data || !data.email) return null;
  return { email: String(data.email).toLowerCase(), verified: data.email_verified === 'true' || data.email_verified === true };
}

/* Verifie un access token Google en recuperant le profil associe —
   si Google repond avec un profil valide, le jeton est authentique. */
async function verifyAccessToken(accessToken) {
  const resp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: 'Bearer ' + accessToken },
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  if (!data || !data.email) return null;
  return { email: String(data.email).toLowerCase(), verified: data.email_verified === true || data.email_verified === 'true' };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const body = req.body || {};

    let verified = null;
    if (body.credential) {
      verified = await verifyIdToken(String(body.credential));
    } else if (body.accessToken) {
      verified = await verifyAccessToken(String(body.accessToken));
    }

    if (!verified || !verified.email) {
      res.status(401).json({ error: 'Jeton Google invalide ou expire' });
      return;
    }

    const sa = getServiceAccount();
    const uid = emailKey(verified.email);
    const token = signCustomToken(uid, sa);
    const refreshToken = signRefreshToken(verified.email);

    res.status(200).json({ ok: true, token: token, uid: uid, email: verified.email, refreshToken: refreshToken });
  } catch (err) {
    console.error('[Geniwork Auth] erreur google-token:', err.message);
    res.status(500).json({ error: err.message });
  }
};
