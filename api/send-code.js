/* ═══════════════════════════════════════════════════════════════
   GENIWORK — Vercel Serverless Function : envoi du code de vérification
   POST /api/send-code  { email, code, type }
   type = "register" | "reset"

   Variables d'env requises :
     GMAIL_USER          → ex: geniwork.noreply@gmail.com
     GMAIL_APP_PASSWORD  → mot de passe d'application Google

   Pour meilleure délivrabilité (recommandé) :
     Passer à Resend.com — gratuit 100/jour, DKIM inclus :
     RESEND_API_KEY → clé API Resend
     (décommentez le bloc Resend ci-dessous)
═══════════════════════════════════════════════════════════════ */

var nodemailer = require('nodemailer');

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

  var isReset = type === 'reset';
  var subject = isReset
    ? 'Geniwork — Réinitialisation de mot de passe'
    : 'Geniwork — Code de vérification de votre compte';

  var htmlContent = isReset ? buildResetHtml(code, email) : buildRegisterHtml(code, email);
  var textContent = isReset
    ? `Geniwork — Réinitialisation de mot de passe\n\nCode : ${code}\n\nCe code expire dans 10 minutes.\nSi vous n'avez pas demandé cette réinitialisation, ignorez cet e-mail.`
    : `Geniwork — Vérification de compte\n\nBonjour,\n\nVotre code de vérification : ${code}\n\nCe code expire dans 10 minutes.\nSi vous n'avez pas créé ce compte, ignorez cet e-mail.`;

  /* ── Option 1 : Resend.com (meilleure délivrabilité — recommandé) ──
  if (process.env.RESEND_API_KEY) {
    try {
      const { Resend } = require('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from:    'Geniwork <noreply@geniwork.app>',
        to:      email,
        subject: subject,
        html:    htmlContent,
        text:    textContent
      });
      return res.status(200).json({ ok: true });
    } catch(err) {
      console.error('[Geniwork Resend]', err.message);
    }
  }
  ── */

  /* ── Option 2 : Gmail SMTP ── */
  var gmailUser = process.env.GMAIL_USER;
  var gmailPwd  = process.env.GMAIL_APP_PASSWORD;

  if (!gmailUser || !gmailPwd) {
    return res.status(500).json({ error: 'Configuration email manquante (GMAIL_USER / GMAIL_APP_PASSWORD)' });
  }

  /* Message-ID unique — réduit le risque de spam */
  var msgId = '<' + Date.now() + '.' + Math.random().toString(36).slice(2) + '@geniwork.app>';

  try {
    var transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: gmailUser, pass: gmailPwd },
      pool: true
    });

    await transporter.sendMail({
      from:             '"Geniwork" <' + gmailUser + '>',
      to:               email,
      subject:          subject,
      html:             htmlContent,
      text:             textContent,         /* version texte brut — RÉDUIT LES SPAMS */
      messageId:        msgId,
      headers: {
        /* En-têtes anti-spam essentiels */
        'List-Unsubscribe': '<mailto:' + gmailUser + '?subject=unsubscribe>',
        'X-Mailer':         'Geniwork Mailer 1.0',
        'X-Priority':       '1',
        'Precedence':       'bulk'
      }
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[Geniwork email]', err.message);
    return res.status(500).json({ error: 'Envoi échoué : ' + err.message });
  }
};

function buildRegisterHtml(code, email) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Vérification Geniwork</title>
</head>
<body style="margin:0;padding:0;background:#f0f2f5;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f5;padding:32px 0;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);">
        <tr><td style="background:linear-gradient(135deg,#060D1F 0%,#1a2a5e 100%);padding:32px 40px;text-align:center;">
          <h1 style="color:#ffffff;margin:0;font-size:26px;letter-spacing:1px;">GENIWORK</h1>
          <p style="color:#8ba3d9;margin:6px 0 0;font-size:13px;">Réseau professionnel &amp; créatif</p>
        </td></tr>
        <tr><td style="padding:40px 40px 24px;">
          <p style="color:#1a1a2e;font-size:16px;margin:0 0 8px;">Bonjour,</p>
          <p style="color:#555;font-size:15px;margin:0 0 28px;line-height:1.6;">
            Merci de rejoindre <strong>Geniwork</strong> ! Pour finaliser la création de votre compte associé à<br/>
            <strong style="color:#1a2a5e;">${email}</strong>,<br/>
            entrez le code ci-dessous dans l'application :
          </p>
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td align="center" style="padding:8px 0 32px;">
              <div style="display:inline-block;background:#f0f4ff;border:2px solid #3b5bdb;border-radius:14px;padding:20px 48px;">
                <span style="font-size:44px;font-weight:700;letter-spacing:16px;color:#1a2a5e;">${code}</span>
              </div>
            </td></tr>
          </table>
          <p style="color:#888;font-size:13px;margin:0 0 8px;">⏱ Ce code expire dans <strong>10 minutes</strong>.</p>
          <p style="color:#888;font-size:13px;margin:0 0 16px;">Si vous n'avez pas demandé ce code, ignorez cet e-mail.</p>
          <p style="color:#bbb;font-size:12px;margin:0;background:#f8f9fb;padding:10px;border-radius:8px;">
            💡 <strong>Vous ne trouvez pas cet email ?</strong> Vérifiez votre dossier <strong>Spams/Courriers indésirables</strong> et marquez-le comme "Pas un spam" pour les prochains emails.
          </p>
        </td></tr>
        <tr><td style="background:#f7f8fc;padding:20px 40px;text-align:center;border-top:1px solid #e8ecf4;">
          <p style="color:#aaa;font-size:12px;margin:0;">© 2026 Geniwork · Tous droits réservés · Cet email a été envoyé automatiquement, merci de ne pas y répondre.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function buildResetHtml(code, email) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Réinitialisation Geniwork</title>
</head>
<body style="margin:0;padding:0;background:#f0f2f5;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f5;padding:32px 0;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);">
        <tr><td style="background:linear-gradient(135deg,#060D1F 0%,#1a2a5e 100%);padding:32px 40px;text-align:center;">
          <h1 style="color:#ffffff;margin:0;font-size:26px;letter-spacing:1px;">GENIWORK</h1>
          <p style="color:#8ba3d9;margin:6px 0 0;font-size:13px;">Réseau professionnel &amp; créatif</p>
        </td></tr>
        <tr><td style="padding:40px 40px 24px;">
          <p style="color:#1a1a2e;font-size:16px;margin:0 0 8px;">Bonjour,</p>
          <p style="color:#555;font-size:15px;margin:0 0 28px;line-height:1.6;">
            Une demande de réinitialisation de mot de passe a été effectuée pour le compte<br/>
            <strong style="color:#1a2a5e;">${email}</strong>.<br/>
            Utilisez ce code pour continuer :
          </p>
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td align="center" style="padding:8px 0 32px;">
              <div style="display:inline-block;background:#fff4ed;border:2px solid #f97316;border-radius:14px;padding:20px 48px;">
                <span style="font-size:44px;font-weight:700;letter-spacing:16px;color:#c2410c;">${code}</span>
              </div>
            </td></tr>
          </table>
          <p style="color:#888;font-size:13px;margin:0 0 8px;">⏱ Ce code expire dans <strong>10 minutes</strong>.</p>
          <p style="color:#888;font-size:13px;margin:0 0 16px;">Si vous n'avez pas demandé cette réinitialisation, ignorez cet e-mail — votre compte reste sécurisé.</p>
          <p style="color:#bbb;font-size:12px;margin:0;background:#f8f9fb;padding:10px;border-radius:8px;">
            💡 <strong>Vous ne trouvez pas cet email ?</strong> Vérifiez votre dossier <strong>Spams/Courriers indésirables</strong>.
          </p>
        </td></tr>
        <tr><td style="background:#f7f8fc;padding:20px 40px;text-align:center;border-top:1px solid #e8ecf4;">
          <p style="color:#aaa;font-size:12px;margin:0;">© 2026 Geniwork · Tous droits réservés · Cet email a été envoyé automatiquement, merci de ne pas y répondre.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
