/* ═══════════════════════════════════════════════════════════════
   GENIWORK — POST /api/auth/refresh
   Etape 4 migration auth : echange un jeton de renouvellement longue
   duree (obtenu lors d'un login/inscription/connexion Google reussi)
   contre un nouveau Firebase Custom Token, sans redemander le mot de
   passe. Utilise par la reconnexion automatique au demarrage de l'app.

   Body: { refreshToken }
═══════════════════════════════════════════════════════════════ */

const crypto = require('crypto');
const { emailKey } = require('../admin/_lib/fbrest');
const { verify, sign } = require('./_lib/refreshToken');

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
  const s = crypto.createSign('RSA-SHA256');
  s.update(unsigned);
  const sig = s.sign(sa.private_key, 'base64url');
  return unsigned + '.' + sig;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const body = req.body || {};
    const data = verify(body.refreshToken);
    if (!data || !data.email) { res.status(401).json({ error: 'Jeton de renouvellement invalide ou expire' }); return; }

    const sa = getServiceAccount();
    const uid = emailKey(data.email);
    const token = signCustomToken(uid, sa);
    /* Renouvelle aussi le jeton de renouvellement lui-meme (glissant) */
    const refreshToken = sign(data.email);

    res.status(200).json({ ok: true, token: token, uid: uid, refreshToken: refreshToken });
  } catch (err) {
    console.error('[Geniwork Auth] erreur refresh:', err.message);
    res.status(500).json({ error: err.message });
  }
};
