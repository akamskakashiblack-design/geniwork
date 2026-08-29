/* ═══════════════════════════════════════════════════════════════
   GENIWORK — Envoi d'email de code (inscription / reset)
   Extrait de api/send-code.js (etape 5D) pour etre reutilisable
   directement par api/auth/reset-request.js SANS repasser par un
   appel HTTP interne. Comportement strictement identique a l'ancien
   code — aucun changement de template, de service d'envoi ni de
   variables d'environnement requises.
═══════════════════════════════════════════════════════════════ */

var nodemailer = require('nodemailer');

/* Phase SYNC-95 : email est une valeur fournie par l'appelant (jamais
   validée au-delà de la présence d'un "@") et est interpolée dans le
   HTML de l'email ci-dessous — sans échappement, une adresse malformée
   contenant des caractères HTML permettrait une injection dans le
   message envoyé. Échappement minimal des 5 caractères significatifs
   en HTML ; n'affecte jamais la valeur réelle utilisée comme
   destinataire SMTP/API (to: email, jamais to: escapeHtml(email)). */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildRegisterHtml(code, email) {
  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vérification Geniwork</title></head>
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
            Merci de rejoindre <strong>Geniwork</strong> !<br>
            Pour activer votre compte <strong style="color:#1a2a5e;">${escapeHtml(email)}</strong>, entrez ce code :
          </p>
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td align="center" style="padding:8px 0 32px;">
              <div style="display:inline-block;background:#f0f4ff;border:2px solid #3b5bdb;border-radius:14px;padding:20px 48px;">
                <span style="font-size:44px;font-weight:700;letter-spacing:16px;color:#1a2a5e;">${code}</span>
              </div>
            </td></tr>
          </table>
          <p style="color:#888;font-size:13px;margin:0 0 8px;">⏱ Ce code expire dans <strong>10 minutes</strong>.</p>
          <p style="color:#888;font-size:13px;margin:0;">Si vous n'avez pas créé ce compte, ignorez cet e-mail.</p>
        </td></tr>
        <tr><td style="background:#f7f8fc;padding:20px 40px;text-align:center;border-top:1px solid #e8ecf4;">
          <p style="color:#aaa;font-size:12px;margin:0;">© 2026 Geniwork · Email automatique, merci de ne pas répondre.</p>
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
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Réinitialisation Geniwork</title></head>
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
            Demande de réinitialisation pour <strong style="color:#1a2a5e;">${escapeHtml(email)}</strong>.<br>
            Entrez ce code dans l'application :
          </p>
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td align="center" style="padding:8px 0 32px;">
              <div style="display:inline-block;background:#fff4ed;border:2px solid #f97316;border-radius:14px;padding:20px 48px;">
                <span style="font-size:44px;font-weight:700;letter-spacing:16px;color:#c2410c;">${code}</span>
              </div>
            </td></tr>
          </table>
          <p style="color:#888;font-size:13px;margin:0 0 8px;">⏱ Ce code expire dans <strong>10 minutes</strong>.</p>
          <p style="color:#888;font-size:13px;margin:0;">Si vous n'avez pas fait cette demande, ignorez cet e-mail.</p>
        </td></tr>
        <tr><td style="background:#f7f8fc;padding:20px 40px;text-align:center;border-top:1px solid #e8ecf4;">
          <p style="color:#aaa;font-size:12px;margin:0;">© 2026 Geniwork · Email automatique, merci de ne pas répondre.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/* Envoie un email {register|reset}. Retourne { ok, via, id } ou lance une erreur
   (message générique côté appelant — jamais le code/mot de passe dans l'erreur). */
async function sendCodeEmail(email, code, type) {
  var isReset = type === 'reset';
  var subject = isReset
    ? 'Geniwork — Réinitialisation de mot de passe'
    : 'Geniwork — Code de vérification de votre compte';
  var html = isReset ? buildResetHtml(code, email) : buildRegisterHtml(code, email);
  var text = isReset
    ? 'Geniwork — Réinitialisation\n\nCode : ' + code + '\n\nExpire dans 10 minutes.'
    : 'Geniwork — Vérification\n\nCode : ' + code + '\n\nExpire dans 10 minutes.';

  var gmailUser = process.env.GMAIL_USER;
  var gmailPass = process.env.GMAIL_APP_PASSWORD;

  if (gmailUser && gmailPass) {
    var transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: gmailUser, pass: gmailPass }
    });
    var info = await transporter.sendMail({
      from: 'Geniwork <' + gmailUser + '>',
      to: email,
      subject: subject,
      html: html,
      text: text
    });
    return { ok: true, via: 'gmail', id: info.messageId };
  }

  var apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('Service email non configuré');

  var resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Geniwork <onboarding@resend.dev>', to: [email], subject: subject, html: html, text: text })
  });
  var data = await resp.json();
  if (resp.ok && data.id) return { ok: true, via: 'resend', id: data.id };
  throw new Error(data.message || 'Erreur envoi email');
}

module.exports = { sendCodeEmail, buildRegisterHtml, buildResetHtml };
