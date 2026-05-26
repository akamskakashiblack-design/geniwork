/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║         GENIWORK — Script de migration base de données          ║
 * ║         Exécuter dans la console du navigateur (F12)            ║
 * ║         quand l'application est ouverte et connectée Firebase   ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Ce script :
 *  1. Vérifie que Firebase est prêt
 *  2. Migre tous les DMs du localStorage → gw/dm_msgs/{key}/{msgId}
 *  3. Migre tous les messages de groupe → gw/group_msgs/{key}
 *  4. Migre profils, following, follow_counts, posts
 *  5. Affiche un rapport de migration
 *
 * Usage : coller dans F12 > Console quand l'app est ouverte
 */

(function gwMigrate() {
  'use strict';

  /* ── Vérifications préliminaires ── */
  if (typeof _gwFbDB === 'undefined' || !_gwFbDB) {
    console.error('[MIGRATE] ❌ Firebase non initialisé. Ouvrez l\'app et reconnectez-vous d\'abord.');
    return;
  }
  if (!_gwFbReady) {
    console.error('[MIGRATE] ❌ Firebase pas encore prêt.');
    return;
  }

  var db      = _gwFbDB;
  var stats   = { dm: 0, grp: 0, profiles: 0, posts: 0, following: 0, fc: 0, errors: 0 };
  var writes  = [];   /* promesses d'écriture */

  /* ── Utilitaires ── */
  function fbKey(email) {
    return (email || '').toLowerCase()
      .replace(/\./g, '__d__')
      .replace(/@/g, '__a__')
      .replace(/[#$\[\]\/]/g, '_');
  }

  function safe(fn) {
    try { return fn(); } catch(e) { return null; }
  }

  function push(promise) {
    writes.push(promise.catch(function(e) {
      stats.errors++;
      console.warn('[MIGRATE] Erreur écriture :', e.message || e);
    }));
  }

  console.group('[MIGRATE] 🚀 Démarrage de la migration GeniWork → Firebase');

  /* ══════════════════════════════════════════════════════════════════
     1. MESSAGES DIRECTS (DM)
     Clé localStorage : gw_dm_{emailA}__{emailB}
     Destination Firebase : gw/dm_msgs/{fbKey}/{msgId}
  ══════════════════════════════════════════════════════════════════ */
  console.group('📨 Migration DMs...');
  for (var i = 0; i < localStorage.length; i++) {
    var lsKey = localStorage.key(i);
    if (!lsKey || !lsKey.startsWith('gw_dm_')) continue;

    var data = safe(function() { return JSON.parse(localStorage.getItem(lsKey)); });
    if (!data || !Array.isArray(data.messages) || !data.messages.length) continue;

    /* Convertir la clé localStorage → clé Firebase */
    var fbDmKey = lsKey.replace(/\./g, '__d__').replace(/@/g, '__a__').replace(/[#$\[\]\/]/g, '_');

    /* Écrire chaque message de façon atomique */
    var convRef = db.ref('gw/dm_msgs/' + fbDmKey);
    var metaRef = db.ref('gw/dm_meta/' + fbDmKey);

    data.messages.forEach(function(msg) {
      if (!msg || !msg.id || !msg.from || !msg.to) return;
      /* Ne pas migrer les messages stripped (photo trop grande) */
      if (msg._photoStripped) return;
      push(convRef.child(String(msg.id)).set(msg));
      stats.dm++;
    });

    /* Métadonnées */
    push(metaRef.set({
      lastMsg: data.lastMsg || '',
      lastAt:  data.lastAt  || Date.now()
    }));

    console.log('  ✓ DM migré :', lsKey, '→', data.messages.length, 'messages');
  }
  console.groupEnd();

  /* ══════════════════════════════════════════════════════════════════
     2. MESSAGES DE GROUPE
     Clé localStorage : gw_grp_{projId}___{ownerEmail}
     Destination Firebase : gw/group_msgs/{fbKey}
  ══════════════════════════════════════════════════════════════════ */
  console.group('👥 Migration groupes...');
  for (var j = 0; j < localStorage.length; j++) {
    var gLsKey = localStorage.key(j);
    if (!gLsKey || !gLsKey.startsWith('gw_grp_')) continue;

    var gData = safe(function() { return JSON.parse(localStorage.getItem(gLsKey)); });
    if (!gData || !Array.isArray(gData.messages) || !gData.messages.length) continue;

    var gFbKey = gLsKey.replace(/\./g, '__d__').replace(/@/g, '__a__').replace(/[#$\[\]\/]/g, '_');

    push(db.ref('gw/group_msgs/' + gFbKey).set(gData));
    stats.grp += gData.messages.length;
    console.log('  ✓ Groupe migré :', gLsKey, '→', gData.messages.length, 'messages');
  }
  console.groupEnd();

  /* ══════════════════════════════════════════════════════════════════
     3. PROFILS UTILISATEURS
     Clé localStorage : gw_profile_{email}
     Destination Firebase : gw/profiles/{fbKey}
  ══════════════════════════════════════════════════════════════════ */
  console.group('👤 Migration profils...');
  for (var k = 0; k < localStorage.length; k++) {
    var pKey = localStorage.key(k);
    if (!pKey || !pKey.startsWith('gw_profile_')) continue;

    var email = pKey.replace('gw_profile_', '');
    if (!email || !email.includes('@')) continue;

    var profile = safe(function() { return JSON.parse(localStorage.getItem(pKey)); });
    if (!profile) continue;

    push(db.ref('gw/profiles/' + fbKey(email)).set(profile));
    stats.profiles++;
    console.log('  ✓ Profil migré :', email);
  }
  console.groupEnd();

  /* ══════════════════════════════════════════════════════════════════
     4. PUBLICATIONS
     Clé localStorage : gw_userposts_{email}
     Destination Firebase : gw/posts/{fbKey}
  ══════════════════════════════════════════════════════════════════ */
  console.group('📝 Migration publications...');
  for (var l = 0; l < localStorage.length; l++) {
    var postKey = localStorage.key(l);
    if (!postKey || !postKey.startsWith('gw_userposts_')) continue;

    var postEmail = postKey.replace('gw_userposts_', '');
    if (!postEmail || !postEmail.includes('@')) continue;

    var posts = safe(function() { return JSON.parse(localStorage.getItem(postKey)); });
    if (!Array.isArray(posts) || !posts.length) continue;

    push(db.ref('gw/posts/' + fbKey(postEmail)).set(posts));
    stats.posts += posts.length;
    console.log('  ✓ Posts migrés :', postEmail, '→', posts.length, 'posts');
  }
  console.groupEnd();

  /* ══════════════════════════════════════════════════════════════════
     5. ABONNEMENTS (FOLLOWING)
     Clé localStorage : gw_following_{email}
     Destination Firebase : gw/following/{fbKey}
  ══════════════════════════════════════════════════════════════════ */
  console.group('🔗 Migration abonnements...');
  for (var m = 0; m < localStorage.length; m++) {
    var fwKey = localStorage.key(m);
    if (!fwKey || !fwKey.startsWith('gw_following_')) continue;

    var fwEmail = fwKey.replace('gw_following_', '');
    if (!fwEmail || !fwEmail.includes('@')) continue;

    var following = safe(function() { return JSON.parse(localStorage.getItem(fwKey)); });
    if (!Array.isArray(following)) continue;

    push(db.ref('gw/following/' + fbKey(fwEmail)).set(following));
    stats.following++;
    console.log('  ✓ Following migré :', fwEmail, '→', following.length, 'abonnements');
  }
  console.groupEnd();

  /* ══════════════════════════════════════════════════════════════════
     6. COMPTEURS D'ABONNÉS (FOLLOW COUNTS)
     Clé localStorage : gw_fc_{profileKey}
     Destination Firebase : gw/follow_counts/{profileKey}
  ══════════════════════════════════════════════════════════════════ */
  console.group('📊 Migration compteurs abonnés...');
  var fcBatch = {};
  for (var n = 0; n < localStorage.length; n++) {
    var fcKey = localStorage.key(n);
    if (!fcKey || !fcKey.startsWith('gw_fc_')) continue;

    var profileKey = fcKey.replace('gw_fc_', '');
    var count = parseInt(localStorage.getItem(fcKey), 10);
    if (isNaN(count) || count <= 0) continue;

    fcBatch[profileKey] = count;
    stats.fc++;
  }
  if (Object.keys(fcBatch).length) {
    push(db.ref('gw/follow_counts').update(fcBatch));
    console.log('  ✓ Compteurs migrés :', Object.keys(fcBatch).length, 'profils');
  }
  console.groupEnd();

  /* ══════════════════════════════════════════════════════════════════
     ATTENTE + RAPPORT FINAL
  ══════════════════════════════════════════════════════════════════ */
  Promise.all(writes).then(function() {
    console.group('✅ MIGRATION TERMINÉE');
    console.log('  📨 Messages DM migrés   :', stats.dm);
    console.log('  👥 Messages groupe migrés:', stats.grp);
    console.log('  👤 Profils migrés        :', stats.profiles);
    console.log('  📝 Publications migrées  :', stats.posts);
    console.log('  🔗 Following migrés      :', stats.following);
    console.log('  📊 Compteurs abonnés     :', stats.fc);
    if (stats.errors) {
      console.warn('  ⚠️  Erreurs               :', stats.errors);
    } else {
      console.log('  ❌ Erreurs               : 0');
    }
    console.groupEnd();
    console.groupEnd();

    if (typeof showToast === 'function') {
      showToast('Migration Firebase terminée ✅ — ' + (stats.dm + stats.grp) + ' messages synchronisés', 'ok');
    }
  });

})();
