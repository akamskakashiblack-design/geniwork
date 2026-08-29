/* ═══════════════════════════════════════════════════════════════
   GENIWORK — POST /api/auth/reset-request
   Étape 5D : démarre une réinitialisation de mot de passe ENTIÈREMENT
   côté serveur. Remplace l'ancienne génération de code côté client
   (doForgot() faisait `_resetCode = generateCode()` dans le navigateur).

   Body: { email }
   Réponse : TOUJOURS { ok:true } (générique) — ne révèle jamais si le
   compte existe, s'il est banni, ou si l'email a réellement été envoyé.

   Stockage temporaire : gw/password_resets/{emailKey} = {
     codeHash   : sha256(code)   — jamais le code en clair
     expiresAt  : Date.now() + 10 min
     attempts   : 0
     createdAt  : Date.now()
   }
   Accessible UNIQUEMENT via le compte de service (dbGet/dbSet), aucune
   règle Firebase à ajouter : un chemin absent de database.rules.json
   est refusé par défaut pour toute requête cliente (lecture ET écriture).
═══════════════════════════════════════════════════════════════ */

const crypto = require('crypto');
const { dbGet, dbSet, emailKey } = require('../admin/_lib/fbrest');
const { sendCodeEmail } = require('../_lib/mailer');

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes — cohérent avec le texte déjà présent dans l'email
const RESEND_THROTTLE_MS = 30 * 1000; // anti-spam double-clic, pas une vraie protection anti-abus

function toArray(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return Object.keys(v).sort((a, b) => Number(a) - Number(b)).map((k) => v[k]);
  return [];
}

function generateCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function hashCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

async function isBanned(email) {
  try {
    const bans = toArray(await dbGet('/gw/bans'));
    const ban = bans.find((b) => b && b.email && b.email.toLowerCase() === email);
    if (!ban) return false;
    if (ban.type === 'temp' && ban.expiresAt && new Date(ban.expiresAt).getTime() <= Date.now()) return false;
    return true;
  } catch (e) {
    return false; // en cas d'erreur de lecture, ne bloque pas le flux (best-effort)
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const GENERIC_OK = { ok: true };

  try {
    const body = req.body || {};
    const email = String(body.email || '').trim().toLowerCase();

    if (!email || email.indexOf('@') === -1 || email.length > 320) {
      // Entrée invalide : toujours une réponse générique, jamais de détail.
      res.status(200).json(GENERIC_OK);
      return;
    }

    const uid = emailKey(email);
    const resetPath = '/gw/password_resets/' + uid;

    // Throttle anti-spam (best-effort, jamais bloquant pour l'utilisateur légitime)
    try {
      const existing = await dbGet(resetPath);
      if (existing && existing.createdAt && (Date.now() - existing.createdAt) < RESEND_THROTTLE_MS) {
        res.status(200).json(GENERIC_OK);
        return;
      }
    } catch (e) { /* ignore, on continue */ }

    const users = toArray(await dbGet('/gw/users'));
    const u = users.find((x) => x && x.email && x.email.toLowerCase() === email);

    // Compte inexistant, sans mot de passe (Google-only), ou banni :
    // même réponse générique, mais on n'envoie rien.
    if (!u || !u.password || await isBanned(email)) {
      res.status(200).json(GENERIC_OK);
      return;
    }

    const code = generateCode();
    const record = {
      codeHash:  hashCode(code),
      expiresAt: Date.now() + CODE_TTL_MS,
      attempts:  0,
      createdAt: Date.now(),
    };

    await dbSet(resetPath, record);

    try {
      await sendCodeEmail(email, code, 'reset');
    } catch (mailErr) {
      console.error('[Geniwork Auth] échec envoi email reset (compte concerné non révélé):', mailErr.message);
      // On ne révèle pas l'échec au client — réponse générique quand même.
    }

    res.status(200).json(GENERIC_OK);
  } catch (err) {
    console.error('[Geniwork Auth] erreur reset-request:', err.message);
    // Même en cas d'erreur serveur inattendue, réponse générique.
    res.status(200).json(GENERIC_OK);
  }
};
