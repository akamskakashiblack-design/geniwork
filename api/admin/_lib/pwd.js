/* ═══════════════════════════════════════════════════════════════
   GENIWORK — Hachage / verification de mot de passe (admin panel)
   Compatible avec le format cote client : "pbkdf2:<sel_hex>:<hash_hex>"
   (PBKDF2, 50 000 iterations, SHA-256, 256 bits — meme parametres
   que _gwHashPwd() dans www/js/app.js).
═══════════════════════════════════════════════════════════════ */

const crypto = require('crypto');

const ITERATIONS = 50000;
const KEY_LEN = 32; // 256 bits
const DIGEST = 'sha256';

function hashPwd(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LEN, DIGEST).toString('hex');
  return 'pbkdf2:' + salt.toString('hex') + ':' + hash;
}

function verifyPwd(password, stored) {
  if (!stored) return false;

  if (stored.indexOf('pbkdf2:') !== 0) {
    // Ancien format texte brut (migration transparente, comme cote client)
    const a = Buffer.from(String(password));
    const b = Buffer.from(String(stored));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  const parts = stored.split(':');
  if (parts.length !== 3) return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');

  const computed = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LEN, DIGEST);
  if (computed.length !== expected.length) return false;
  return crypto.timingSafeEqual(computed, expected);
}

module.exports = { hashPwd, verifyPwd };
