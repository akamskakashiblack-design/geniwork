/* ═══════════════════════════════════════════════════════════════
   GENIWORK — POST /api/subscriptions/sync-status (Phase PAYPAL-SUB-FIX-01)

   Vérification d'expiration SERVEUR-authoritaire (architecture Option B).
   Remplace le calcul + l'écriture Firebase directe côté client de
   l'ancienne _subCheckRenewalAndExpiry() (js/app.js) — corrige la faille
   identifiée en PAYPAL-SUB-AUDIT-02. Le client n'appelle plus que cet
   endpoint (typiquement au login) et affiche la réponse ; il ne calcule
   ni n'écrit plus jamais lui-même l'expiration.

   Body : { authRefreshToken }
   Réponse : { ok:true, downgraded, planType, planBilling, planRenewalDate,
               planStatus, planCancelled } ou { ok:false, error }
═══════════════════════════════════════════════════════════════ */

const { dbGet, dbUpdate, emailKey } = require('../admin/_lib/fbrest');
const { verify: verifyRefreshToken } = require('../auth/_lib/refreshToken');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Method not allowed' }); return; }

  try {
    const body = req.body || {};

    const ticketData = verifyRefreshToken(body.authRefreshToken);
    if (!ticketData || !ticketData.email) {
      res.status(401).json({ ok: false, error: 'Session expirée, reconnectez-vous.' });
      return;
    }
    const callerEmail = ticketData.email;
    const key = emailKey(callerEmail);

    let profile;
    try { profile = await dbGet('/gw/profiles/' + key); } catch (e) {
      res.status(500).json({ ok: false, error: 'Erreur serveur' });
      return;
    }
    if (!profile || !profile.planType || profile.planType === 'free') {
      res.status(200).json({ ok: true, downgraded: false, planType: 'free', planStatus: null });
      return;
    }

    const nowMs = Date.now();
    const renewalMs = profile.planRenewalDate ? Date.parse(profile.planRenewalDate) : NaN;
    if (!Number.isFinite(renewalMs) || nowMs < renewalMs) {
      /* Pas encore expiré : aucune écriture, on renvoie l'état tel quel
         (compatibilité anciens profils : planStatus absent -> 'active'). */
      res.status(200).json({
        ok: true,
        downgraded: false,
        planType: profile.planType,
        planBilling: profile.planBilling || null,
        planRenewalDate: profile.planRenewalDate || null,
        planStatus: profile.planStatus || 'active',
        planCancelled: !!profile.planCancelled,
      });
      return;
    }

    /* ── Expiration atteinte : downgrade serveur-authoritaire (PATCH uniquement). ── */
    const wasSubscriptionBadge = profile.badgeSource === 'subscription';
    const patch = {
      planType: 'free',
      planBilling: null,
      planRenewalDate: null,
      planStatus: 'expired',
      planCancelled: false,
      planCancelledAt: null,
    };
    if (wasSubscriptionBadge) {
      patch.badgeType = null;
      patch.badgeStatus = null;
      patch.badgeApprovedAt = null;
      patch.badgeSource = null;
    }
    try {
      await dbUpdate('/gw/profiles/' + key, patch);
    } catch (e) {
      res.status(500).json({ ok: false, error: 'Erreur serveur' });
      return;
    }

    res.status(200).json({ ok: true, downgraded: true, planType: 'free', planStatus: 'expired' });
  } catch (err) {
    console.error('[Geniwork Subscriptions] erreur sync-status:', err.message);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
};
