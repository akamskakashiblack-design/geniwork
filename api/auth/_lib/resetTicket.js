/* ═══════════════════════════════════════════════════════════════
   GENIWORK — Jeton de reset courte duree (etape 5D securisation reset)
   Emis par /api/auth/reset-check-code UNIQUEMENT apres verification
   serveur du code — presente ensuite a /api/auth/reset-apply pour
   appliquer le nouveau mot de passe. Ne contient jamais le code ni
   le mot de passe. Meme principe de signature que _lib/refreshToken.js
   (HMAC-SHA256, comparaison timing-safe), duree de vie tres courte
   (5 minutes) car il ne sert qu'a relier les deux etapes d'un meme
   flux de reset, jamais stocke en localStorage cote client (variable
   JS en memoire uniquement, perdue au rechargement — comportement
   volontaire, identique a l'ancien _resetCode).
   Variable Vercel requise : AUTH_REFRESH_SECRET (reutilisee — meme
   niveau de confiance qu'un jeton de session, pas besoin d'un secret
   distinct supplementaire).
═══════════════════════════════════════════════════════════════ */

const crypto = require('crypto');

const TICKET_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getSecret() {
  const secret = process.env.AUTH_REFRESH_SECRET;
  if (!secret) throw new Error('AUTH_REFRESH_SECRET non configuree dans Vercel');
  return secret;
}

function sign(email) {
  const secret = getSecret();
  const payloadObj = { email: email, purpose: 'reset', exp: Date.now() + TICKET_TTL_MS };
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return payload + '.' + sig;
}

function verify(ticket) {
  if (!ticket || typeof ticket !== 'string') return null;
  const idx = ticket.lastIndexOf('.');
  if (idx < 0) return null;

  const payload = ticket.slice(0, idx);
  const sig = ticket.slice(idx + 1);

  let secret;
  try { secret = getSecret(); } catch (e) { return null; }

  const expectedSig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch (e) { return null; }
  if (data.purpose !== 'reset') return null;
  if (!data.exp || Date.now() > data.exp) return null;

  return data;
}

module.exports = { sign, verify };
