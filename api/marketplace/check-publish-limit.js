/* ═══════════════════════════════════════════════════════════════
   GENIWORK — POST /api/marketplace/check-publish-limit (Phase 7D-BIS)

   Dependance 1 identifiee en Phase 7D : maxListings (Free=3) ne peut
   pas etre garanti par les seules regles Firebase (impossible d'y
   compter les enfants actifs d'un nombre arbitraire — meme limitation
   structurelle que celle demontree en Phase 7C pour l'ancien tableau).
   Cet endpoint fournit la verification serveur manquante.

   Ne fait JAMAIS confiance a un email/planType/count fourni par le
   client — identite derivee uniquement de authRefreshToken, plan lu
   depuis gw/profiles (source serveur), comptage lu depuis Firebase
   (jamais depuis un cache local).

   Definition de "annonce active" : identique a _mkCanPublish() cote
   client (js/app.js) — status==='active' exactement, aucune
   verification supplementaire d'expiresAt (comportement existant
   fidelement reproduit, rien invente). 'sold'/'expired'/annonces
   supprimees ne comptent jamais.

   Phase 9F-bis : le fallback de lecture gw/mk_listings (legacy) a ete
   retire — comparaison exhaustive LIVE (9F-bis.6) confirmee : gw/mk_listings_v2
   est un sur-ensemble complet par id des annonces actives du legacy
   (0 annonce active presente uniquement dans le legacy). Seul
   gw/mk_listings_v2/{sellerUid} compte desormais.

   Body : { authRefreshToken }
   Réponse : { ok:true, allowed, plan, maxListings, activeCount }
          ou { ok:false, error }
═══════════════════════════════════════════════════════════════ */

const { dbGet, emailKey } = require('../admin/_lib/fbrest');
const { verify: verifyRefreshToken } = require('../auth/_lib/refreshToken');

/* Identique a _MK_PLAN_LIMITS.maxListings (js/app.js) */
const MAX_LISTINGS = { free: 3, premium: Infinity, business: Infinity };

function normalizePlan(planType) {
  if (planType === 'premium' || planType === 'business') return planType;
  return 'free';
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Method not allowed' }); return; }

  try {
    const body = req.body || {};

    /* ── Identité : dérivée UNIQUEMENT du jeton signé — jamais d'un
       email/planType/count fourni par le client. ── */
    const ticketData = verifyRefreshToken(body.authRefreshToken);
    if (!ticketData || !ticketData.email) {
      res.status(401).json({ ok: false, error: 'Session expirée, reconnectez-vous.' });
      return;
    }
    const email = ticketData.email;
    const uid = emailKey(email);

    let profile;
    try { profile = await dbGet('/gw/profiles/' + uid); } catch (e) {
      res.status(500).json({ ok: false, error: 'Erreur serveur' });
      return;
    }
    const plan = normalizePlan(profile && profile.planType);
    const maxListings = MAX_LISTINGS[plan];

    if (maxListings === Infinity) {
      res.status(200).json({ ok: true, allowed: true, plan: plan, maxListings: null, activeCount: 0 });
      return;
    }

    const countedIds = new Set();
    let activeCount = 0;

    try {
      const bySeller = await dbGet('/gw/mk_listings_v2/' + uid);
      if (bySeller && typeof bySeller === 'object') {
        Object.values(bySeller).forEach((l) => {
          if (l && l.status === 'active' && l.id && !countedIds.has(l.id)) { countedIds.add(l.id); activeCount++; }
        });
      }
    } catch (e) { /* noeud absent ou vide -> 0, non bloquant */ }

    res.status(200).json({ ok: true, allowed: activeCount < maxListings, plan: plan, maxListings: maxListings, activeCount: activeCount });
  } catch (err) {
    console.error('[Geniwork Marketplace] erreur check-publish-limit:', err.message);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
};
