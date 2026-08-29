/* ═══════════════════════════════════════════════════════════════
   GENIWORK — POST /api/auth/reset-apply
   Étape 5D : dernière étape du reset — applique le nouveau mot de
   passe. Remplace l'ancien doSaveNewPwd() qui hachait et écrivait
   TOUT le tableau gw/users depuis le navigateur (saveUsers()).

   Body: { resetTicket, newPassword }
   resetTicket : émis par /api/auth/reset-check-code après vérification
   du code — jamais le code lui-même, jamais un email brut non signé.

   Écriture ciblée : gw/users/{index}/password uniquement (jamais tout
   le tableau) — évite qu'un autre utilisateur modifiant son mot de
   passe au même moment écrase ce changement, ou l'inverse.

   Réponse : { ok:true } ou { ok:false, error } — le mot de passe et le
   hash ne sont JAMAIS renvoyés ni journalisés.
═══════════════════════════════════════════════════════════════ */

const { dbGet, dbSet } = require('../admin/_lib/fbrest');
const { hashPwd } = require('../admin/_lib/pwd');
const { verify: verifyResetTicket } = require('./_lib/resetTicket');

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

function toArray(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return Object.keys(v).sort((a, b) => Number(a) - Number(b)).map((k) => v[k]);
  return [];
}

async function isBanned(email) {
  try {
    const bans = toArray(await dbGet('/gw/bans'));
    const ban = bans.find((b) => b && b.email && b.email.toLowerCase() === email);
    if (!ban) return false;
    if (ban.type === 'temp' && ban.expiresAt && new Date(ban.expiresAt).getTime() <= Date.now()) return false;
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const body = req.body || {};
    const resetTicket = body.resetTicket;
    const newPassword = String(body.newPassword || '');

    const ticketData = verifyResetTicket(resetTicket);
    if (!ticketData || !ticketData.email) {
      res.status(401).json({ ok: false, error: 'Session de réinitialisation invalide ou expirée' });
      return;
    }
    const email = ticketData.email;

    if (!isPasswordValid(newPassword)) {
      res.status(400).json({ ok: false, error: 'Le mot de passe ne respecte pas les règles' });
      return;
    }

    if (await isBanned(email)) {
      res.status(403).json({ ok: false, error: 'Compte suspendu' });
      return;
    }

    const users = toArray(await dbGet('/gw/users'));
    const idx = users.findIndex((u) => u && u.email && u.email.toLowerCase() === email);
    if (idx === -1) {
      // Ne devrait pas arriver (le ticket n'est émis que pour un compte
      // existant côté reset-check-code) — réponse générique quand même.
      res.status(400).json({ ok: false, error: 'Impossible de mettre à jour le mot de passe' });
      return;
    }

    const newHash = hashPwd(newPassword);
    await dbSet('/gw/users/' + idx + '/password', newHash);

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[Geniwork Auth] erreur reset-apply:', err.message);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
};
