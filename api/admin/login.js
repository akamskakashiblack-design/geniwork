/* ═══════════════════════════════════════════════════════════════
   GENIWORK — POST /api/admin/login
   Verifie email + mot de passe COTE SERVEUR (le client ne peut plus
   se connecter en admin en appelant une fonction JS directement :
   le mot de passe est verifie ici, avec le vrai compte de service,
   et jamais expose au navigateur).
   Body: { email, password }
═══════════════════════════════════════════════════════════════ */

const { dbGet, dbSet, dbUpdate, emailKey } = require('./_lib/fbrest');
const { verifyPwd } = require('./_lib/pwd');
const { sign } = require('./_lib/session');

const MAX_ATTEMPTS = 5;
const LOCK_MS = 60 * 1000;

function toArray(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return Object.keys(v).sort((a, b) => Number(a) - Number(b)).map((k) => v[k]);
  return [];
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const body = req.body || {};
    const email = String(body.email || '').trim().toLowerCase().slice(0, 320);
    const password = String(body.password || '');

    if (!email || !password) { res.status(400).json({ error: 'Email et mot de passe requis' }); return; }

    const attemptsPath = '/gw/admin_secrets/login_attempts/' + emailKey(email);
    const attempts = (await dbGet(attemptsPath)) || { count: 0, lockedUntil: 0 };

    if (attempts.lockedUntil && attempts.lockedUntil > Date.now()) {
      const wait = Math.ceil((attempts.lockedUntil - Date.now()) / 1000);
      res.status(429).json({ error: 'Trop de tentatives. Reessayez dans ' + wait + 's.' });
      return;
    }

    async function recordFail() {
      const count = (attempts.count || 0) + 1;
      const lockedUntil = count >= MAX_ATTEMPTS ? Date.now() + LOCK_MS : 0;
      await dbSet(attemptsPath, { count: count >= MAX_ATTEMPTS ? 0 : count, lockedUntil });
    }

    const [sadmin, adminsRaw, usersRaw] = await Promise.all([
      dbGet('/gw/sadmin'),
      dbGet('/gw/admins'),
      dbGet('/gw/users'),
    ]);
    const admins = toArray(adminsRaw);
    const users = toArray(usersRaw);

    let target = null;        // { email, nom, role }
    let secretPath = null;    // chemin admin_secrets pour ce compte
    let legacyHash = null;    // ancien pwHash encore present dans l'enregistrement public (migration)

    if (sadmin && sadmin.email && sadmin.email.toLowerCase() === email) {
      target = { email: sadmin.email, nom: sadmin.nom, role: 'Super Admin' };
      secretPath = '/gw/admin_secrets/sadmin';
      legacyHash = sadmin.pwHash || null;
    } else {
      const entry = admins.find((a) => a && a.email && a.email.toLowerCase() === email);
      if (entry) {
        target = { email: entry.email, nom: entry.nom, role: entry.role };
        secretPath = '/gw/admin_secrets/admins/' + emailKey(email);
        legacyHash = entry.pwHash || null;
      }
    }

    if (!target) {
      await recordFail();
      res.status(401).json({ error: 'Aucun compte administrateur trouve pour cet email' });
      return;
    }

    const secret = await dbGet(secretPath);
    let effectiveHash = (secret && secret.pwHash) || legacyHash;

    if (!effectiveHash) {
      // Repli : mot de passe du compte utilisateur normal (comportement historique)
      const u = users.find((x) => x && x.email && x.email.toLowerCase() === email);
      if (u && u.password) effectiveHash = u.password;
    }

    if (!effectiveHash || !verifyPwd(password, effectiveHash)) {
      await recordFail();
      res.status(401).json({ error: 'Email ou mot de passe incorrect' });
      return;
    }

    // Succes : reset compteur, migre le hash hors des enregistrements publics
    await dbSet(attemptsPath, null);

    if (!secret || !secret.pwHash) {
      await dbSet(secretPath, { pwHash: effectiveHash });
      if (target.role === 'Super Admin') {
        await dbUpdate('/gw/sadmin', { pwHash: null });
      } else {
        const cleaned = admins.map((a) => {
          if (a && a.email && a.email.toLowerCase() === email) {
            const copy = Object.assign({}, a);
            delete copy.pwHash;
            return copy;
          }
          return a;
        });
        await dbSet('/gw/admins', cleaned);
      }
    }

    const token = sign(target);
    res.status(200).json({ ok: true, token, user: target });
  } catch (err) {
    console.error('[Geniwork Admin] erreur login:', err.message);
    res.status(500).json({ error: err.message });
  }
};
