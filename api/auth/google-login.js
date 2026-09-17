/* ═══════════════════════════════════════════════════════════════
   GENIWORK — POST /api/auth/google-login
   Phase 5B : sécurise le rattachement/la création de compte gw/users lors
   d'une connexion Google. Remplace la recherche/liaison/création faite
   jusqu'ici côté client dans _googleLogin()/_doGoogleLogin() (js/app.js)
   via getUsers()/saveUsers() — réécriture complète de gw/users depuis le
   navigateur, autorité basée sur l'email/googleId envoyés par le client,
   jamais vérifiés côté serveur.

   IDENTITÉ : dérivée EXCLUSIVEMENT du jeton Google vérifié ici côté
   serveur (mêmes fonctions de vérification que /api/auth/google-token.js,
   dupliquées dans ce fichier — google-token.js n'est pas modifié, son
   comportement déjà en production reste inchangé, même principe de
   duplication déjà utilisé partout dans ce dépôt pour toArray()/emailKey()
   plutôt que d'introduire un module partagé dans un fichier qui marche
   déjà). Ni l'email ni le googleId envoyés par le client ne sont utilisés
   comme preuve d'identité — seuls l'email et le "sub" (identifiant Google
   stable) renvoyés par Google lui-même via tokeninfo/userinfo font
   autorité. Le "nom" fourni par le client n'a aucune incidence de
   sécurité (valeur d'affichage uniquement, comme à l'inscription
   classique) et n'est utilisé que pour un tout nouveau compte.

   Body: { credential } OU { accessToken }, + { nom } optionnel.
   Réponse : { ok:true, token, refreshToken, uid, email, nom, isNewAccount }
   ou { ok:false, error }.

   Émet aussi un Firebase Custom Token, exactement comme google-token.js
   (même mécanisme, dupliqué car ce fichier reste indépendant) — le client
   n'a donc plus besoin d'appeler séparément
   _gwSignInRealIdentityGoogle()/google-token.js après ce endpoint pour la
   connexion Google (cette fonction reste dans js/app.js, inchangée, mais
   n'est plus appelée depuis _googleLogin()).

   Écriture gw/users :
   - Compte déjà lié (googleId déjà présent) : AUCUNE écriture.
   - Compte trouvé par email mais sans googleId (Cas B) : écriture CIBLÉE
     gw/users/{idx}/googleId uniquement — jamais password/email/verified.
   - Aucun compte trouvé (Cas C) : création, même limitation structurelle
     déjà documentée dans register-verify.js (push + dbSet du tableau
     complet — gw/users est un tableau, pas une map par uid ; migration
     hors périmètre de cette étape).
═══════════════════════════════════════════════════════════════ */

const crypto = require('crypto');
const { dbGet, dbSet, emailKey } = require('../admin/_lib/fbrest');
const { sign: signRefreshToken } = require('./_lib/refreshToken');
const { toPublicUser } = require('./_lib/publicUser');

/* Phase 6 : voir google-token.js pour la justification complète —
   vérifie que le jeton Google a bien été émis POUR Geniwork (claim
   "aud"), jamais validé jusqu'ici dans ce fichier (même lacune que
   google-token.js, dupliquée en Phase 5B sans ce contrôle). */
const GOOGLE_CLIENT_ID = '180664489098-gljui5ih2883jv3f6744c6t65ce650kh.apps.googleusercontent.com';

function toArray(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return Object.keys(v).sort((a, b) => Number(a) - Number(b)).map((k) => v[k]);
  return [];
}

function getServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT non configuree dans Vercel');
  const sa = JSON.parse(raw);
  if (!sa.client_email || !sa.private_key) throw new Error('Compte de service incomplet');
  return sa;
}

/* Identique à google-token.js (dupliqué, ce fichier n'est pas touché). */
function signCustomToken(uid, sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: sa.client_email,
    sub: sa.client_email,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat: now,
    exp: now + 3600,
    uid: uid,
  };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = b64(header) + '.' + b64(payload);
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(unsigned);
  const sig = sign.sign(sa.private_key, 'base64url');
  return unsigned + '.' + sig;
}

/* Vérifie un ID token Google (JWT signé par Google) via l'endpoint
   tokeninfo officiel — Google valide signature + expiration pour nous.
   Extrait aussi "sub" (identifiant Google stable) — jamais celui envoyé
   par le client. */
async function verifyIdToken(idToken) {
  const resp = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
  if (!resp.ok) return null;
  const data = await resp.json();
  if (!data || !data.email) return null;
  if (data.aud !== GOOGLE_CLIENT_ID) return null; /* jeton emis pour une autre application */
  return {
    email: String(data.email).toLowerCase(),
    verified: data.email_verified === 'true' || data.email_verified === true,
    sub: data.sub ? String(data.sub) : null,
  };
}

/* Vérifie un access token Google en récupérant le profil associé.
   Vérifie aussi séparément "aud" via tokeninfo (userinfo ne l'expose
   pas) pour confirmer que ce jeton a bien été émis pour Geniwork. */
async function verifyAccessToken(accessToken) {
  const infoResp = await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(accessToken));
  if (!infoResp.ok) return null;
  const info = await infoResp.json();
  if (!info || info.aud !== GOOGLE_CLIENT_ID) return null;

  const resp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: 'Bearer ' + accessToken },
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  if (!data || !data.email) return null;
  return {
    email: String(data.email).toLowerCase(),
    verified: data.email_verified === true || data.email_verified === 'true',
    sub: data.sub ? String(data.sub) : null,
  };
}

/* Même règle que _gwIsReservedName() côté client. */
function isReservedName(nom) {
  const n = String(nom || '').trim().toLowerCase().replace(/\s+/g, '');
  return n === 'geniwork' || n === 'geniworkofficiel' || n === 'geniworkofficial';
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const body = req.body || {};

    let verified = null;
    if (body.credential) {
      verified = await verifyIdToken(String(body.credential));
    } else if (body.accessToken) {
      verified = await verifyAccessToken(String(body.accessToken));
    }

    if (!verified || !verified.email) {
      res.status(401).json({ ok: false, error: 'Jeton Google invalide ou expiré' });
      return;
    }

    const email = verified.email;
    const googleId = verified.sub || null; // jamais le googleId envoyé par le client

    const users = toArray(await dbGet('/gw/users'));
    const idx = users.findIndex((u) => u && u.email && u.email.toLowerCase() === email);

    let nom;
    let isNewAccount = false;

    if (idx !== -1) {
      /* Cas A (déjà lié) ou Cas B (trouvé par email, googleId absent). */
      const existing = users[idx];
      nom = existing.nom;
      if (!existing.googleId && googleId) {
        /* Écriture ciblée uniquement — jamais password/email/verified. */
        await dbSet('/gw/users/' + idx + '/googleId', googleId);
        /* Phase 5D : jumelle sur la projection publique — best-effort. */
        try {
          await dbSet('/gw/users_public/' + idx + '/googleId', googleId);
        } catch (pubErr) {
          console.error('[Geniwork Auth] échec écriture users_public (non bloquant):', pubErr.message);
        }
      }
    } else {
      /* Cas C : aucun compte trouvé pour cet email vérifié → création. */
      isNewAccount = true;
      const rawNom = String(body.nom || email.split('@')[0]).trim().slice(0, 100);
      let candidateNom = isReservedName(rawNom) ? (rawNom + ' (Google)') : rawNom;
      let suffix = 2;
      while (users.some((u) => u && u.nom && String(u.nom).trim().toLowerCase() === candidateNom.trim().toLowerCase())) {
        candidateNom = rawNom + ' (' + suffix + ')';
        suffix++;
      }
      nom = candidateNom;

      const newUser = { nom: nom, email: email, password: null, verified: true, googleId: googleId, loginMethod: 'google' };
      users.push(newUser);
      await dbSet('/gw/users', users);

      /* Phase 5D : projection publique jumelle — best-effort. */
      try {
        await dbSet('/gw/users_public/' + (users.length - 1), toPublicUser(newUser));
      } catch (pubErr) {
        console.error('[Geniwork Auth] échec écriture users_public (non bloquant):', pubErr.message);
      }
    }

    const sa = getServiceAccount();
    const uid = emailKey(email);
    const token = signCustomToken(uid, sa);
    const refreshToken = signRefreshToken(email);

    res.status(200).json({ ok: true, token: token, refreshToken: refreshToken, uid: uid, email: email, nom: nom, isNewAccount: isNewAccount });
  } catch (err) {
    console.error('[Geniwork Auth] erreur google-login:', err.message);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
};
