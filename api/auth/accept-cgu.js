/* ═══════════════════════════════════════════════════════════════
   GENIWORK — POST /api/auth/accept-cgu
   Sécurisation de acceptCGU() (js/app.js) — remplace l'écriture
   client via getUsers()/saveUsers() (qui réécrivait tout le tableau
   gw/users pour un seul champ booléen).

   IDENTITÉ : jamais un email/index envoyé par le client. Dérivée
   uniquement du jeton de renouvellement (authRefreshToken), vérifié
   avec le même mécanisme HMAC-SHA256 déjà utilisé par
   /api/auth/change-password.js, /api/auth/change-email.js et
   /api/auth/register-verify.js (_lib/refreshToken.js). Sans jeton
   valide, aucune identité ne peut être établie → refus.

   Body: { authRefreshToken }
   Réponse : { ok:true } ou { ok:false, error }

   Écrit UNIQUEMENT gw/users/{index}/cguAccepted — jamais password,
   email, nom, verified ou googleId. Jamais de .set() sur tout le
   tableau.
═══════════════════════════════════════════════════════════════ */

const { dbGet, dbSet } = require('../admin/_lib/fbrest');
const { verify: verifyRefreshToken } = require('./_lib/refreshToken');

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

    /* ── Identité dérivée UNIQUEMENT du jeton signé — ce endpoint
       n'accepte même pas de champ email/index séparé. ── */
    const ticketData = verifyRefreshToken(body.authRefreshToken);
    if (!ticketData || !ticketData.email) {
      res.status(401).json({ ok: false, error: 'Session expirée, reconnectez-vous.' });
      return;
    }
    const email = ticketData.email;

    const users = toArray(await dbGet('/gw/users'));
    const idx = users.findIndex((u) => u && u.email && u.email.toLowerCase() === email);
    if (idx === -1) {
      res.status(404).json({ ok: false, error: 'Compte introuvable.' });
      return;
    }

    /* Écriture ciblée uniquement — jamais tout le tableau gw/users,
       jamais password/email/nom/verified/googleId. */
    await dbSet('/gw/users/' + idx + '/cguAccepted', true);

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[Geniwork Auth] erreur accept-cgu:', err.message);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
};
