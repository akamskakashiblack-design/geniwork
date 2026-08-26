/* ═══════════════════════════════════════════════════════════════
   GENIWORK — POST /api/jobs/apply (Phase 8C, chemins ajustes Phase 8D)
   Etape 1/1 de la securisation de la candidature Emploi (architecture
   validee en Phase 8B, testee 19/19 + 6/6 non-divulgation).

   Phase 8E : appele par _jobSubmitSimplifiedApply() (mode:'simplified',
   CV+telephone requis) ET _jobApplyExternal() (mode:'external', aucun CV/
   telephone collecte — seul un enregistrement leger est ecrit pour le
   tableau de bord recruteur / compteur de clics, identique au
   comportement client historique). Dans les deux cas, seul point
   d'ecriture d'une candidature : le client n'ecrit plus jamais
   directement gw/job_applications_v2 ni gw/candidate_applications ni un
   quelconque applicants[] (retire du schema, Phase 8B). L'ancien tableau
   plat gw/job_applications reste present mais n'a plus aucun ecrivain
   actif (legacy, ferme par la phase dediee 8F).

   Phase 8D : lit/ecrit gw/jobs_v2 et gw/job_applications_v2 (suffixe
   "_v2", jamais gw/jobs / gw/job_applications) — l'ancien tableau plat
   occupe deja ces noms exacts en production (structure incompatible :
   un chemin RTDB ne peut pas etre a la fois un tableau et un objet
   imbrique). Meme methode que gw/mk_listings_v2 (Phase 7D/7E) : nouveau
   noeud independant le temps de la migration/bascule, legacy jamais
   touche, fermeture definitive de l'ancien noeud reservee a une phase
   dediee (8F, miroir de 7F). gw/candidate_applications n'a pas
   d'equivalent legacy, aucun renommage necessaire.

   Body : { authRefreshToken, jobId, mode:'simplified'|'external', cv:{name,data}, phone, motivation }
          (cv/phone/motivation ignores si mode==='external')
   Reponse : { ok:true, applicationId } ou { ok:false, error }
═══════════════════════════════════════════════════════════════ */

const { dbGet, dbUpdate, emailKey, checkRateLimit } = require('../admin/_lib/fbrest');
const { verify: verifyRefreshToken } = require('../auth/_lib/refreshToken');

/* Identique a la limite cote client (_jobPickCV, js/app.js :
   file.size > 5*1024*1024 -> refus). Une fois encode en base64
   (ratio ~4/3) + prefixe data-URI, un fichier de 5 Mo produit une
   chaine d'environ 6.7 Mo — la limite serveur inclut une marge sans
   jamais accepter un CV que le client refuserait deja aujourd'hui. */
const MAX_CV_DATA_LENGTH = 7 * 1024 * 1024;

function isValidJobId(v) { return typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v); }

/* Recherche le job par jobId a travers tous les recruteurs (compte de
   service, lecture complete gw/jobs) — jamais un recruiterUid fourni
   par le client. Meme methode que resolveListing() en Phase 7D-BIS
   pour mk_listings_v2 ; a l'echelle actuelle (quelques recruteurs,
   Phase 8B §17), un scan complet reste largement suffisant. */
async function resolveJob(jobId) {
  let allByRecruiter;
  try { allByRecruiter = await dbGet('/gw/jobs_v2'); } catch (e) { return null; }
  if (!allByRecruiter || typeof allByRecruiter !== 'object') return null;
  for (const recruiterUid of Object.keys(allByRecruiter)) {
    const byId = allByRecruiter[recruiterUid];
    if (byId && byId[jobId]) return { recruiterUid: recruiterUid, job: byId[jobId] };
  }
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Method not allowed' }); return; }

  try {
    const body = req.body || {};

    /* ── Identité : dérivée UNIQUEMENT du jeton signé — le client ne
       fournit jamais candidateUid/applicantEmail/jobOwnerUid/postedBy
       comme autorité, quelle que soit la valeur envoyée dans le body. ── */
    const ticketData = verifyRefreshToken(body.authRefreshToken);
    if (!ticketData || !ticketData.email) {
      res.status(401).json({ ok: false, error: 'Session expirée, reconnectez-vous.' });
      return;
    }
    const candidateEmail = ticketData.email;
    const candidateUid = emailKey(candidateEmail);

    /* Phase SYNC-64 : rate-limit fail-closed, avant toute résolution
       coûteuse (resolveJob() scanne gw/jobs_v2 en entier) — l'anti-doublon
       existant (applicationId=jobId_candidateUid) ne bloque qu'une même
       offre, pas des candidatures répétées sur des offres distinctes. CV
       jusqu'à ~7 Mo (MAX_CV_DATA_LENGTH) : seuil aligné sur le précédent
       upload le plus proche du projet (groups/cover-upload.js, 10/h
       fail-closed), plutôt qu'une valeur inventée. */
    const rl = await checkRateLimit('jobs:apply:' + candidateUid, 10, 60 * 60 * 1000);
    if (rl.ok === false) { res.status(429).json({ ok: false, error: 'Trop de candidatures récentes. Réessayez dans ' + rl.retryAfterSec + 's.' }); return; }
    if (rl.ok === null) { res.status(503).json({ ok: false, error: 'Service de protection anti-abus temporairement indisponible.' }); return; }

    if (!isValidJobId(body.jobId)) {
      res.status(400).json({ ok: false, error: 'jobId invalide' });
      return;
    }
    const mode = body.mode === 'external' ? 'external' : 'simplified';

    /* Le mode "external" (candidat redirigé vers le site du recruteur) ne
       collecte ni CV ni téléphone côté Geniwork — identique au comportement
       client historique (_jobApplyExternal), seul un enregistrement léger
       est conservé pour le tableau de bord recruteur / compteur de clics. */
    if (mode === 'simplified') {
      if (!body.cv || typeof body.cv.data !== 'string' || !body.cv.data) {
        res.status(400).json({ ok: false, error: 'CV requis' });
        return;
      }
      if (body.cv.data.length > MAX_CV_DATA_LENGTH) {
        res.status(400).json({ ok: false, error: 'Fichier CV trop volumineux (max 5 Mo)' });
        return;
      }
    }
    const phone = String(body.phone || '').trim();
    if (mode === 'simplified' && !phone) {
      res.status(400).json({ ok: false, error: 'Téléphone requis' });
      return;
    }

    const resolved = await resolveJob(body.jobId);
    if (!resolved) {
      res.status(404).json({ ok: false, error: 'Offre introuvable' });
      return;
    }
    const recruiterUid = resolved.recruiterUid;
    const job = resolved.job;

    if (job.status !== 'active') {
      res.status(409).json({ ok: false, error: 'Cette offre n\'est plus disponible' });
      return;
    }
    if (job.postedBy && job.postedBy.toLowerCase() === candidateEmail.toLowerCase()) {
      res.status(403).json({ ok: false, error: 'Impossible de postuler à votre propre offre' });
      return;
    }

    /* ── Anti-doublon (Phase 8C.6) : clé déterministe, vérification
       serveur avant écriture — jamais le tableau applicants[] côté
       client (retiré du schéma cible, Phase 8B). ── */
    const applicationId = body.jobId + '_' + candidateUid;
    let already;
    try { already = await dbGet('/gw/job_applications_v2/' + recruiterUid + '/' + applicationId); } catch (e) {
      res.status(500).json({ ok: false, error: 'Erreur serveur' });
      return;
    }
    if (already) {
      res.status(409).json({ ok: false, error: 'Vous avez déjà postulé à cette offre' });
      return;
    }

    /* Nom du candidat : depuis le profil serveur, jamais depuis le body. */
    let profile;
    try { profile = await dbGet('/gw/profiles/' + candidateUid); } catch (e) { profile = null; }
    const candidateNom = (profile && profile.nom) || candidateEmail;

    const now = new Date().toISOString();

    const applicationFull = {
      id: applicationId,
      jobId: body.jobId,
      jobTitle: job.title || '',
      candidateUid: candidateUid,
      applicantEmail: candidateEmail,
      applicantNom: candidateNom,
      mode: mode,
      archived: false,
      appliedAt: now,
    };
    if (mode === 'simplified') {
      applicationFull.cv = { name: String(body.cv.name || 'cv').slice(0, 200), data: body.cv.data };
      applicationFull.phone = phone.slice(0, 40);
      applicationFull.motivation = String(body.motivation || '').trim().slice(0, 2000);
    }
    const applicationPointer = {
      id: applicationId,
      jobId: body.jobId,
      jobOwnerUid: recruiterUid,
      jobTitle: job.title || '',
      appliedAt: now,
      mode: mode,
    };

    /* ── Écriture atomique multi-chemin (Phase 8C.7) : les deux
       emplacements apparaissent ensemble ou pas du tout. Si le PATCH
       échoue, aucune moitié de candidature n'est jamais écrite —
       Firebase applique une mise à jour multi-chemin comme une seule
       opération transactionnelle. ── */
    try {
      await dbUpdate('/', {
        ['gw/job_applications_v2/' + recruiterUid + '/' + applicationId]: applicationFull,
        ['gw/candidate_applications/' + candidateUid + '/' + applicationId]: applicationPointer,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: 'Erreur serveur' });
      return;
    }

    res.status(200).json({ ok: true, applicationId: applicationId });
  } catch (err) {
    console.error('[Geniwork Jobs] erreur apply:', err.message);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
};
