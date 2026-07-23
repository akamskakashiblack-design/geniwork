/* ═══════════════════════════════════════════════════════════════
   GENIWORK — Jeton de session admin signe (HMAC-SHA256)
   Format : "<payload_base64url>.<signature_base64url>"
   Variable Vercel requise : ADMIN_SESSION_SECRET (chaine aleatoire longue)
═══════════════════════════════════════════════════════════════ */

const crypto = require('crypto');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

function getSecret() {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) throw new Error('ADMIN_SESSION_SECRET non configuree dans Vercel');
  return secret;
}

function sign(user) {
  const secret = getSecret();
  const payloadObj = { email: user.email, nom: user.nom, role: user.role, exp: Date.now() + SESSION_TTL_MS };
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
