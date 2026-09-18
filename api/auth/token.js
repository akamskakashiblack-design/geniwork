/* ═══════════════════════════════════════════════════════════════
   GENIWORK — POST /api/auth/token
   Etape 1 de la migration d'authentification : verifie email + mot
   de passe d'un compte utilisateur normal (gw/users) puis renvoie un
   Firebase Custom Token dont l'uid = _gwFbKey(email) cote client
   (meme cle deja utilisee partout dans les donnees existantes, donc
   aucune migration de donnees necessaire).

   Ce jeton permet au navigateur de remplacer sa session Firebase
   anonyme par une session liee a l'identite reelle de l'utilisateur
   (auth.uid devient enfin exploitable dans les regles de securite).

   IMPORTANT : tant que database.rules.json n'est pas mis a jour pour
   verifier auth.uid, ce jeton n'apporte aucun changement de securite
   a lui seul — c'est une etape preparatoire.

   Body: { email, password }
═══════════════════════════════════════════════════════════════ */

const crypto = require('crypto');
const { dbGet, dbSet, emailKey } = require('../admin/_lib/fbrest');
const { verifyPwd, hashPwd } = require('../admin/_lib/pwd');
const { sign: signRefreshToken } = require('./_lib/refreshToken');

/* Phase 6 : rate limiting anti brute-force/credential-stuffing — même
   mécanisme déjà en production pour api/admin/login.js (stockage
   Firebase via le compte de service : partagé entre toutes les
   instances/régions Vercel, contrairement à une variable mémoire
   locale qui ne le serait pas). Chemin gw/auth_secrets/* absent de
   database.rules.json → refusé par défaut pour toute requête cliente,
   accessible uniquement via le compte de service, comme
   gw/admin_secrets déjà protégé de la même façon. */
const MAX_ATTEMPTS = 5;
const LOCK_MS = 60 * 1000;

function toArray(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return Object.keys(v).sort((a, b) => Number(a) - Number(b)).map((k) => v[k]);
  return [];
}

function getServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT non configuree dans Vercel');
  const sa = JSON.parse(raw);
  if (!sa.client_email || !sa.private_key) throw new Error('Compte de service incomplet');
  return sa;
}

/* Firebase Custom Token = JWT RS256 signe par le compte de service,
   avec les claims exactes attendues par l'Identity Toolkit. */
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
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');

    if (!email || !password) { res.status(400).json({ error: 'Email et mot de passe requis' }); return; }

    const attemptsPath = '/gw/auth_secrets/login_attempts/' + emailKey(email);
    const attempts = (await dbGet(attemptsPath)) || { count: 0, lockedUntil: 0 };

    if (attempts.lockedUntil && attempts.lockedUntil > Date.now()) {
      const wait = Math.ceil((attempts.lockedUntil - Date.now()) / 1000);
      res.status(429).json({ error: 'Trop de tentatives. Réessayez dans ' + wait + 's.' });
      return;
    }

    async function recordFail() {
      const count = (attempts.count || 0) + 1;
      const lockedUntil = count >= MAX_ATTEMPTS ? Date.now() + LOCK_MS : 0;
      await dbSet(attemptsPath, { count: count >= MAX_ATTEMPTS ? 0 : count, lockedUntil });
    }

    const users = toArray(await dbGet('/gw/users'));
    const idx = users.findIndex((x) => x && x.email && x.email.toLowerCase() === email);
    const u = idx !== -1 ? users[idx] : null;

    if (!u || !u.password || !verifyPwd(password, u.password)) {
      await recordFail();
      res.status(401).json({ error: 'Email ou mot de passe incorrect' });
      return;
    }
    if (!u.verified) {
      res.status(401).json({ error: 'Compte non vérifié', code: 'unverified' });
      return;
    }

    /* Succès : réinitialise le compteur (même schéma que admin/login.js). */
    await dbSet(attemptsPath, null);

    /* Étape 5B — migration cote serveur : si le mot de passe est encore au
       format legacy (verifyPwd() vient de le confirmer correct via la
       comparaison directe), on le rehache en PBKDF2 et on écrit UNIQUEMENT
       ce champ (pas tout le tableau gw/users) via le compte de service.
       Non bloquant : si l'écriture échoue, le login reussit quand même
       (nouvelle tentative de migration au prochain login). */
    if (u.password.indexOf('pbkdf2:') !== 0) {
      try {
        const newHash = hashPwd(password);
        await dbSet('/gw/users/' + idx + '/password', newHash);
        console.log('[Geniwork Auth] compte migré vers PBKDF2 (login legacy réussi)');
      } catch (migErr) {
        console.error('[Geniwork Auth] échec migration PBKDF2 (non bloquant):', migErr.message);
      }
    }

    const sa = getServiceAccount();
    const uid = emailKey(email);
    const token = signCustomToken(uid, sa);
    const refreshToken = signRefreshToken(email);

    /* cguAccepted === false explicitement => CGU jamais acceptées (compte créé
       après l'introduction de ce champ, verifie() encore en attente côté
       client). Absent (comptes créés avant ce champ) => traité comme accepté,
       jamais de régression pour les comptes existants. Le jeton est quand
       même émis : le client en a besoin pour terminer l'écran CGU sans
       redemander le mot de passe, mais ne doit établir de session tant que
       cguAccepted n'est pas revenu à true (voir accept-cgu.js). */
    res.status(200).json({
      ok: true,
      token: token,
      uid: uid,
      nom: u.nom || null,
      loginMethod: u.loginMethod || 'email',
      refreshToken: refreshToken,
      cguAccepted: u.cguAccepted !== false,
    });
  } catch (err) {
    console.error('[Geniwork Auth] erreur token:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};
