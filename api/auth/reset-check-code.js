/* ═══════════════════════════════════════════════════════════════
   GENIWORK — POST /api/auth/reset-check-code
   Étape 5D : vérifie le code de réinitialisation ENTIÈREMENT côté
   serveur (remplace la comparaison `entered !== _resetCode` qui
   existait dans le navigateur). Remplace le code, une fois vérifié
   avec succès, par un jeton de reset signé à très courte durée de vie
   (voir _lib/resetTicket.js) — jamais le code lui-même n'est renvoyé
   ni ne transite une seconde fois.

   Body: { email, code }
   Réponse succès : { ok:true, resetTicket }
   Réponse échec  : { ok:false } — TOUJOURS le même message générique,
   que ce soit un code faux, expiré, déjà utilisé, ou un compte
   inexistant — aucune information ne permet de distinguer ces cas.
═══════════════════════════════════════════════════════════════ */

const crypto = require('crypto');
const { dbGet, dbUpdate, dbRemove, emailKey } = require('../admin/_lib/fbrest');
const { sign: signResetTicket } = require('./_lib/resetTicket');

const MAX_ATTEMPTS = 5;
const GENERIC_FAIL = { ok: false, error: 'Code invalide ou expiré' };

function hashCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function timingSafeStrEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const body = req.body || {};
    const email = String(body.email || '').trim().toLowerCase();
    const code = String(body.code || '').trim();

    if (!email || !code) { res.status(200).json(GENERIC_FAIL); return; }

    const uid = emailKey(email);
    const resetPath = '/gw/password_resets/' + uid;

    const record = await dbGet(resetPath);
    if (!record || !record.codeHash) { res.status(200).json(GENERIC_FAIL); return; }

    if (Date.now() > record.expiresAt) {
      await dbRemove(resetPath).catch(() => {});
      res.status(200).json(GENERIC_FAIL);
      return;
    }

    if ((record.attempts || 0) >= MAX_ATTEMPTS) {
      // Verrouillé : on ne prolonge pas indéfiniment, mais on ne redonne
      // pas de tentative non plus. Le code expirera naturellement.
      res.status(200).json(GENERIC_FAIL);
      return;
    }

    const submittedHash = hashCode(code);
    const isMatch = timingSafeStrEqual(submittedHash, record.codeHash);

    if (!isMatch) {
      await dbUpdate(resetPath, { attempts: (record.attempts || 0) + 1 }).catch(() => {});
      res.status(200).json(GENERIC_FAIL);
      return;
    }

    // Succès : code à usage unique → consommé immédiatement.
    await dbRemove(resetPath).catch((e) => {
      console.error('[Geniwork Auth] échec suppression code reset (non bloquant):', e.message);
    });

    const resetTicket = signResetTicket(email);
    res.status(200).json({ ok: true, resetTicket: resetTicket });
  } catch (err) {
    console.error('[Geniwork Auth] erreur reset-check-code:', err.message);
    res.status(200).json(GENERIC_FAIL);
  }
};
