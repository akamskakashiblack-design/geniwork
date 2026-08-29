/* ═══════════════════════════════════════════════════════════════
   GENIWORK — Envoi du code de vérification (inscription)
   POST /api/send-code  { email, code, type }
   type = "register" | "reset"

   Étape 5D : la logique d'envoi est partagée avec api/auth/reset-request.js
   via api/_lib/mailer.js (aucun changement de comportement ici).
   Le flux "reset" (type='reset') n'est plus appelé directement par le
   client depuis l'étape 5D — remplacé par /api/auth/reset-request, qui
   génère et stocke le code côté serveur avant d'envoyer l'email via ce
   même module partagé. Cet endpoint reste utilisé tel quel pour
   "register" (hors périmètre de cette étape), et reste fonctionnel pour
   "reset" si jamais appelé directement (aucune régression introduite).
═══════════════════════════════════════════════════════════════ */

var { sendCodeEmail } = require('./_lib/mailer');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST')    { res.status(405).json({ error: 'Method not allowed' }); return; }

  var body  = req.body || {};
  var email = (body.email || '').trim().toLowerCase();
  var code  = String(body.code || '').trim();
  var type  = body.type || 'register';

  if (!email || !code) {
    return res.status(400).json({ error: 'email et code requis' });
  }
  /* Phase 6 : `code` est injecté sans échappement dans le HTML de l'email
     (api/_lib/mailer.js) — sans validation de format, ce endpoint devient
     un relais permettant d'envoyer un contenu HTML arbitraire (au nom de
     Geniwork) à n'importe quelle adresse. Le code n'a jamais été autre
     chose qu'une chaîne de chiffres (voir generateCode() côté client,
     désormais orpheline, et la génération serveur de register-request.js/
     reset-request.js) : on impose ce même format ici, sans changer le
     comportement pour tout appelant légitime. */
  if (!/^\d{4,8}$/.test(code)) {
    return res.status(400).json({ error: 'Format de code invalide' });
  }
  if (email.length > 320 || !email.includes('@')) {
    return res.status(400).json({ error: 'Email invalide' });
  }

  try {
    var result = await sendCodeEmail(email, code, type);
    console.log('[Geniwork] ✅ Email envoyé via ' + result.via + ':', result.id);
    return res.status(200).json(result);
  } catch (err) {
    console.error('[Geniwork] Erreur envoi email:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
