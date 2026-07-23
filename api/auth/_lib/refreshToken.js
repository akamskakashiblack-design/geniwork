/* ═══════════════════════════════════════════════════════════════
   GENIWORK — Jeton de renouvellement longue duree (etape 4 migration
   auth : "reconnexion automatique" sans redemander le mot de passe).
   Format : "<payload_base64url>.<signature_base64url>" (HMAC-SHA256).
   Variable Vercel requise : AUTH_REFRESH_SECRET (chaine aleatoire longue,
   DIFFERENTE de ADMIN_SESSION_SECRET pour ne pas partager de secret
   entre le panneau admin et les comptes utilisateurs normaux).
═══════════════════════════════════════════════════════════════ */

const crypto = require('crypto');

const REFRESH_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 jours

function getSecret() {
  const secret = process.env.AUTH_REFRESH_SECRET;
  if (!secret) throw new Error('AUTH_REFRESH_SECRET non configuree dans Vercel');
  return secret;
}

function sign(email) {
  const secret = getSecret();
  const payloadObj = { email: email, exp: Date.now() + REFRESH_TTL_MS };
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return payload + '.' + sig;
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const idx = token.lastIndexOf('.');
  if (idx < 0) return null;

  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);

  let secret;
  try { secret = getSecret(); } catch (e) { return null; }

  const expectedSig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch (e) { return null; }
  if (!data.exp || Date.now() > data.exp) return null;

  return data;
}

module.exports = { sign, verify };
