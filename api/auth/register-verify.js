/* ═══════════════════════════════════════════════════════════════
   GENIWORK — POST /api/auth/register-verify
   Étape 5G-3 : vérifie le code d'inscription ENTIÈREMENT côté serveur
   (remplace `entered !== _verifyCode` qui existait dans le navigateur),
   puis crée le compte — mot de passe haché en PBKDF2 côté serveur
   uniquement (jamais côté client).

   Body: { nom, email, password, code }
   Réponse succès : { ok:true, token, refreshToken }
   (Custom Token + jeton de renouvellement pour la nouvelle identité —
   évite un aller-retour supplémentaire vers /api/auth/token avec le
   mot de passe en clair, comme le faisait l'ancien flux via
   _gwSignInRealIdentity() après acceptCGU()).
   Réponse échec : { ok:false, error } — même message générique pour
   code faux / expiré / déjà utilisé, comme reset-check-code.

   Le code est à usage unique : supprimé de gw/registration_codes dès
   qu'il est vérifié avec succès (rejeu impossible avec le même code).
   nom/email/password sont revalidés ici (défense en profondeur : ne
   fait pas confiance à ce qui a été validé côté client à l'étape
   précédente), et l'unicité email/nom est re-vérifiée (protection
   contre une inscription concurrente entre les deux étapes).
═══════════════════════════════════════════════════════════════ */

const crypto = require('crypto');
const { dbGet, dbSet, dbUpdate, dbRemove, emailKey } = require('../admin/_lib/fbrest');
const { hashPwd } = require('../admin/_lib/pwd');
const { sign: signRefreshToken } = require('./_lib/refreshToken');
const { toPublicUser } = require('./_lib/publicUser');

const MAX_ATTEMPTS = 5;
const GENERIC_FAIL = { ok: false, error: 'Code incorrect ou expiré' };

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
function isReservedName(nom) {
  const n = String(nom || '').trim().toLowerCase().replace(/\s+/g, '');
  return n === 'geniwork' || n === 'geniworkofficiel' || n === 'geniworkofficial';
}

function toArray(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return Object.keys(v).sort((a, b) => Number(a) - Number(b)).map((k) => v[k]);
  return [];
}

function hashCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}
function timingSafeStrEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function getServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT non configuree dans Vercel');
  const sa = JSON.parse(raw);
  if (!sa.client_email || !sa.private_key) throw new Error('Compte de service incomplet');
  return sa;
}
/* Même construction que api/auth/token.js / change-email.js (dupliquée,
   comme déjà le cas entre ces fichiers). */
function signCustomToken(uid, sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: sa.client_email, sub: sa.client_email,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat: now, exp: now + 3600, uid: uid,
  };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = b64(header) + '.' + b64(payload);
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(unsigned);
  const sig = sign.sign(sa.private_key, 'base64url');
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
    const nom = String(body.nom || '').trim().slice(0, 100);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const code = String(body.code || '').trim();

    if (!nom || !email || !password || !code) { res.status(200).json(GENERIC_FAIL); return; }

    const uid = emailKey(email);
    const codePath = '/gw/registration_codes/' + uid;

    const record = await dbGet(codePath);
    if (!record || !record.codeHash) { res.status(200).json(GENERIC_FAIL); return; }

    if (Date.now() > record.expiresAt) {
      await dbRemove(codePath).catch(() => {});
      res.status(200).json(GENERIC_FAIL);
      return;
    }
    if ((record.attempts || 0) >= MAX_ATTEMPTS) {
      res.status(200).json(GENERIC_FAIL);
      return;
    }

    const isMatch = timingSafeStrEqual(hashCode(code), record.codeHash);
    if (!isMatch) {
      await dbUpdate(codePath, { attempts: (record.attempts || 0) + 1 }).catch(() => {});
      res.status(200).json(GENERIC_FAIL);
      return;
    }

    // Code correct : usage unique → consommé immédiatement.
    await dbRemove(codePath).catch((e) => {
      console.error('[Geniwork Auth] échec suppression code inscription (non bloquant):', e.message);
    });

    /* ── Défense en profondeur : revalide tout, ne fait pas confiance à
       ce que le client a validé à l'étape register-request. ── */
    if (isReservedName(nom)) {
      res.status(400).json({ ok: false, error: 'Ce nom est réservé au compte officiel Geniwork' });
      return;
    }
    if (!isPasswordValid(password)) {
      res.status(400).json({ ok: false, error: 'Le mot de passe ne respecte pas les règles' });
      return;
    }

    const users = toArray(await dbGet('/gw/users'));
    if (users.some((u) => u && u.email && u.email.toLowerCase() === email)) {
      res.status(409).json({ ok: false, error: 'Cette adresse e-mail est déjà utilisée' });
      return;
    }
    if (users.some((u) => u && u.nom && String(u.nom).trim().toLowerCase() === nom.trim().toLowerCase())) {
      res.status(409).json({ ok: false, error: 'Ce nom est déjà utilisé par un autre membre. Choisissez-en un autre.' });
      return;
    }

    const newUser = { nom: nom, email: email, password: hashPwd(password), verified: true };
    users.push(newUser);
    await dbSet('/gw/users', users);

    /* Phase 5D : projection publique jumelle (jamais password) — best-effort,
       gw/users reste la source de vérité même si cette écriture échoue ; le
       navigateur n'a jamais à réparer users_public lui-même. */
    try {
      await dbSet('/gw/users_public/' + (users.length - 1), toPublicUser(newUser));
    } catch (pubErr) {
      console.error('[Geniwork Auth] échec écriture users_public (non bloquant):', pubErr.message);
    }

    const sa = getServiceAccount();
    const token = signCustomToken(uid, sa);
    const refreshToken = signRefreshToken(email);

    res.status(200).json({ ok: true, token: token, refreshToken: refreshToken });
  } catch (err) {
    console.error('[Geniwork Auth] erreur register-verify:', err.message);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
};
