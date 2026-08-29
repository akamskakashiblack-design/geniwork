/* ═══════════════════════════════════════════════════════════════
   GENIWORK — Projection publique d'une entrée gw/users (Phase 5D)
   Construit l'objet destiné à gw/users_public : uniquement les champs
   réellement consommés côté navigateur (Phase 5C). Ne renvoie JAMAIS
   password, hash, salt, token, refreshToken ou tout autre secret —
   même si le champ source en contient un sous un nom inattendu, il
   n'est simplement jamais recopié (allow-list stricte, pas une
   exclusion de champs connus).
   Ne mute jamais l'objet source.
═══════════════════════════════════════════════════════════════ */

function toPublicUser(user) {
  if (!user || typeof user !== 'object') return null;

  const pub = {
    email: user.email,
    nom: user.nom,
    verified: user.verified,
  };
  /* N'invente pas ces champs s'ils sont absents de la source. */
  if (user.loginMethod) pub.loginMethod = user.loginMethod;
  if (user.googleId) pub.googleId = user.googleId;

  return pub;
}

module.exports = { toPublicUser };
