/* ═══════════════════════════════════════════════════════════════
   GENIWORK — Envoi du code de vérification / réinitialisation
   POST /api/send-code  { email, code, type }
   type = "register" | "reset"

   Ordre de priorité des expéditeurs :
   1. Resend.com  (DKIM/SPF automatique — recommandé, gratuit 100/j)
      → Variable Vercel : RESEND_API_KEY
   2. Brevo SMTP  (300 emails/jour gratuits, DKIM inclus)
      → Variables Vercel : BREVO_USER + BREVO_PASS
   3. Gmail SMTP  (fallback, risque spam)
      → Variables Vercel : GMAIL_USER + GMAIL_APP_PASSWORD
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
    ? 'Geniwork — Réinitialisation\n\nCode : ' + code + '\n\nExpire dans 10 minutes.\nSi vous n\'avez pas demandé cela, ignorez cet e-mail.'
    : 'Geniwork — Vérification de compte\n\nCode : ' + code + '\n\nExpire dans 10 minutes.\nSi vous n\'avez pas créé ce compte, ignorez cet e-mail.';

  /* ══════════════════════════════════════
     1. RESEND.COM — Priorité maximale
        DKIM/SPF gérés automatiquement
        → Atterrit dans la boîte principale
     ══════════════════════════════════════ */
  if (process.env.RESEND_API_KEY) {
    try {
      var resendResp = await fetch('https://api.resend.com/emails', {
        method:  'POST',
        headers: {
          'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
          'Content-Type':  'application/json'
        },
        body: JSON.stringify({
          from:    'Geniwork <onboarding@resend.dev>',
          to:      [email],
          subject: subject,
          html:    htmlContent,
          text:    textContent
        })
      });
      var resendData = await resendResp.json();
      if (resendResp.ok && resendData.id) {
        console.log('[Geniwork] ✅ Email envoyé via Resend:', resendData.id);
        return res.status(200).json({ ok: true, via: 'resend' });
      }
      console.warn('[Geniwork] ⚠️ Resend échec:', JSON.stringify(resendData));
    } catch (err) {
      console.error('[Geniwork] Resend erreur:', err.message);
    }
  }

  /* ══════════════════════════════════════
     2. BREVO (SendinBlue) — Fallback pro
        SMTP Brevo → bonne délivrabilité
        Créer compte sur brevo.com (gratuit)
        SMTP Settings → login + mot de passe
     ══════════════════════════════════════ */
  if (process.env.BREVO_USER && process.env.BREVO_PASS) {
    try {
      var brevoTransport = nodemailer.createTransport({
        host: 'smtp-relay.brevo.com',
        port: 587,
        secure: false,
        auth: {
          user: process.env.BREVO_USER,
          pass: process.env.BREVO_PASS
        }
      });
      await brevoTransport.sendMail({
        from:    '"Geniwork" <' + process.env.BREVO_USER + '>',
        to:      email,
        subject: subject,
        html:    htmlContent,
        text:    textContent
      });
      console.log('[Geniwork] ✅ Email envoyé via Brevo');
      return res.status(200).json({ ok: true, via: 'brevo' });
    } catch (err) {
      console.error('[Geniwork] Brevo erreur:', err.message);
    }
  }

  /* ══════════════════════════════════════
     3. GMAIL SMTP — Fallback (risque spam)
        Utiliser uniquement si pas de Resend/Brevo
     ══════════════════════════════════════ */
  var gmailUser = process.env.GMAIL_USER;
  var gmailPwd  = process.env.GMAIL_APP_PASSWORD;

  if (!gmailUser || !gmailPwd) {
    console.error('[Geniwork] Aucun service email configuré.');
    return res.status(500).json({ error: 'Configuration email manquante. Ajoutez RESEND_API_KEY dans Vercel.' });
  }

  var msgId = '<' + Date.now() + '.' + Math.random().toString(36).slice(2) + '@geniwork.app>';

  try {
    var gmailTransport = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: gmailUser, pass: gmailPwd }
    });
    await gmailTransport.sendMail({
      from:      '"Geniwork" <' + gmailUser + '>',
      to:        email,
      subject:   subject,
      html:      htmlContent,
      text:      textContent,
      messageId: msgId,
      headers: {
        'List-Unsubscribe': '<mailto:' + gmailUser + '?subject=unsubscribe>',
        'X-Mailer':         'Geniwork Mailer 1.0'
      }
    });
    console.log('[Geniwork] ✅ Email envoyé via Gmail (risque spam)');
    return res.status(200).json({ ok: true, via: 'gmail' });
  } catch (err) {
    console.error('[Geniwork] Gmail erreur:', err.message);
    return res.status(500).json({ error: 'Envoi échoué : ' + err.message });
  }
};

/* ════════════════════════════════════
   TEMPLATES HTML
════════════════════════════════════ */
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
            Pour activer votre compte <strong style="color:#1a2a5e;">${email}</strong>, entrez ce code :
          </p>
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td align="center" style="padding:8px 0 32px;">
              <div style="display:inline-block;background:#f0f4ff;border:2px solid #3b5bdb;border-radius:14px;padding:20px 48px;">
                <span style="font-size:44px;font-weight:700;letter-spacing:16px;color:#1a2a5e;">${code}</span>
              </div>
            </td></tr>
          </table>
          <p style="color:#888;font-size:13px;margin:0 0 8px;">⏱ Ce code expire dans <strong>10 minutes</strong>.</p>
          <p style="color:#888;font-size:13px;margin:0 0 16px;">Si vous n'avez pas créé ce compte, ignorez cet e-mail.</p>
          <div style="background:#FEF9C3;border-left:4px solid #EAB308;border-radius:8px;padding:10px 14px;font-size:12.5px;color:#854D0E;">
            📬 <strong>Pas trouvé ?</strong> Vérifiez votre dossier <strong>Spams</strong> et marquez-le <em>"Pas un spam"</em>.
          </div>
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
            Demande de réinitialisation pour <strong style="color:#1a2a5e;">${email}</strong>.<br>
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
          <p style="color:#888;font-size:13px;margin:0 0 16px;">Si vous n'avez pas fait cette demande, ignorez cet e-mail — votre compte est sécurisé.</p>
          <div style="background:#FEF9C3;border-left:4px solid #EAB308;border-radius:8px;padding:10px 14px;font-size:12.5px;color:#854D0E;">
            📬 <strong>Pas trouvé ?</strong> Vérifiez votre dossier <strong>Spams</strong>.
          </div>
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
