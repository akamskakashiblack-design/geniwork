const { readProfile, patchProfile } = require('./firebaseAdmin');

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
 * Lit le profil, applique le renouvellement mensuel si necessaire,
 * et renvoie l'etat courant (plan, credits, etc.) sans rien deduire.
 */
async function getCreditState(email) {
  const { data } = await readProfile(email);
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

/**
 * Deduit le cout du solde courant (a appeler seulement apres une
 * generation reussie, pour ne jamais facturer un appel qui a echoue).
 */
async function consumeCredits(email, cost, currentState) {
  const newCredits = Math.max(0, currentState.credits - cost);
  await patchProfile(email, { aiCredits: newCredits });
  return Object.assign({}, currentState, { credits: newCredits });
}

module.exports = { PLAN_CONFIG, getCreditState, consumeCredits, normalizePlan };
