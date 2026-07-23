/* ═══════════════════════════════════════════════════════════════
   GENIWORK — POST /api/admin/setup
   Cree le compte Super Admin, UNE SEULE FOIS (verifie server-side
   qu'aucun super admin n'existe deja — empeche le detournement du
   panneau admin par un visiteur qui arriverait avant le vrai
   proprietaire).
   Body: { nom, email, password }
═══════════════════════════════════════════════════════════════ */

const { dbGet, dbSet } = require('./_lib/fbrest');
const { hashPwd } = require('./_lib/pwd');
const { sign } = require('./_lib/session');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const body = req.body || {};
    const nom = String(body.nom || '').trim().slice(0, 100);
    const email = String(body.email || '').trim().toLowerCase().slice(0, 320);
    const password = String(body.password || '');

    if (!nom) { res.status(400).json({ error: 'Entrez votre nom' }); return; }
    if (!email || email.indexOf('@') === -1) { res.status(400).json({ error: 'Email invalide' }); return; }
    if (password.length < 8) { res.status(400).json({ error: 'Mot de passe min. 8 caracteres' }); return; }

    const existing = await dbGet('/gw/sadmin');
    if (existing && existing.email) {
      res.status(409).json({ error: 'Un compte Super Admin existe deja. Utilisez la connexion.' });
      return;
    }

    const pwHash = hashPwd(password);
    const createdAt = new Date().toISOString();

    await dbSet('/gw/sadmin', { email, nom, createdAt });
    await dbSet('/gw/admin_secrets/sadmin', { pwHash });

    const user = { email, nom, role: 'Super Admin' };
    const token = sign(user);

    res.status(200).json({ ok: true, token, user });
  } catch (err) {
    console.error('[Geniwork Admin] erreur setup:', err.message);
    res.status(500).json({ error: err.message });
  }
};
