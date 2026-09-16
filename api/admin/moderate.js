/* ═══════════════════════════════════════════════════════════════
   GENIWORK — POST /api/admin/moderate
   Ecritures globales reservees aux admins (bannissements, config des
   plans/support, logo officiel, activation du module Emploi, badges).
   Avant : le client ecrivait directement ces noeuds Firebase, lisibles
   ET modifiables par n'importe quel visiteur (session anonyme).
   Body: { token, action, ...donnees selon l'action }
   Actions : setBans, setPlansConfig, setSupportConfig, setSettingsLogo,
             setJobsEnabled, approveBadge, revokeBadge, certifyUser,
             rejectBadge

   Phase 6C-7 : approveBadge/revokeBadge/rejectBadge/certifyUser
   ecrivent gw/profiles/{targetEmailKey} via le compte de service
   (dbUpdate, PATCH — jamais un .set() complet, pour ne jamais
   ecraser les autres champs du profil cible). Necessaire pour que
   gw/profiles puisse etre restreint a "auth.uid === $userFbKey" cote
   regles sans casser ces 4 actions admin (qui ecrivent legitimement
   sur le profil d'un AUTRE utilisateur — jusqu'ici la seule "protection"
   etait une garde cote UI, _admHasAction()/_admIsSA(), jamais verifiee
   serveur). Comme les autres actions de ce fichier, verifie seulement
   qu'une session admin valide existe (meme niveau de verification que
   setPlansConfig/setBans deja en production) — pas encore le systeme
   de permissions granulaire par role (_ADM_ROLE_PERMS, cote client
   uniquement), sauf pour certifyUser qui verifie specifiquement le
   Super Admin (gw/sadmin), etant l'action la plus sensible.

   Phase 6C-9 : badgeSource distingue un badge accorde par abonnement
   (capture-order.js, badgeSource:'subscription') d'un badge accorde
   ici par un admin (badgeSource:null) — voir credits.js/isPlanExpired,
   qui n'efface automatiquement le badge a l'expiration QUE si
   badgeSource==='subscription', pour ne jamais retirer un badge
   administratif independant. Les 4 actions ci-dessous mettent donc
   toujours badgeSource:null : elles marquent explicitement le badge
   comme desormais sous controle admin, jamais lie a un abonnement.

   Phase 8C/8D : approveRecruiterVerif/rejectRecruiterVerif/
   revokeRecruiterVerif ecrivent gw/recruiter_verifs_v2/{applicantUid}/
   {verifId} (suffixe "_v2" — l'ancien tableau plat gw/recruiter_verifs
   occupe deja ce nom exact, cf. gw/mk_listings_v2 Phase 7D) via le
   compte de service (dbUpdate, PATCH cible — jamais les champs de la
   DEMANDE initiale : company/regnum/logo/submittedAt/email, uniquement
   les champs de DECISION). Meme niveau de verification que le reste de
   ce fichier (session admin valide). Cible la structure
   gw/jobs_v2/{recruiterUid}/{jobId} (Phase 8B/8D) pour cloturer les
   offres actives lors d'un revoke — jamais l'ancien tableau plat
   gw/jobs. Phase 8E : ces actions sont branchees au panel admin reel
   (_admApproveRecruiterVerif/_admRejectRecruiterVerif/
   _admRevokeRecruiterVerif, js/app.js). Phase 8F : gw/jobs, gw/job_applications
   et gw/recruiter_verifs ne sont plus jamais ecrits (ecriture fermee).
   Phase 8G : gw/jobs et gw/recruiter_verifs ne sont plus non plus
   lisibles (lecture fermee — les anciens applicants[] et les demandes de
   verification legacy ne sont plus accessibles, meme par un client
   authentifie) ; seul le compte de service (bypass total des regles,
   utilise par ce fichier) peut encore y acceder, pour un rollback
   eventuel. */

const { dbSet, dbGet, dbUpdate, dbRemove, emailKey, appendNotification, checkRateLimit } = require('./_lib/fbrest');
const { verify } = require('./_lib/session');

/* ═══════════════════════════════════════════════════════════════
   SYNC-141 — Granularité de rôle server-side.

   Copie server-side de la liste "actions" de _ADM_ROLE_PERMS (js/app.js) —
   uniquement les actions, jamais les onglets (non nécessaires ici). Dupliquée
   faute de module partagé entre js/app.js et api/admin/* ; à maintenir en
   synchronisation si _ADM_ROLE_PERMS change côté client. Référence exacte :
   js/app.js, const _ADM_ROLE_PERMS.
   ═══════════════════════════════════════════════════════════════ */
const ROLE_ACTIONS = {
  /* 'manage_settings'/'manage_recruiter_verif'/'manage_artiste'/'manage_tasks'/
     'reply_support' (SYNC-265) : permissions nouvelles, sans équivalent dans
     _ADM_ROLE_PERMS (js/app.js) — aucune garde client n'existait pour ces
     actions (SYNC-143/144), la permission requise a donc été fixée par
     décision produit explicite (SYNC-265), pas déduite du code. */
  'Super Admin': ['ban', 'unban', 'delete_post', 'delete_user', 'send_notif', 'publish', 'manage_team', 'manage_payments', 'change_settings', 'approve_badge', 'dismiss_report', 'warn_user', 'reset_password', 'change_role', 'approve_request', 'manage_settings', 'manage_recruiter_verif', 'manage_artiste', 'manage_tasks', 'reply_support'],
  'Admin':       ['ban', 'unban', 'delete_post', 'send_notif', 'publish', 'approve_badge', 'dismiss_report', 'warn_user'],
  'Modérateur':  ['ban', 'unban', 'dismiss_report', 'warn_user'],
  'Éditeur':     ['publish'],
  'Support':     ['warn_user', 'dismiss_report', 'reply_support'],
};

/* Mapping action moderate.js -> permission _ADM_ROLE_PERMS requise.
   UNIQUEMENT les actions pour lesquelles une garde client _admHasAction()
   démontrée existe (cf. rapport SYNC-141, section "Mapping action →
   permission → rôle") — jamais inventée. Les actions absentes de cette
   table n'ont aucune correspondance claire ; elles restent volontairement
   protégées par la seule session admin valide déjà en vigueur (comportement
   inchangé), documentées comme résiduelles dans le rapport plutôt que
   protégées par une supposition. `certifyUser` et `clearAllNotifs`
   conservent leur propre vérification Super Admin dédiée déjà existante,
   inchangée, et n'apparaissent donc pas ici. */
const ACTION_PERMISSION = {
  setPlansConfig:     'change_settings',
  setSupportConfig:   'change_settings',
  approveBadge:       'approve_badge',
  revokeBadge:        'approve_badge',
  rejectBadge:        'approve_badge',
  notifyBanApplied:   'ban',
  notifyBanLifted:    'unban',
  notifyUserWarned:   'warn_user',
  clearUserNotifs:    'send_notif',
  notifyBroadcast:    'send_notif',
  notifyOfficialPost: 'publish',
  /* SYNC-143 — quatre mappings démontrés par relecture complète des
     fonctions appelantes (cf. rapport SYNC-143), manqués par SYNC-141 qui
     n'avait vérifié que le voisinage immédiat de l'appel _admApi(), pas le
     sommet de la fonction englobante :
     - notifyRestrictionAppealRejected : _admResolveRstAppeal(id,'reject')
       est gardée par _admHasAction('dismiss_report') (js/app.js).
     - notifyBanAppealRejected : _admResolveAppeal(id,'reject') est gardée
       par _admHasAction('dismiss_report') (js/app.js), même pattern exact.
     - notifyRestrictionApplied : seul appelant MANUEL de la fonction
       partagée _gwApplyRestriction() est _admApplyManualRestriction(),
       gardée par _admHasAction('ban'). Les appelants AUTOMATIQUES
       (source='auto'/'auto_nsfw') appliquent toujours la restriction à
       _currentUser lui-même : la branche if/else-if de _gwApplyRestriction()
       les redirige donc structurellement vers un pushNotif() direct
       (self-notify), jamais vers cet appel serveur — cette action n'est
       DONC JOIGNABLE QUE depuis le chemin manuel déjà gardé. Vérifié ne
       jamais pouvoir casser le flux automatique, celui-ci n'atteint jamais
       ce code.
     - notifyRestrictionLifted : les DEUX seuls appelants de la fonction
       partagée _gwLiftRestriction() (_admLiftRestriction() et la branche
       'accept' de _admResolveRstAppeal()) sont chacun gardés par
       _admHasAction('unban') — aucun appelant automatique n'existe pour
       cette fonction. */
  notifyRestrictionAppealRejected: 'dismiss_report',
  notifyBanAppealRejected:         'dismiss_report',
  notifyRestrictionApplied:        'ban',
  notifyRestrictionLifted:         'unban',

  /* SYNC-265 — 11 des 12 actions restées sans mapping après SYNC-143/144
     (aucune garde client trouvée, cf. rapport SYNC-144) : décision produit
     explicite reçue (pas déduite du code) — Super Admin uniquement pour
     toutes, sauf notifySupportReply également ouverte à Support.
     notifyTaskDone reste volontairement hors de cette table : sa garde
     client réelle est fondée sur la propriété de la tâche (assignedTo),
     pas sur un rôle — non reproductible par ce mécanisme (cf. SYNC-144 §6,
     SYNC-265 §4), nécessite un mécanisme dédié, pas cette décision. */
  setSettingsLogo:       'manage_settings',
  setJobsEnabled:        'manage_settings',
  listRecruiterVerifs:   'manage_recruiter_verif',
  approveRecruiterVerif: 'manage_recruiter_verif',
  rejectRecruiterVerif:  'manage_recruiter_verif',
  revokeRecruiterVerif:  'manage_recruiter_verif',
  notifyArtisteApproved: 'manage_artiste',
  notifyArtisteRejected: 'manage_artiste',
  notifySongDeleted:     'manage_artiste',
  notifyTaskAssigned:    'manage_tasks',
  notifySupportReply:    'reply_support',
};

/* Vérifie qu'un rôle (+ permissions déléguées éventuelles, gw/admin_extra_perms
   — même logique OR que _admHasAction() côté client, jamais réduite ici sous
   peine de casser une délégation légitime déjà active) autorise `permission`.
   `permission` absente de ROLE_ACTIONS pour ce rôle ET absente des permissions
   déléguées → refusé. Lecture Firebase seulement si le rôle de base ne suffit
   pas déjà (chemin rapide sans I/O pour le cas le plus courant). */
async function hasServerPermission(session, permission) {
  if (!permission) return true;
  var base = ROLE_ACTIONS[session.role] || [];
  if (base.indexOf(permission) !== -1) return true;
  try {
    var extra = await dbGet('/gw/admin_extra_perms/' + session.email.toLowerCase());
    var extraActions = (extra && extra.actions) || [];
    return extraActions.indexOf(permission) !== -1;
  } catch (e) {
    return false; /* fail-closed : une lecture impossible ne doit jamais autoriser par défaut */
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const body = req.body || {};
    const session = verify(body.token);
    if (!session) { res.status(401).json({ error: 'Session admin invalide ou expiree, reconnectez-vous.' }); return; }

    const action = body.action;

    /* SYNC-141 : contrôle du rôle AVANT toute exécution — voir rapport pour
       la preuve de chaque mapping. `setBans` sert à la fois l'application
       (ban) et la levée (unban) d'une sanction (même fonction serveur pour
       les deux, cf. _admConfirmBan()/_admUnbanUser() côté client) : autorisé
       si l'appelant a l'une ou l'autre permission. Les actions absentes de
       ACTION_PERMISSION ne sont pas concernées par ce bloc (comportement
       inchangé, session admin valide suffisante — cf. rapport). */
    if (action === 'setBans') {
      const bansOk = (await hasServerPermission(session, 'ban')) || (await hasServerPermission(session, 'unban'));
      if (!bansOk) { res.status(403).json({ error: 'Action non autorisée pour votre rôle.' }); return; }
    } else if (action === 'notifyPermissionsUpdated') {
      /* SYNC-143 : démontré via _admIsSA() — seul point d'entrée client
         (_admOpenDelegate(), js/app.js) menant à _admSaveDelegate()/cette
         action. Vérification dédiée (comparaison directe à gw/sadmin),
         même mécanisme exact que certifyUser/clearAllNotifs ci-dessous —
         aucune permission nommée de _ADM_ROLE_PERMS n'est associée à ce
         flux, donc pas via ACTION_PERMISSION/ROLE_ACTIONS. */
      let sadminCheck;
      try { sadminCheck = await dbGet('/gw/sadmin'); } catch (e) {
        res.status(500).json({ error: 'Erreur serveur' });
        return;
      }
      if (!sadminCheck || !sadminCheck.email || sadminCheck.email.toLowerCase() !== session.email.toLowerCase()) {
        res.status(403).json({ error: 'Action non autorisée pour votre rôle.' });
        return;
      }
    } else {
      const requiredPermission = ACTION_PERMISSION[action];
      if (requiredPermission && !(await hasServerPermission(session, requiredPermission))) {
        res.status(403).json({ error: 'Action non autorisée pour votre rôle.' });
        return;
      }
    }

    if (action === 'setBans') {
      await dbSet('/gw/bans', Array.isArray(body.bans) ? body.bans : []);
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'setPlansConfig') {
      await dbSet('/gw/plans_config', body.config || {});
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'setSupportConfig') {
      await dbSet('/gw/support_config', body.config || {});
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'setSettingsLogo') {
      await dbSet('/gw/settings_logo', body.data || null);
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'setJobsEnabled') {
      await dbSet('/gw/settings_jobs_enabled', body.enabled ? 1 : 0);
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'approveBadge' || action === 'revokeBadge' || action === 'rejectBadge' || action === 'certifyUser') {
      const targetEmail = String(body.targetEmail || '').trim().toLowerCase();
      if (!targetEmail || targetEmail.indexOf('@') === -1) {
        res.status(400).json({ error: 'targetEmail invalide' });
        return;
      }
      const targetKey = emailKey(targetEmail);
      const now = new Date().toISOString();

      if (action === 'certifyUser') {
        let sadmin;
        try { sadmin = await dbGet('/gw/sadmin'); } catch (e) {
          res.status(500).json({ error: 'Erreur serveur' });
          return;
        }
        if (!sadmin || !sadmin.email || sadmin.email.toLowerCase() !== session.email.toLowerCase()) {
          res.status(403).json({ error: 'Action réservée au fondateur' });
          return;
        }
        await dbUpdate('/gw/profiles/' + targetKey, {
          badgeType: 'certified',
          badgeStatus: 'approved',
          badgeCertifiedBy: session.email,
          badgeCertifiedAt: now,
          badgeSource: null,
        });
        try {
          await appendNotification(targetKey, {
            id: 'srv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), type: 'badge_approved',
            msg: '🟢 Félicitations ! Votre compte a été certifié par Geniwork. Un badge vert apparaît maintenant sur votre profil.',
            at: Date.now(), unread: true, read: false, proofTier: 'real',
          });
        } catch (e) {}
        res.status(200).json({ ok: true });
        return;
      }

      if (action === 'approveBadge') {
        const badgeType = body.badgeType === 'premium' ? 'premium' : 'verified';
        await dbUpdate('/gw/profiles/' + targetKey, {
          badgeType: badgeType,
          badgeStatus: 'approved',
          identityVerified: true,
          badgeApprovedAt: now,
          badgeSource: null,
        });
        try {
          await appendNotification(targetKey, {
            id: 'srv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), type: 'badge_approved',
            msg: badgeType === 'premium'
              ? '👑 Félicitations ! Votre Badge Premium a été approuvé. Profitez de tous vos avantages !'
              : '✅ Félicitations ! Votre Badge Vérifié a été approuvé par notre équipe.',
            at: Date.now(), unread: true, read: false, proofTier: 'real',
          });
        } catch (e) {}
        res.status(200).json({ ok: true });
        return;
      }

      if (action === 'revokeBadge') {
        const motif = String(body.motif || '').slice(0, 500);
        const patch = {
          badgeType: null,
          badgeApprovedAt: null,
          badgeStatus: 'revoked',
          badgeRevokedAt: now,
          badgeRevokedMotif: motif,
          badgeRevokedBy: session.email,
          badgeSource: null,
        };
        /* Reinitialise aussi le plan si c'etait Premium/Business — reproduit
           exactement le comportement client existant (_admRevokeBadge). */
        let profile;
        try { profile = await dbGet('/gw/profiles/' + targetKey); } catch (e) { profile = null; }
        const badgeLabel = profile && profile.badgeType === 'premium' ? 'Premium 👑' : profile && profile.badgeType === 'certified' ? 'Certifié 🟢' : 'Vérifié ✅';
        if (profile && (profile.planType === 'premium' || profile.planType === 'business')) {
          patch.planType = 'free';
        }
        await dbUpdate('/gw/profiles/' + targetKey, patch);
        try {
          await appendNotification(targetKey, {
            id: 'srv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), type: 'badge_revoked',
            msg: '⚠️ Votre badge ' + badgeLabel + ' a été retiré par l\'équipe Geniwork.\nMotif : ' + motif.slice(0, 200),
            at: Date.now(), unread: true, read: false, proofTier: 'real',
          });
        } catch (e) {}
        res.status(200).json({ ok: true });
        return;
      }

      if (action === 'rejectBadge') {
        const reason = String(body.reason || '').slice(0, 150);
        await dbUpdate('/gw/profiles/' + targetKey, {
          badgeStatus: 'rejected',
          badgeType: null,
          badgeSource: null,
        });
        try {
          await appendNotification(targetKey, {
            id: 'srv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), type: 'badge_rejected',
            msg: '❌ Votre demande de badge a été refusée.' + (reason ? ' Motif : ' + reason : ' Vous pouvez soumettre à nouveau après correction.'),
            at: Date.now(), unread: true, read: false, proofTier: 'real',
          });
        } catch (e) {}
        res.status(200).json({ ok: true });
        return;
      }
    }

    if (action === 'listRecruiterVerifs') {
      /* Phase 8E : gw/recruiter_verifs_v2/{applicantUid} n'est lisible par
         le client que pour sa PROPRE demande (auth.uid===$applicantUid) —
         c'est precisement la frontiere de confidentialite voulue. Le
         panel admin doit donc voir TOUTES les demandes de TOUS les
         recruteurs pour sa file de moderation ; seul le compte de
         service peut le faire. Reapplati en tableau, meme forme que
         l'ancien gw/recruiter_verifs, pour que le rendu admin existant
         (_admBuildJobRequests, _jobGetVerifs) n'ait rien a changer. */
      let nested;
      try { nested = await dbGet('/gw/recruiter_verifs_v2'); } catch (e) {
        res.status(500).json({ error: 'Erreur serveur' });
        return;
      }
      const flat = [];
      if (nested && typeof nested === 'object') {
        Object.keys(nested).forEach((uid) => {
          const byId = nested[uid];
          if (byId && typeof byId === 'object') {
            Object.keys(byId).forEach((verifId) => { if (byId[verifId]) flat.push(byId[verifId]); });
          }
        });
      }
      res.status(200).json({ ok: true, verifs: flat });
      return;
    }

    if (action === 'approveRecruiterVerif' || action === 'rejectRecruiterVerif' || action === 'revokeRecruiterVerif') {
      const applicantEmail = String(body.targetEmail || '').trim().toLowerCase();
      const verifId = String(body.verifId || '').trim();
      if (!applicantEmail || applicantEmail.indexOf('@') === -1) {
        res.status(400).json({ error: 'targetEmail invalide' });
        return;
      }
      if (!verifId) {
        res.status(400).json({ error: 'verifId invalide' });
        return;
      }
      const applicantUid = emailKey(applicantEmail);
      const path = '/gw/recruiter_verifs_v2/' + applicantUid + '/' + verifId;
      const now = new Date().toISOString();

      let existing;
      try { existing = await dbGet(path); } catch (e) {
        res.status(500).json({ error: 'Erreur serveur' });
        return;
      }
      if (!existing) {
        res.status(404).json({ error: 'Demande de vérification introuvable' });
        return;
      }

      if (action === 'approveRecruiterVerif') {
        await dbUpdate(path, { status: 'approved', reviewedAt: now, reviewedBy: session.email });
        /* Phase 9C : notification ecrite ICI, cote serveur, plutot que par
           un pushNotif() client separe — l'action elle-meme vient d'etre
           verifiee (session admin valide), aucune preuve supplementaire
           necessaire. Remplace l'ancien appel client (js/app.js). */
        try {
          await appendNotification(applicantUid, {
            id: 'srv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            type: 'system', title: '✅ Entreprise vérifiée',
            message: 'Votre entreprise a été vérifiée par l\'équipe Geniwork. Vous pouvez maintenant publier des offres d\'emploi.',
            date: now, read: false, proofTier: 'real',
          });
        } catch (e) { /* notification manquee : ne bloque pas la decision admin */ }
        res.status(200).json({ ok: true });
        return;
      }

      if (action === 'rejectRecruiterVerif') {
        const reason = String(body.reason || '').slice(0, 500);
        await dbUpdate(path, { status: 'rejected', reviewedAt: now, reviewedBy: session.email, rejectReason: reason });
        try {
          await appendNotification(applicantUid, {
            id: 'srv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            type: 'system', title: '❌ Vérification refusée',
            message: 'La vérification de votre entreprise a été refusée' + (reason ? ' : ' + reason : '') + '. Vous pouvez soumettre une nouvelle demande.',
            date: now, read: false, proofTier: 'real',
          });
        } catch (e) {}
        res.status(200).json({ ok: true });
        return;
      }

      if (action === 'revokeRecruiterVerif') {
        await dbUpdate(path, {
          status: 'rejected', reviewedAt: now, reviewedBy: session.email,
          rejectReason: 'Vérification retirée par l’équipe Geniwork',
        });
        /* Cloture les offres actives de ce recruteur — structure par
           recruteur gw/jobs_v2 (Phase 8B/8D), jamais l'ancien tableau
           plat gw/jobs (legacy, distinct, non touche). */
        let myJobs;
        try { myJobs = await dbGet('/gw/jobs_v2/' + applicantUid); } catch (e) { myJobs = null; }
        if (myJobs && typeof myJobs === 'object') {
          const patch = {};
          Object.keys(myJobs).forEach((jobId) => {
            if (myJobs[jobId] && myJobs[jobId].status === 'active') {
              patch['gw/jobs_v2/' + applicantUid + '/' + jobId + '/status'] = 'closed';
            }
          });
          if (Object.keys(patch).length) { await dbUpdate('/', patch); }
        }
        try {
          await appendNotification(applicantUid, {
            id: 'srv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            type: 'system', title: '⚠️ Vérification retirée',
            message: 'La vérification de votre entreprise a été retirée par l\'équipe Geniwork. Vos offres ont été clôturées et vous devez soumettre une nouvelle vérification pour publier à nouveau.',
            date: now, read: false, proofTier: 'real',
          });
        } catch (e) {}
        res.status(200).json({ ok: true });
        return;
      }
    }

    /* ── Phase 9C : notifications provenant d'actions admin deja verifiees
       server-side (session admin valide) — le compte de service ecrit
       directement gw/notifs/{cible}, jamais un pushNotif() client. ── */
    if (action === 'notifyArtisteApproved') {
      const targetEmail = String(body.targetEmail || '').trim().toLowerCase();
      if (!targetEmail || targetEmail.indexOf('@') === -1) { res.status(400).json({ error: 'targetEmail invalide' }); return; }
      const targetKey = emailKey(targetEmail);
      const now = new Date().toISOString();
      try {
        await appendNotification(targetKey, {
          id: 'srv_' + Date.now() + '_a', type: 'artiste_approved',
          msg: '🎉 Félicitations, vous êtes maintenant artiste GeniWork !\n\nVotre demande de vérification a été approuvée par notre équipe. Vous avez désormais accès à l\'espace artiste et pouvez publier vos sons pour toute la communauté.\n\n✅ Ce que vous pouvez faire :\n• Publier vos sons et musiques\n• Apparaître dans le classement des artistes\n• Être découvert par la communauté GeniWork\n• Partager vos liens (Spotify, YouTube, SoundCloud…)\n\nBienvenue dans la famille des artistes GeniWork ! 🎵',
          date: now, at: Date.now(), unread: true, read: false, proofTier: 'real',
        });
        await appendNotification(targetKey, {
          id: 'srv_' + Date.now() + '_b', type: 'artiste_copyright_notice',
          msg: '⚖️ Rappel important — Droits d\'auteur\n\nEn tant qu\'artiste GeniWork, vous vous engagez à ne publier que vos propres créations originales.\n\n🚫 Il est strictement interdit de :\n• Publier la musique d\'autres artistes sans autorisation\n• Utiliser des samples sans licence valide\n• Reproduire des œuvres protégées par le droit d\'auteur\n\n✅ Vous devez uniquement publier :\n• Vos compositions 100 % originales\n• Des œuvres pour lesquelles vous détenez tous les droits\n• Des créations libres de droits autorisées à la distribution\n\nTout contenu signalé pour violation sera supprimé et pourra entraîner la révocation de votre accès artiste.\n\nMerci de respecter le travail de vos confrères. 🙏',
          date: now, at: Date.now() + 1, unread: true, read: false, proofTier: 'real',
        });
      } catch (e) {}
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'notifyArtisteRejected') {
      const targetEmail = String(body.targetEmail || '').trim().toLowerCase();
      if (!targetEmail || targetEmail.indexOf('@') === -1) { res.status(400).json({ error: 'targetEmail invalide' }); return; }
      const targetKey = emailKey(targetEmail);
      const reason = String(body.reason || '').slice(0, 500);
      try {
        await appendNotification(targetKey, {
          id: 'srv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), type: 'artiste_rejected',
          msg: '⚠️ Votre demande artiste a été refusée.' + (reason ? ' Raison : ' + reason : ' Contactez l\'administrateur pour plus d\'informations.'),
          date: new Date().toISOString(), at: Date.now(), read: false, proofTier: 'real',
        });
      } catch (e) {}
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'notifyPermissionsUpdated') {
      const targetEmail = String(body.targetEmail || '').trim().toLowerCase();
      if (!targetEmail || targetEmail.indexOf('@') === -1) { res.status(400).json({ error: 'targetEmail invalide' }); return; }
      const granted = !!body.granted;
      try {
        await appendNotification(emailKey(targetEmail), {
          id: 'srv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), type: 'system',
          title: 'Permissions mises à jour',
          message: granted ? 'Le Super Admin vous a accordé de nouvelles permissions.' : 'Le Super Admin a retiré vos permissions supplémentaires.',
          date: new Date().toISOString(), read: false, proofTier: 'identity',
        });
      } catch (e) {}
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'notifyTaskAssigned') {
      const targetEmail = String(body.targetEmail || '').trim().toLowerCase();
      const taskTitle = String(body.taskTitle || '').slice(0, 200);
      const taskId = String(body.taskId || '').slice(0, 64);
      if (!targetEmail || targetEmail.indexOf('@') === -1 || !taskTitle) { res.status(400).json({ error: 'Paramètres invalides' }); return; }
      try {
        await appendNotification(emailKey(targetEmail), {
          id: 'srv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), type: 'task_assigned',
          title: '📋 Nouvelle tâche', message: '📋 Nouvelle tâche assignée par ' + session.email + ' :\n\n• ' + taskTitle,
          taskId: taskId, date: new Date().toISOString(), read: false, proofTier: 'identity',
        });
      } catch (e) {}
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'notifyTaskDone') {
      const targetEmail = String(body.targetEmail || '').trim().toLowerCase();
      const taskTitle = String(body.taskTitle || '').slice(0, 200);
      const taskId = String(body.taskId || '').slice(0, 64);
      if (!targetEmail || targetEmail.indexOf('@') === -1 || !taskTitle) { res.status(400).json({ error: 'Paramètres invalides' }); return; }
      try {
        await appendNotification(emailKey(targetEmail), {
          id: 'srv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), type: 'task_done',
          title: '✅ Tâche accomplie', message: '✅ ' + session.email + ' a accompli la tâche :\n"' + taskTitle + '"',
          taskId: taskId, date: new Date().toISOString(), read: false, proofTier: 'identity',
        });
      } catch (e) {}
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'notifySongDeleted') {
      const targetEmail = String(body.targetEmail || '').trim().toLowerCase();
      const title = String(body.title || 'Sans titre').slice(0, 200);
      const reason = String(body.reason || '').slice(0, 500);
      if (!targetEmail || targetEmail.indexOf('@') === -1) { res.status(400).json({ error: 'targetEmail invalide' }); return; }
      try {
        await appendNotification(emailKey(targetEmail), {
          id: 'srv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), type: 'song_deleted',
          msg: 'Votre son "' + title + '" a été supprimé par l\'administrateur. Motif : ' + reason,
          at: Date.now(), read: false, proofTier: 'identity',
        });
      } catch (e) {}
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'notifyBanApplied') {
      const targetEmail = String(body.targetEmail || '').trim().toLowerCase();
      const banMsg = String(body.banMsg || 'Votre compte a été suspendu.').slice(0, 500);
      const extraMsg = String(body.extraMsg || '').slice(0, 500);
      if (!targetEmail || targetEmail.indexOf('@') === -1) { res.status(400).json({ error: 'targetEmail invalide' }); return; }
      try {
        await appendNotification(emailKey(targetEmail), {
          id: 'srv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), type: 'ban',
          msg: banMsg + (extraMsg ? '\n\n' + extraMsg : ''), at: Date.now(), unread: true, read: false, proofTier: 'identity',
        });
      } catch (e) {}
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'notifyBanLifted') {
      const targetEmail = String(body.targetEmail || '').trim().toLowerCase();
      if (!targetEmail || targetEmail.indexOf('@') === -1) { res.status(400).json({ error: 'targetEmail invalide' }); return; }
      try {
        await appendNotification(emailKey(targetEmail), {
          id: 'srv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), type: 'ban_lifted',
          msg: '✅ Votre suspension a été levée. Vous pouvez vous reconnecter.', at: Date.now(), unread: true, read: false, proofTier: 'identity',
        });
      } catch (e) {}
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'notifyOfficialPost') {
      /* Phase SYNC-55 : rate-limit fail-closed — diffusion de portée
         globale (tous les utilisateurs), clé sur l'identité admin issue
         du token deja verifie, jamais un champ client. */
      const rl = await checkRateLimit('admin:notifyOfficialPost:' + emailKey(session.email), 10, 60 * 60 * 1000);
      if (rl.ok === false) { res.status(429).json({ error: 'Trop de diffusions officielles recentes. Reessayez dans ' + rl.retryAfterSec + 's.' }); return; }
      if (rl.ok === null) { res.status(503).json({ error: 'Service de protection anti-abus temporairement indisponible.' }); return; }
      const message = String(body.message || '').slice(0, 500);
      let users;
      try { users = await dbGet('/gw/users_public'); } catch (e) { users = null; }
      const emails = Array.isArray(users) ? users.map((u) => u && u.email).filter(Boolean) : [];
      for (const em of emails) {
        try {
          await appendNotification(emailKey(em), {
            id: 'srv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), type: 'official',
            msg: '📣 Geniwork : ' + (message || 'Nouvelle publication officielle'),
            at: Date.now(), unread: true, read: false, proofTier: 'identity',
          });
        } catch (e) { /* continue les autres */ }
      }
      res.status(200).json({ ok: true, count: emails.length });
      return;
    }

    if (action === 'notifyBroadcast') {
      /* Phase 9C (complément) : _admSendNotif() — fonctionnalité admin
         dédiée d'envoi de notification (cible 'all' ou un email précis) —
         écrivait auparavant en boucle getNotifs/saveNotifs cross-user
         directement depuis le client, désormais fermé côté règles. Même
         mécanisme que notifyOfficialPost (compte de service, boucle
         gw/users_public pour 'all'). */
      /* Phase SYNC-55 : rate-limit fail-closed — meme raisonnement que
         notifyOfficialPost (portee potentiellement globale via target='all'). */
      const rlBroadcast = await checkRateLimit('admin:notifyBroadcast:' + emailKey(session.email), 10, 60 * 60 * 1000);
      if (rlBroadcast.ok === false) { res.status(429).json({ error: 'Trop de diffusions recentes. Reessayez dans ' + rlBroadcast.retryAfterSec + 's.' }); return; }
      if (rlBroadcast.ok === null) { res.status(503).json({ error: 'Service de protection anti-abus temporairement indisponible.' }); return; }
      const title = String(body.title || '').slice(0, 200).trim();
      const bodyText = String(body.body || '').slice(0, 500).trim();
      if (!title) { res.status(400).json({ error: 'Titre requis' }); return; }
      const msg = title + (bodyText ? ' — ' + bodyText : '');
      const target = String(body.target || 'all').trim();

      if (target === 'all') {
        let users;
        try { users = await dbGet('/gw/users_public'); } catch (e) { users = null; }
        const emails = Array.isArray(users) ? users.map((u) => u && u.email).filter(Boolean) : [];
        let count = 0;
        for (const em of emails) {
          try {
            await appendNotification(emailKey(em), {
              id: 'srv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), type: 'official',
              msg: msg, at: Date.now(), unread: true, read: false, proofTier: 'identity',
            });
            count++;
          } catch (e) { /* continue les autres */ }
        }
        res.status(200).json({ ok: true, count });
        return;
      }

      const targetEmail = target.toLowerCase();
      if (!targetEmail || targetEmail.indexOf('@') === -1) { res.status(400).json({ error: 'target invalide' }); return; }
      try {
        await appendNotification(emailKey(targetEmail), {
          id: 'srv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), type: 'official',
          msg: msg, at: Date.now(), unread: true, read: false, proofTier: 'identity',
        });
      } catch (e) {}
      res.status(200).json({ ok: true, count: 1 });
      return;
    }

    if (action === 'notifyBanAppealRejected') {
      const targetEmail = String(body.targetEmail || '').trim().toLowerCase();
      if (!targetEmail || targetEmail.indexOf('@') === -1) { res.status(400).json({ error: 'targetEmail invalide' }); return; }
      try {
        await appendNotification(emailKey(targetEmail), {
          id: 'srv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), type: 'appeal_rejected',
          msg: '❌ Votre recours a été examiné et rejeté. La sanction reste en vigueur.',
          at: Date.now(), unread: true, read: false, proofTier: 'identity',
        });
      } catch (e) {}
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'notifyRestrictionAppealRejected') {
      const targetEmail = String(body.targetEmail || '').trim().toLowerCase();
      if (!targetEmail || targetEmail.indexOf('@') === -1) { res.status(400).json({ error: 'targetEmail invalide' }); return; }
      try {
        await appendNotification(emailKey(targetEmail), {
          id: 'srv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), type: 'restriction_rejected',
          msg: '❌ Votre recours de restriction a été examiné et rejeté. La restriction reste en vigueur. Veuillez respecter les règles de la communauté.',
          at: Date.now(), unread: true, read: false, proofTier: 'identity',
        });
      } catch (e) {}
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'notifyUserWarned') {
      const targetEmail = String(body.targetEmail || '').trim().toLowerCase();
      if (!targetEmail || targetEmail.indexOf('@') === -1) { res.status(400).json({ error: 'targetEmail invalide' }); return; }
      try {
        await appendNotification(emailKey(targetEmail), {
          id: 'srv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), type: 'warning',
          msg: '⚠️ Un administrateur a émis un avertissement sur votre compte. Veuillez respecter les règles de la communauté.',
          at: Date.now(), unread: true, read: false, proofTier: 'identity',
        });
      } catch (e) {}
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'notifyRestrictionApplied') {
      const targetEmail = String(body.targetEmail || '').trim().toLowerCase();
      const typeLabel = String(body.typeLabel || 'violation des règles communautaires').slice(0, 200);
      const restrictionId = String(body.restrictionId || '').slice(0, 64);
      if (!targetEmail || targetEmail.indexOf('@') === -1) { res.status(400).json({ error: 'targetEmail invalide' }); return; }
      try {
        await appendNotification(emailKey(targetEmail), {
          id: 'srv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), type: 'restriction',
          msg: '⚠️ Votre compte a été restreint pour ' + typeLabel + '.\n\nVous ne pouvez plus publier, commenter ou envoyer de messages. Vous pouvez faire un recours depuis votre profil.',
          at: Date.now(), unread: true, read: false, restrictionId: restrictionId, proofTier: 'identity',
        });
      } catch (e) {}
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'notifyRestrictionLifted') {
      const targetEmail = String(body.targetEmail || '').trim().toLowerCase();
      if (!targetEmail || targetEmail.indexOf('@') === -1) { res.status(400).json({ error: 'targetEmail invalide' }); return; }
      try {
        await appendNotification(emailKey(targetEmail), {
          id: 'srv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), type: 'restriction_lifted',
          msg: '✅ Votre restriction a été levée. Vous pouvez à nouveau publier, commenter et envoyer des messages.',
          at: Date.now(), unread: true, read: false, proofTier: 'identity',
        });
      } catch (e) {}
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'notifySupportReply') {
      const targetEmail = String(body.targetEmail || '').trim().toLowerCase();
      const message = String(body.message || '').slice(0, 500);
      if (!targetEmail || targetEmail.indexOf('@') === -1) { res.status(400).json({ error: 'targetEmail invalide' }); return; }
      try {
        await appendNotification(emailKey(targetEmail), {
          id: 'srv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), type: 'system',
          msg: '💬 L\'équipe Geniwork a répondu à votre signalement : "' + message + '"',
          at: Date.now(), unread: true, read: false, proofTier: 'identity',
        });
      } catch (e) {}
      res.status(200).json({ ok: true });
      return;
    }

    /* ── Phase 9C : gestion des boites de notification par un admin —
       remplace les .remove() directs client (gw/notifs desormais ferme
       en ecriture cross-user cote regles). ── */
    if (action === 'clearUserNotifs') {
      const targetEmail = String(body.targetEmail || '').trim().toLowerCase();
      if (!targetEmail || targetEmail.indexOf('@') === -1) { res.status(400).json({ error: 'targetEmail invalide' }); return; }
      await dbRemove('/gw/notifs/' + emailKey(targetEmail));
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'clearAllNotifs') {
      /* Phase SYNC-49 : contrôle Super Admin serveur — action destructrice
         de portée globale (vide gw/notifs de TOUS les utilisateurs), même
         modèle de vérification que certifyUser. Le client (_admIsSA())
         bloquait déjà ce bouton pour un admin standard, mais rien ne
         vérifiait ce rôle côté serveur avant cette phase. */
      let sadmin;
      try { sadmin = await dbGet('/gw/sadmin'); } catch (e) {
        res.status(500).json({ error: 'Erreur serveur' });
        return;
      }
      if (!sadmin || !sadmin.email || sadmin.email.toLowerCase() !== session.email.toLowerCase()) {
        res.status(403).json({ error: 'Action réservée au fondateur' });
        return;
      }
      let users;
      try { users = await dbGet('/gw/users_public'); } catch (e) { users = null; }
      const emails = Array.isArray(users) ? users.map((u) => u && u.email).filter(Boolean) : [];
      for (const em of emails) {
        try { await dbRemove('/gw/notifs/' + emailKey(em)); } catch (e) { /* continue les autres */ }
      }
      res.status(200).json({ ok: true, count: emails.length });
      return;
    }

    res.status(400).json({ error: 'Action inconnue: ' + action });
  } catch (err) {
    console.error('[Geniwork Admin] erreur moderate:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};
