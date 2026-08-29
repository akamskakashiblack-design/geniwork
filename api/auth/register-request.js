/* ═══════════════════════════════════════════════════════════════
   GENIWORK — POST /api/auth/register-request
   Étape 5G-3 : démarre une inscription email/mot de passe ENTIÈREMENT
   côté serveur. Remplace l'ancienne génération de code côté client
   (doRegister()/_proceedRegister() faisaient `_verifyCode = generateCode()`
   dans le navigateur — voir js/app.js).

   Body: { nom, email, password }

   Contrairement à /api/auth/reset-request (qui ne révèle jamais si un
   compte existe), l'inscription révèle explicitement "email déjà
   utilisé" / "nom déjà utilisé" — comportement UX déjà existant et
   normal pour un formulaire d'inscription (préservé tel quel, comme
   demandé : "respecter le comportement UX existant").

   Stockage temporaire : gw/registration_codes/{emailKey} = {
     codeHash   : sha256(code)   — jamais le code en clair
     expiresAt  : Date.now() + 10 min
     attempts   : 0
     createdAt  : Date.now()
   }
   Même mécanisme que gw/password_resets (Étape 5D) — chemin absent de
   database.rules.json, donc refusé par défaut pour toute requête
   cliente ; accessible uniquement via le compte de service.
═══════════════════════════════════════════════════════════════ */

const crypto = require('crypto');
const { dbGet, dbSet, emailKey } = require('../admin/_lib/fbrest');
const { sendCodeEmail } = require('../_lib/mailer');

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes — cohérent avec le texte déjà présent dans l'email
const RESEND_THROTTLE_MS = 30 * 1000; // anti-spam double-clic, pas une vraie protection anti-abus

const PWD_RULES = {
  len: (p) => p.length >= 8,
  maj: (p) => /[A-Z]/.test(p),
  min: (p) => /[a-z]/.test(p),
  num: (p) => /[0-9]/.test(p),
  sym: (p) => /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(p),
};
function isPasswordValid(pwd) {
  return typeof pwd === 'string' && Object.values(PWD_RULES).every((fn) => fn(pwd));
}

/* Même règle que _gwIsReservedName() côté client (js/app.js) — dupliquée
   ici pour la même raison que PWD_RULES : pas de module partagé introduit
   dans cette étape pour ne pas toucher aux endpoints déjà livrés. */
function isReservedName(nom) {
  const n = String(nom || '').trim().toLowerCase().replace(/\s+/g, '');
  return n === 'geniwork' || n === 'geniworkofficiel' || n === 'geniworkofficial';
}

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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const body = req.body || {};
    const nom = String(body.nom || '').trim().slice(0, 100);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');

    if (!nom) { res.status(400).json({ ok: false, error: 'Veuillez entrer votre nom complet' }); return; }
    if (isReservedName(nom)) { res.status(400).json({ ok: false, error: 'Ce nom est réservé au compte officiel Geniwork' }); return; }
    if (!email || email.indexOf('@') === -1 || email.indexOf('.') === -1 || email.length > 320) {
      res.status(400).json({ ok: false, error: 'Adresse e-mail invalide' });
      return;
    }
    if (!isPasswordValid(password)) {
      res.status(400).json({ ok: false, error: 'Le mot de passe ne respecte pas les règles' });
      return;
    }

    const users = toArray(await dbGet('/gw/users'));
    const emailTaken = users.some((u) => u && u.email && u.email.toLowerCase() === email);
    if (emailTaken) {
      res.status(409).json({ ok: false, error: 'Cette adresse e-mail est déjà utilisée' });
      return;
    }
    const nomTaken = users.some((u) => u && u.nom && String(u.nom).trim().toLowerCase() === nom.trim().toLowerCase());
    if (nomTaken) {
      res.status(409).json({ ok: false, error: 'Ce nom est déjà utilisé par un autre membre. Choisissez-en un autre.' });
      return;
    }

    const uid = emailKey(email);
    const codePath = '/gw/registration_codes/' + uid;

    // Throttle anti-spam (best-effort, jamais bloquant pour l'utilisateur légitime)
    try {
      const existing = await dbGet(codePath);
      if (existing && existing.createdAt && (Date.now() - existing.createdAt) < RESEND_THROTTLE_MS) {
        res.status(200).json({ ok: true });
        return;
      }
    } catch (e) { /* ignore, on continue */ }

    const code = generateCode();
    await dbSet(codePath, {
      codeHash:  hashCode(code),
      expiresAt: Date.now() + CODE_TTL_MS,
      attempts:  0,
      createdAt: Date.now(),
    });

    await sendCodeEmail(email, code, 'register');

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[Geniwork Auth] erreur register-request:', err.message);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
};
