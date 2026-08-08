/* ═══════════════════════════════════════════════════════════════
   GENIWORK — Firebase Custom Token avec claims admin
   Utilisé par /api/admin/login et /api/admin/setup pour émettre
   un token permettant à l'admin de s'authentifier auprès de
   Firebase RTDB avec le claim gw_admin === true (PERM-1).
═══════════════════════════════════════════════════════════════ */

const crypto = require('crypto');

function getServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT non configuree dans Vercel');
  const sa = JSON.parse(raw);
  if (!sa.client_email || !sa.private_key) throw new Error('Compte de service incomplet');
  return sa;
}

/* Emet un Firebase Custom Token RS256 avec { claims: { gw_admin: true } }.
   uid = emailKey(email).
   Le claim gw_admin est vérifiable dans les Firebase Rules via auth.token.gw_admin. */
function signAdminFirebaseToken(uid) {
  const sa = getServiceAccount();
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss:    sa.client_email,
    sub:    sa.client_email,
    aud:    'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat:    now,
    exp:    now + 3600,
    uid:    uid,
    claims: { gw_admin: true },
  };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = b64(header) + '.' + b64(payload);
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(unsigned);
  const sig = sign.sign(sa.private_key, 'base64url');
  return unsigned + '.' + sig;
}

module.exports = { signAdminFirebaseToken };
