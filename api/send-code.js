/* ═══════════════════════════════════════════════════════════════
   GENIWORK — Vercel Serverless Function : envoi du code de vérification
   POST /api/send-code  { email, code, type }
   type = "register" | "reset"
   Variables d'env requises : GMAIL_USER, GMAIL_APP_PASSWORD
═══════════════════════════════════════════════════════════════ */

var nodemailer = require('nodemailer');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST')    { res.status(405).json({ error: 'Method not allowed' }); return; }

  var body  = req.body || {};
  var email = body.email;
  var code  = body.code;
  var type  = body.type || 'register';

  if (!email || !code) {
    return res.status(400).json({ error: 'email et code requis' });
  }

  var gmailUser = process.env.GMAIL_USER;
  var gmailPwd  = process.env.GMAIL_APP_PASSWORD;

  if (!gmailUser || !gmailPwd) {
    return res.status(500).json({ error: 'Configuration email manquante (GMAIL_USER / GMAIL_APP_PASSWORD)' });
  }

  var isReset   = type === 'reset';
  var subject   = isReset
    ? 'Geniwork — Réinitialisation de mot de passe'
    : 'Geniwork — Code de vérification de votre compte';

  var html = isReset ? buildResetHtml(code, email) : buildRegisterHtml(code, email);

  try {
    var transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: gmailUser,
        pass: gmailPwd
      }
    });

    await transporter.sendMail({
      from:    '"Geniwork" <' + gmailUser + '>',
      to:      email,
      subject: subject,
      html:    html
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
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f2f5;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f5;padding:32px 0;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);">
        <!-- En-tête -->
        <tr><td style="background:linear-gradient(135deg,#060D1F 0%,#1a2a5e 100%);padding:32px 40px;text-align:center;">
          <h1 style="color:#ffffff;margin:0;font-size:26px;letter-spacing:1px;">GENIWORK</h1>
          <p style="color:#8ba3d9;margin:6px 0 0;font-size:13px;">Réseau professionnel & créatif</p>
        </td></tr>
        <!-- Corps -->
        <tr><td style="padding:40px 40px 24px;">
          <p style="color:#1a1a2e;font-size:16px;margin:0 0 8px;">Bonjour,</p>
          <p style="color:#555;font-size:15px;margin:0 0 28px;line-height:1.6;">
            Merci de rejoindre <strong>Geniwork</strong> ! Pour finaliser la création de votre compte associé à<br/>
            <strong style="color:#1a2a5e;">${email}</strong>,<br/>
            entrez le code ci-dessous dans l'application :
          </p>
          <!-- Code -->
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td align="center" style="padding:8px 0 32px;">
              <div style="display:inline-block;background:#f0f4ff;border:2px solid #3b5bdb;border-radius:14px;padding:20px 48px;">
                <span style="font-size:44px;font-weight:700;letter-spacing:16px;color:#1a2a5e;">${code}</span>
              </div>
            </td></tr>
          </table>
          <p style="color:#888;font-size:13px;margin:0 0 8px;">⏱ Ce code expire dans <strong>10 minutes</strong>.</p>
          <p style="color:#888;font-size:13px;margin:0;">Si vous n'avez pas demandé ce code, ignorez cet e-mail.</p>
        </td></tr>
        <!-- Pied -->
        <tr><td style="background:#f7f8fc;padding:20px 40px;text-align:center;border-top:1px solid #e8ecf4;">
          <p style="color:#aaa;font-size:12px;margin:0;">© 2025 Geniwork · Tous droits réservés</p>
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
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f2f5;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f5;padding:32px 0;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);">
        <!-- En-tête -->
        <tr><td style="background:linear-gradient(135deg,#060D1F 0%,#1a2a5e 100%);padding:32px 40px;text-align:center;">
          <h1 style="color:#ffffff;margin:0;font-size:26px;letter-spacing:1px;">GENIWORK</h1>
          <p style="color:#8ba3d9;margin:6px 0 0;font-size:13px;">Réseau professionnel & créatif</p>
        </td></tr>
        <!-- Corps -->
        <tr><td style="padding:40px 40px 24px;">
          <p style="color:#1a1a2e;font-size:16px;margin:0 0 8px;">Bonjour,</p>
          <p style="color:#555;font-size:15px;margin:0 0 28px;line-height:1.6;">
            Une demande de réinitialisation de mot de passe a été effectuée pour le compte<br/>
            <strong style="color:#1a2a5e;">${email}</strong>.<br/>
            Utilisez ce code pour continuer :
          </p>
          <!-- Code -->
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td align="center" style="padding:8px 0 32px;">
              <div style="display:inline-block;background:#fff4ed;border:2px solid #f97316;border-radius:14px;padding:20px 48px;">
                <span style="font-size:44px;font-weight:700;letter-spacing:16px;color:#c2410c;">${code}</span>
              </div>
            </td></tr>
          </table>
          <p style="color:#888;font-size:13px;margin:0 0 8px;">⏱ Ce code expire dans <strong>10 minutes</strong>.</p>
          <p style="color:#888;font-size:13px;margin:0;">Si vous n'avez pas demandé cette réinitialisation, ignorez cet e-mail — votre compte reste sécurisé.</p>
        </td></tr>
        <!-- Pied -->
        <tr><td style="background:#f7f8fc;padding:20px 40px;text-align:center;border-top:1px solid #e8ecf4;">
          <p style="color:#aaa;font-size:12px;margin:0;">© 2025 Geniwork · Tous droits réservés</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
