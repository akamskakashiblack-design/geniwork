/* ═══════════════════════════════════════════════════════════════
   GENIWORK — POST /api/social/like (SYNC-130 + correction identité)

   L'écriture métier du Like (gw/likes/{postId}/{likerUid}) était
   documentée comme "entièrement côté client, protégée par
   auth.uid===$userFbKey" — mais cette égalité, bien que garantie pour
   les comptes email/mot de passe (custom token uid=emailKey), ne l'est
   PAS pour un compte Google dont la session Firebase native
   (signInWithPopup, uid propre à Google) n'a pas encore été remplacée
   par le custom token serveur (uid=emailKey) au moment du clic — la
   fenêtre de course existe côté client (_gwSignInRealIdentityGoogle
   est asynchrone, best-effort, jamais attendue avant d'activer les
   boutons Like). Dans ce cas l'écriture directe échoue en
   PERMISSION_DENIED, silencieusement (catch vide côté client) : le
   like reste local à l'appareil, jamais visible des autres.

   Cet endpoint écrit donc désormais LUI-MÊME gw/likes/{postId}/
   {likerUid} via le compte de service (qui contourne les Rules,
   comme partout ailleurs dans ce dépôt — cf. api/admin/_lib/fbrest.js),
   en plus de la notification déjà en place. L'écriture directe côté
   client (_fbLikeWrite, js/app.js) reste également en place, best-
   effort — les deux écritures visent la même valeur, idempotentes,
   aucun conflit possible.

   Le client ne transmet donc que "postId" et "liked" — jamais un
   email/uid de propriétaire, jamais un "fromUser". Le serveur résout
   lui-même :
     - l'identité du liker, exclusivement depuis verifyRefreshToken() ;
     - le post réel et son auteur réel, en parcourant gw/posts server-
       side (compte de service) — MÊME algorithme de recherche que
       celui déjà en production dans api/post.js (fonction findPost(),
       non modifiée, non importée pour ne toucher à aucun fichier
       existant — dupliquée et adaptée ici pour renvoyer en plus la clé
       de l'auteur, information qu'api/post.js n'a jamais eu besoin de
       renvoyer puisqu'il ne sert qu'un aperçu Open Graph) ;
     - le nom d'affichage du liker, depuis gw/profiles/{likerUid}.

   Propriétaire réel = la clé d'auteur (authorFbKey) sous laquelle le
   post a été trouvé dans gw/posts/{authorFbKey}/... — jamais un champ
   "ownerEmail" lu à l'intérieur des données du post lui-même (qui,
   même lu server-side, resterait une donnée applicative plutôt qu'une
   position structurelle). Ce choix suit exactement le même principe
   déjà retenu pour Jobs (recruiterUid, résolu par la structure
   gw/jobs_v2/{recruiterUid}/...) et Marketplace (sellerUid, résolu par
   gw/mk_listings_v2/{sellerUid}/...) — jamais un champ interne à
   l'objet trouvé.

   Recherche gw/posts entière par like : identique en principe à
   api/post.js (endpoint public déjà en production, interrogé à chaque
   aperçu de lien partagé — fréquence au moins comparable) — tradeoff
   de performance déjà accepté ailleurs dans ce projet, pas une
   hypothèse nouvelle. Documenté en limite du rapport SYNC-130, pas
   traité ici (hors périmètre : ne pas modifier la structure gw/posts).

   Idempotence (section 7 du prompt SYNC-130) : clé logique
   "like_{likerUid}_{postId}", stockée dans le champ "likeKey" de
   chaque notification écrite par cet endpoint. Le dedupPredicate déjà
   supporté par appendNotification() (fbrest.js, non modifiée) retire
   toute notification existante portant la MÊME likeKey avant d'insérer
   la nouvelle — même mécanisme, même raisonnement que SYNC-128 (Follow).

   FCM : cet endpoint n'envoie JAMAIS de push — _gwSendPushNotif() reste
   l'unique déclencheur FCM, côté client, conditionné à la réponse
   ok:true de cet endpoint.

   Body : { authRefreshToken, postId, liked }
   Réponse : { ok:true, targetEmail } ou { ok:false, error }
═══════════════════════════════════════════════════════════════ */

const { dbGet, dbSet, dbRemove, appendNotification, emailKey, checkRateLimit } = require('../admin/_lib/fbrest');
const { verify: verifyRefreshToken } = require('../auth/_lib/refreshToken');

function isValidPostId(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 64 && /^[A-Za-z0-9_-]+$/.test(v);
}

/* Adaptation de findPost() (api/post.js, non modifiée, non importée) :
   même algorithme de recherche dans gw/posts/{authorFbKey}[...], mais
   renvoie en plus authorFbKey — l'autorité réelle du propriétaire,
   jamais un champ interne au post. */
function findPostWithOwner(postsObj, postId) {
  if (!postsObj || typeof postsObj !== 'object') return null;
  const pid = String(postId);
  for (const authorFbKey in postsObj) {
    const arr = postsObj[authorFbKey];
    if (!arr) continue;
    const list = Array.isArray(arr) ? arr : Object.values(arr);
    for (let i = 0; i < list.length; i++) {
      if (list[i] && String(list[i].id) === pid) return { post: list[i], ownerUid: authorFbKey };
    }
  }
  return null;
}

function uidToEmail(uid) {
  return uid.replace(/__d__/g, '.').replace(/__a__/g, '@');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Method not allowed' }); return; }

  try {
    const body = req.body || {};

    /* ── Identité du liker : dérivée UNIQUEMENT du jeton signé — jamais
       fromUser/ownerEmail/targetEmail que le client pourrait transmettre
       (le body n'en accepte d'ailleurs aucun). ── */
    const ticketData = verifyRefreshToken(body.authRefreshToken);
    if (!ticketData || !ticketData.email) {
      res.status(401).json({ ok: false, error: 'Session expirée, reconnectez-vous.' });
      return;
    }
    const likerEmail = ticketData.email;
    const likerUid = emailKey(likerEmail);

    const rl = await checkRateLimit('social:like:' + likerUid, 60, 60 * 60 * 1000);
    if (rl.ok === false) { res.status(429).json({ ok: false, error: 'Trop de tentatives récentes. Réessayez dans ' + rl.retryAfterSec + 's.' }); return; }
    if (rl.ok === null) { res.status(503).json({ ok: false, error: 'Service de protection anti-abus temporairement indisponible.' }); return; }

    if (!isValidPostId(body.postId)) {
      res.status(400).json({ ok: false, error: 'postId invalide' });
      return;
    }
    const postId = body.postId;

    if (typeof body.liked !== 'boolean') {
      res.status(400).json({ ok: false, error: 'liked invalide' });
      return;
    }
    const liked = body.liked;

    /* ── Écriture authoritative du Like — via le compte de service,
       contourne toute incohérence d'identité côté client (cf. en-tête
       de fichier). Reflète le résultat réel au client : c'est
       désormais la source de vérité, plus une simple notification. ── */
    try {
      if (liked) {
        await dbSet('/gw/likes/' + postId + '/' + likerUid, likerEmail);
      } else {
        await dbRemove('/gw/likes/' + postId + '/' + likerUid);
      }
    } catch (e) {
      res.status(500).json({ ok: false, error: 'Erreur serveur' });
      return;
    }

    /* ── Notification — best-effort, seulement pour un like ajouté, et
       seulement si le propriétaire réel peut être résolu (jamais
       bloquant pour la réponse : le Like lui-même a déjà été écrit
       ci-dessus, quoi qu'il arrive à partir d'ici). ── */
    let targetEmail = null;
    if (liked) {
      try {
        const postsObj = await dbGet('/gw/posts');
        const found = findPostWithOwner(postsObj, postId);
        if (found && found.ownerUid !== likerUid) {
          const ownerUid = found.ownerUid;
          targetEmail = uidToEmail(ownerUid);

          let likerProfile;
          try { likerProfile = await dbGet('/gw/profiles/' + likerUid); } catch (e) { likerProfile = null; }
          const likerNom = (likerProfile && likerProfile.nom) || likerEmail;

          const post = found.post;
          const likeType = post.video ? 'votre vidéo' : ((post.images && post.images.length) ? 'votre photo' : 'votre publication');
          const rawPreview = (post.video && post.video.title) || post.text || '';
          const postPreview = rawPreview.slice(0, 60) + (rawPreview.length > 60 ? '…' : '');

          const likeKey = 'like_' + likerUid + '_' + postId;
          await appendNotification(ownerUid, {
            id: 'srv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            type: 'like', likeKey: likeKey,
            title: '❤️ Nouveau like',
            body: likerNom + ' a aimé ' + likeType,
            fromUser: { nom: likerNom, email: likerEmail, role: 'Membre Geniwork' },
            postId: postId, postPreview: postPreview,
            msg: 'a aimé ' + likeType,
            at: Date.now(), unread: true, read: false,
          }, function(existing) {
            return !!(existing && existing.type === 'like' && existing.likeKey === likeKey);
          });
        }
      } catch (e) {
        console.error('[Geniwork Social] notification like échouée (non bloquant):', e.message);
      }
    }

    res.status(200).json({ ok: true, targetEmail: targetEmail });
  } catch (err) {
    console.error('[Geniwork Social] erreur like:', err.message);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
};
