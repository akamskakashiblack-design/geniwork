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
const { dbGet, emailKey } = require('../admin/_lib/fbrest');
const { verifyPwd } = require('../admin/_lib/pwd');

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

    const users = toArray(await dbGet('/gw/users'));
    const u = users.find((x) => x && x.email && x.email.toLowerCase() === email);

    if (!u || !u.password || !verifyPwd(password, u.password)) {
      res.status(401).json({ error: 'Email ou mot de passe incorrect' });
      return;
    }

    const sa = getServiceAccount();
    const uid = emailKey(email);
    const token = signCustomToken(uid, sa);

    res.status(200).json({ ok: true, token: token, uid: uid });
  } catch (err) {
    console.error('[Geniwork Auth] erreur token:', err.message);
    res.status(500).json({ error: err.message });
  }
};
