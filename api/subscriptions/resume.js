/* ═══════════════════════════════════════════════════════════════
   GENIWORK — POST /api/subscriptions/resume (Phase PAYPAL-SUB-FIX-02)

   Réactivation serveur-authoritaire d'un abonnement annulé (miroir
   exact de cancel.js) — corrige la dernière écriture Firebase directe
   côté client identifiée en PAYPAL-SUB-FIX-01 (§12 Risques).

   Autorisé UNIQUEMENT si planStatus==='cancelled' ET now < planRenewalDate
   (une réactivation après expiration n'a pas de sens — le compte est déjà
   repassé en free par sync-status.js ; il faut alors un nouveau paiement,
   pas une réactivation).

   planType/planBilling/planRenewalDate ne sont jamais modifiés — seul le
   statut d'annulation est inversé.

   Body : { authRefreshToken }
   Réponse : { ok:true, planStatus:'active' } ou { ok:false, error }
═══════════════════════════════════════════════════════════════ */

const { dbGet, dbGetWithETag, dbSetIfMatch, dbUpdate, emailKey } = require('../admin/_lib/fbrest');
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
      res.status(400).json({ ok: false, error: 'Aucun abonnement à réactiver' });
      return;
    }

    /* Idempotent : déjà actif -> aucune écriture, réponse ok. */
    if (profile.planStatus === 'active') {
      res.status(200).json({ ok: true, alreadyActive: true, planStatus: 'active' });
      return;
    }

    /* Réactivation impossible si déjà expiré, ou si le statut n'est pas
       'cancelled', ou si la période est déjà dépassée (dans ce cas,
       sync-status.js aura déjà — ou va — repasser le compte en free ;
       la seule voie de retour est un nouveau paiement, pas une reprise). */
    const renewalMs = profile.planRenewalDate ? Date.parse(profile.planRenewalDate) : NaN;
    const withinPeriod = Number.isFinite(renewalMs) && Date.now() < renewalMs;
    if (profile.planStatus !== 'cancelled' || !withinPeriod) {
      res.status(409).json({ ok: false, error: 'Réactivation impossible (abonnement non annulé ou période expirée)' });
      return;
    }

    /* ── Anti-rejeu atomique (ETag/If-Match) — identique au pattern de cancel.js. ── */
    let statusRead;
    try { statusRead = await dbGetWithETag('/gw/profiles/' + key + '/planStatus'); } catch (e) {
      res.status(500).json({ ok: false, error: 'Erreur serveur' });
      return;
    }
    if (statusRead.value !== 'cancelled') {
      /* Changé entre-temps (concurrence) — jamais réactiver un état qu'on n'a pas vérifié soi-même. */
      res.status(409).json({ ok: false, error: 'Réactivation impossible (abonnement non annulé ou période expirée)' });
      return;
    }
    let lock;
    try { lock = await dbSetIfMatch('/gw/profiles/' + key + '/planStatus', 'active', statusRead.etag); } catch (e) {
      res.status(500).json({ ok: false, error: 'Erreur serveur' });
      return;
    }
    if (!lock.ok) {
      res.status(409).json({ ok: false, error: 'Conflit, réessayez' });
      return;
    }

    /* ── PATCH uniquement — planType/planBilling/planRenewalDate conservés. ── */
    try {
      await dbUpdate('/gw/profiles/' + key, { planCancelled: false, planCancelledAt: null });
    } catch (e) {
      res.status(500).json({ ok: false, error: 'Erreur serveur' });
      return;
    }

    res.status(200).json({ ok: true, planStatus: 'active', planType: profile.planType, planBilling: profile.planBilling || null, planRenewalDate: profile.planRenewalDate || null });
  } catch (err) {
    console.error('[Geniwork Subscriptions] erreur resume:', err.message);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
};
