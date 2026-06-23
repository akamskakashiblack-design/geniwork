/* ═══════════════════════════════════════════════════════════════
   GENIWORK — Envoi du code de vérification / réinitialisation
   POST /api/send-code  { email, code, type }
   type = "register" | "reset"

   Méthode principale : Gmail SMTP (gratuit, sans domaine requis)
   → Variables Vercel requises : GMAIL_USER, GMAIL_APP_PASSWORD
   → Mot de passe d'application : myaccount.google.com/apppasswords

   Repli automatique : Resend.com si GMAIL_USER absent
   → Variable Vercel : RESEND_API_KEY (nécessite un domaine vérifié
     pour envoyer à des destinataires autres que le propriétaire du compte)
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

  var isReset  = type === 'reset';
  var subject  = isReset
    ? 'Geniwork — Réinitialisation de mot de passe'
    : 'Geniwork — Code de vérification de votre compte';
  var html = isReset ? buildResetHtml(code, email) : buildRegisterHtml(code, email);
  var text = isReset
    ? 'Geniwork — Réinitialisation\n\nCode : ' + code + '\n\nExpire dans 10 minutes.'
    : 'Geniwork — Vérification\n\nCode : ' + code + '\n\nExpire dans 10 minutes.';

  var gmailUser = process.env.GMAIL_USER;
  var gmailPass = process.env.GMAIL_APP_PASSWORD;

  if (gmailUser && gmailPass) {
    try {
      var transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: gmailUser, pass: gmailPass }
      });
      var info = await transporter.sendMail({
        from:    'Geniwork <' + gmailUser + '>',
        to:      email,
        subject: subject,
        html:    html,
        text:    text
      });
      console.log('[Geniwork] ✅ Email envoyé via Gmail:', info.messageId);
      return res.status(200).json({ ok: true, via: 'gmail', id: info.messageId });
    } catch (err) {
      console.error('[Geniwork] Erreur Gmail SMTP:', err.message);
      return res.status(500).json({ error: 'Erreur envoi Gmail : ' + err.message });
    }
  }

  var apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('[Geniwork] Aucun service email configuré (ni GMAIL_USER, ni RESEND_API_KEY).');
    return res.status(500).json({ error: 'Service email non configuré. Ajoutez GMAIL_USER + GMAIL_APP_PASSWORD dans Vercel.' });
  }

  try {
    var resp = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({
        from:    'Geniwork <onboarding@resend.dev>',
        to:      [email],
        subject: subject,
        html:    html,
        text:    text
      })
    });

    var data = await resp.json();

    if (resp.ok && data.id) {
      console.log('[Geniwork] ✅ Email envoyé via Resend:', data.id);
      return res.status(200).json({ ok: true, via: 'resend', id: data.id });
    }

    console.error('[Geniwork] Resend erreur:', JSON.stringify(data));
    return res.status(500).json({ error: data.message || 'Erreur Resend', detail: data });

  } catch (err) {
    console.error('[Geniwork] Erreur fetch Resend:', err.message);
    return res.status(500).json({ error: 'Erreur réseau : ' + err.message });
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
