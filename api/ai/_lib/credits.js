const { readProfile, patchProfile, readAiCreditsWithETag, patchAiCreditsIfMatch } = require('./firebaseAdmin');

const PLAN_CONFIG = {
  free: { credits: 10, renews: false },
  premium: { credits: 150, renews: true },
  business: { credits: 500, renews: true },
};

function currentMonthKey() {
  const d = new Date();
  return d.getFullYear() + '-' + (d.getMonth() + 1);
}

function normalizePlan(planType) {
  if (planType === 'premium' || planType === 'business') return planType;
  return 'free';
}

/**
 * Phase 6C-5 : expiration cote serveur — un planType payant dont la
 * date de renouvellement est depassee n'est plus jamais fait confiance,
 * meme si le client n'a jamais declenche son propre downgrade local
 * (_subCheckRenewalAndExpiry(), js/app.js, qui ne s'execute qu'au
 * chargement de l'app). Auto-corrige aussi le profil (best-effort,
 * jamais bloquant si l'ecriture echoue) pour que la prochaine lecture
 * n'ait plus a refaire ce calcul.
 */
function isPlanExpired(data) {
  if (!data.planRenewalDate) return false;
  const renewalMs = Date.parse(data.planRenewalDate);
  return Number.isFinite(renewalMs) && Date.now() >= renewalMs;
}

/**
 * Lit le profil, applique le renouvellement mensuel si necessaire,
 * et renvoie l'etat courant (plan, credits, etc.) sans rien deduire.
 */
async function getCreditState(email) {
  const { data } = await readProfile(email);

  if (data.planType && data.planType !== 'free' && isPlanExpired(data)) {
    const patch = { planType: 'free', planBilling: null, planRenewalDate: null, planCancelled: false };
    /* Phase 6C-9 : le badge accorde par capture-order.js (badgeType:'premium',
       badgeSource:'subscription') est retire en meme temps que le plan —
       jusqu'ici seul planType redescendait a l'expiration (Phase 6C-5), le
       badge "couronne" restait indefiniment sur le profil. Ne touche jamais
       un badge admin (badgeSource!=='subscription', ex: 'verified'/'certified'
       accorde via api/admin/moderate.js), conformement a l'exigence que
       l'expiration d'un abonnement ne doit jamais retirer un badge
       administratif independant. */
    if (data.badgeSource === 'subscription') {
      patch.badgeType = null;
      patch.badgeStatus = null;
      patch.badgeApprovedAt = null;
      patch.badgeSource = null;
    }
    try {
      await patchProfile(email, patch);
    } catch (e) {
      console.error('[Geniwork AI] echec auto-correction expiration (non bloquant):', e.message);
    }
    data.planType = 'free';
  }

  const plan = normalizePlan(data.planType);
  const cfg = PLAN_CONFIG[plan];

  let credits = typeof data.aiCredits === 'number' ? data.aiCredits : null;
  let cycleMonth = data.aiCycleMonth || null;
  const planChanged = data.aiPlanGranted !== plan;

  if (credits === null) {
    /* Premiere utilisation : on accorde le quota du plan actuel. */
    credits = cfg.credits;
    cycleMonth = currentMonthKey();
    await patchProfile(email, { aiCredits: credits, aiCycleMonth: cycleMonth, aiPlanGranted: plan });
  } else if (cfg.renews && planChanged) {
    /* Souscription/changement vers un plan payant (ex: PayPal confirme) :
       les credits du nouveau plan sont accordes immediatement, sans
       attendre le prochain mois. */
    credits = cfg.credits;
    cycleMonth = currentMonthKey();
    await patchProfile(email, { aiCredits: credits, aiCycleMonth: cycleMonth, aiPlanGranted: plan });
  } else if (cfg.renews && cycleMonth !== currentMonthKey()) {
    /* Renouvellement mensuel normal. */
    credits = cfg.credits;
    cycleMonth = currentMonthKey();
    await patchProfile(email, { aiCredits: credits, aiCycleMonth: cycleMonth, aiPlanGranted: plan });
  } else if (!cfg.renews && planChanged && credits > cfg.credits) {
    /* Retour au plan Gratuit apres un plan payant : on plafonne le solde
       au quota Gratuit pour eviter de "banquer" des credits payants en
       souscrivant puis en annulant immediatement. */
    credits = cfg.credits;
    await patchProfile(email, { aiCredits: credits, aiPlanGranted: plan });
  }

  return { plan, credits, cycleMonth, planCredits: cfg.credits, renews: cfg.renews };
}

const RESERVE_RETRY_ATTEMPTS = 4;

/**
 * Phase AI-3 : reserve le cout de maniere ATOMIQUE (ecriture
 * conditionnelle ETag/If-Match, meme mecanisme que le Marketplace
 * Phase 6B-5) AVANT d'appeler le fournisseur IA — plus jamais un
 * "lire solde -> verifier -> generer -> deduire" en 2 etapes non
 * synchronisees, qui permettait a deux requetes concurrentes de
 * consommer/depasser le meme credit. Si le fournisseur echoue ensuite,
 * refundCredits() restitue le cout reserve (voir chat.js) : la regle
 * "ne jamais facturer un appel qui a echoue" reste respectee, par un
 * remboursement explicite plutot que par une deduction differee.
 */
async function reserveCredits(email, cost) {
  for (let attempt = 0; attempt < RESERVE_RETRY_ATTEMPTS; attempt++) {
    const { credits, etag } = await readAiCreditsWithETag(email);
    const current = typeof credits === 'number' ? credits : 0;
    if (current < cost) return { ok: false, credits: current };
    const newCredits = current - cost;
    const result = await patchAiCreditsIfMatch(email, newCredits, etag);
    if (result.ok) return { ok: true, credits: newCredits };
    /* conflict : une autre requete a modifie le solde entre-temps -> reessaie avec la valeur fraiche */
  }
  return { ok: false, conflict: true };
}

/**
 * Remboursement best-effort (ecriture conditionnelle egalement, pour ne
 * jamais ecraser une deduction concurrente legitime survenue entre
 * temps). Ne leve jamais — un echec de remboursement est logge mais ne
 * doit jamais transformer une erreur de generation en erreur HTTP 500
 * supplementaire pour l'utilisateur.
 */
async function refundCredits(email, cost) {
  for (let attempt = 0; attempt < RESERVE_RETRY_ATTEMPTS; attempt++) {
    try {
      const { credits, etag } = await readAiCreditsWithETag(email);
      const current = typeof credits === 'number' ? credits : 0;
      const newCredits = current + cost;
      const result = await patchAiCreditsIfMatch(email, newCredits, etag);
      if (result.ok) return newCredits;
    } catch (e) {
      console.error('[Geniwork AI] echec remboursement credits (tentative ' + attempt + '):', e.message);
      return null;
    }
  }
  console.error('[Geniwork AI] echec remboursement credits apres ' + RESERVE_RETRY_ATTEMPTS + ' tentatives (conflits repetes)');
  return null;
}

module.exports = { PLAN_CONFIG, getCreditState, reserveCredits, refundCredits, normalizePlan };
