/* ═══════════════════════════════════════════════════════════════
   GENIWORK — POST /api/subscriptions/cancel (Phase PAYPAL-SUB-FIX-01)

   Résiliation serveur-authoritaire (architecture Option B validée en
   PAYPAL-SUB-ARCH-APPROVAL) : l'accès reste valable jusqu'à
   planRenewalDate — aucune suppression immédiate, aucun remboursement
   ici (voir refund.js séparément). Écrit UNIQUEMENT via le compte de
   service (dbUpdate PATCH), jamais par le client — corrige la faille
   identifiée en PAYPAL-SUB-AUDIT-02 (écriture Firebase directe côté
   client, bloquée silencieusement par les Rules `.validate` immuables
   sur planCancelled).

   Idempotent : un second appel sur un plan déjà cancelled/expired ne
   fait rien et renvoie ok:true (alreadyCancelled:true).

   Compatibilité anciens profils : un profil avec planType payant mais
   sans planStatus explicite (créé avant cette phase) est interprété
   comme 'active'.

   Body : { authRefreshToken }
   Réponse : { ok:true, planStatus, accessUntil } ou { ok:false, error }
═══════════════════════════════════════════════════════════════ */

const { dbGet, dbGetWithETag, dbSetIfMatch, dbUpdate, emailKey, checkRateLimit } = require('../admin/_lib/fbrest');
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

    /* Phase SYNC-55 : rate-limit fail-closed — action destructrice sur l'abonnement. */
    const rl = await checkRateLimit('subscriptions:cancel:' + key, 5, 60 * 60 * 1000);
    if (rl.ok === false) { res.status(429).json({ ok: false, error: 'Trop de tentatives récentes. Réessayez dans ' + rl.retryAfterSec + 's.' }); return; }
    if (rl.ok === null) { res.status(503).json({ ok: false, error: 'Service de protection anti-abus temporairement indisponible.' }); return; }

    let profile;
    try { profile = await dbGet('/gw/profiles/' + key); } catch (e) {
      res.status(500).json({ ok: false, error: 'Erreur serveur' });
      return;
    }
    if (!profile || !profile.planType || profile.planType === 'free') {
      res.status(400).json({ ok: false, error: 'Aucun abonnement actif' });
      return;
    }

    const effectiveStatus = profile.planStatus || 'active';
    if (effectiveStatus === 'cancelled' || effectiveStatus === 'expired') {
      res.status(200).json({ ok: true, alreadyCancelled: true, planStatus: effectiveStatus, accessUntil: profile.planRenewalDate || null });
      return;
    }

    /* ── Anti-rejeu atomique (ETag/If-Match) — identique au pattern déjà
       validé sur capture-order.js (Marketplace + Subscriptions). ── */
    let statusRead;
    try { statusRead = await dbGetWithETag('/gw/profiles/' + key + '/planStatus'); } catch (e) {
      res.status(500).json({ ok: false, error: 'Erreur serveur' });
      return;
    }
    let lock;
    try { lock = await dbSetIfMatch('/gw/profiles/' + key + '/planStatus', 'cancelled', statusRead.etag); } catch (e) {
      res.status(500).json({ ok: false, error: 'Erreur serveur' });
      return;
    }
    if (!lock.ok) {
      res.status(409).json({ ok: false, error: 'Conflit, réessayez' });
      return;
    }

    const nowISO = new Date().toISOString();
    try {
      await dbUpdate('/gw/profiles/' + key, { planCancelled: true, planCancelledAt: nowISO });
    } catch (e) {
      res.status(500).json({ ok: false, error: 'Erreur serveur' });
      return;
    }

    res.status(200).json({ ok: true, planStatus: 'cancelled', accessUntil: profile.planRenewalDate || null });
  } catch (err) {
    console.error('[Geniwork Subscriptions] erreur cancel:', err.message);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
};
