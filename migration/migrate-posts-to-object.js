/**
 * GENIWORK — Migration gw/posts : array → object-by-postId
 *
 * Ce script convertit les nœuds Firebase de format array :
 *   gw/posts/{emailKey} = [post1, post2, ...]
 * vers le format object-by-postId :
 *   gw/posts/{emailKey}/{postId} = post
 *
 * Ce format permet :
 *   - Des writes granulaires (1 post écrit, pas tout le tableau)
 *   - La suppression chirurgicale d'un post
 *   - Un nombre illimité de posts (plus de cap à 50)
 *   - La pagination future avec .limitToLast() / .endBefore()
 *
 * SÉCURITÉS :
 *   1. Sauvegarde automatique dans gw/posts_backup_{timestamp} avant migration
 *   2. Idempotent : peut être relancé plusieurs fois sans duplication
 *   3. Vérification post-migration avec comptage
 *   4. Rollback : voir rollback-posts-to-array.js
 *
 * Prérequis : npm install firebase-admin
 *
 * Usage :
 *   SERVICE_ACCOUNT_PATH=./serviceAccount.json node migrate-posts-to-object.js
 *   -- DRY-RUN (aperçu sans écriture) --
 *   DRY_RUN=true SERVICE_ACCOUNT_PATH=./serviceAccount.json node migrate-posts-to-object.js
 */

'use strict';

const admin = require('firebase-admin');
const path  = require('path');

const DRY_RUN = process.env.DRY_RUN === 'true';

/* ── Credentials ── */
const saPath = process.env.SERVICE_ACCOUNT_PATH
  || process.env.GOOGLE_APPLICATION_CREDENTIALS
  || path.join(__dirname, '..', 'serviceAccount.json');

let serviceAccount;
try {
  serviceAccount = require(saPath);
} catch(e) {
  console.error('[MIGRATE] ❌ Impossible de charger le compte de service :', saPath);
  process.exit(1);
}

admin.initializeApp({
  credential:   admin.credential.cert(serviceAccount),
  databaseURL:  process.env.FIREBASE_DATABASE_URL || serviceAccount.databaseURL
                || 'https://geniwork-default-rtdb.firebaseio.com',
});

const db = admin.database();

/* ── Utilitaires ── */
function fbKeyToEmail(key) {
  return key.replace(/__d__/g, '.').replace(/__a__/g, '@');
}

function detectFormat(val) {
  if (!val || typeof val !== 'object') return 'empty';
  if (Array.isArray(val)) return 'array';
  const keys = Object.keys(val);
  if (keys.length === 0) return 'empty';
  const numericKeys = keys.filter(k => /^\d+$/.test(k));
  if (numericKeys.length === keys.length) return 'firebase-array-object';
  return 'object-by-postId';
}

function normalizeToPosts(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.filter(Boolean);
  return Object.values(val).filter(Boolean);
}

/* ── Migration principale ── */
async function migrate() {
  const timestamp   = Date.now();
  const backupKey   = 'posts_backup_' + timestamp;

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  GENIWORK — Migration gw/posts → object-by-postId');
  console.log('  ' + new Date(timestamp).toISOString());
  if (DRY_RUN) console.log('  ⚠️  MODE DRY-RUN — Aucune écriture ne sera effectuée');
  console.log('═══════════════════════════════════════════════════════════════\n');

  /* ── Étape 1 : Lecture de l'état actuel ── */
  console.log('📖 Lecture de gw/posts...');
  const snap     = await db.ref('gw/posts').once('value');
  const postsRoot = snap.val();

  if (!postsRoot) {
    console.log('ℹ️  gw/posts est vide — aucune migration nécessaire.');
    process.exit(0);
  }

  const emailKeys = Object.keys(postsRoot);
  console.log(`   → ${emailKeys.length} utilisateur(s) trouvé(s)\n`);

  /* ── Étape 2 : Sauvegarde ── */
  if (!DRY_RUN) {
    console.log(`💾 Sauvegarde dans gw/${backupKey}...`);
    await db.ref('gw/' + backupKey).set(postsRoot);
    console.log(`   → Sauvegarde OK : gw/${backupKey}`);
    console.log('   → Pour restaurer : node rollback-posts-to-array.js ' + backupKey + '\n');
  } else {
    console.log('   [DRY-RUN] Sauvegarde ignorée\n');
  }

  /* ── Étape 3 : Migration utilisateur par utilisateur ── */
  let migrated = 0;
  let skipped  = 0;
  let errors   = 0;

  for (const fbKey of emailKeys) {
    const val    = postsRoot[fbKey];
    const email  = fbKeyToEmail(fbKey);
    const format = detectFormat(val);

    if (format === 'object-by-postId') {
      console.log(`  ✅ ${email} — déjà en format objet (${Object.keys(val).length} posts)`);
      skipped++;
      continue;
    }

    if (format === 'empty') {
      console.log(`  ⚪ ${email} — vide, ignoré`);
      skipped++;
      continue;
    }

    const posts    = normalizeToPosts(val);
    const postsObj = {};
    let   dupCount = 0;

    posts.forEach(function(p) {
      if (!p || !p.id) return;
      const key = String(p.id);
      if (postsObj[key]) dupCount++;
      postsObj[key] = p;
    });

    const postCount = Object.keys(postsObj).length;
    console.log(`  🔄 ${email} — ${posts.length} posts (format: ${format}${dupCount ? ', ' + dupCount + ' dupliqués fusionnés' : ''})`);

    if (DRY_RUN) {
      console.log(`     [DRY-RUN] Aurait écrit ${postCount} entrées dans gw/posts/${fbKey}`);
      migrated++;
      continue;
    }

    try {
      /* Écriture avec update() : ne supprime pas d'autres données dans le nœud */
      await db.ref('gw/posts/' + fbKey).update(postsObj);
      /* Puis supprimer les anciens indices numériques si c'était un array Firebase
         (clés "0", "1", "2"...) qui cohabitent maintenant avec les postIds */
      if (format === 'array' || format === 'firebase-array-object') {
        const oldKeys    = Object.keys(val).filter(k => /^\d+$/.test(k));
        const newPostIds = Object.keys(postsObj);
        /* Supprimer les clés numériques qui ne sont pas des postIds */
        const orphanKeys = oldKeys.filter(k => !newPostIds.includes(k));
        if (orphanKeys.length) {
          const nullUpdate = {};
          orphanKeys.forEach(k => { nullUpdate[k] = null; }); /* null = delete en Firebase */
          await db.ref('gw/posts/' + fbKey).update(nullUpdate);
          console.log(`     → Supprimé ${orphanKeys.length} clé(s) numérique(s) orpheline(s)`);
        }
      }
      console.log(`     → OK : ${postCount} posts écrits`);
      migrated++;
    } catch(e) {
      console.error(`  ❌ ${email} — Erreur :`, e.message);
      errors++;
    }
  }

  /* ── Étape 4 : Vérification ── */
  if (!DRY_RUN && migrated > 0) {
    console.log('\n🔍 Vérification post-migration...');
    const snapAfter  = await db.ref('gw/posts').once('value');
    const afterRoot  = snapAfter.val() || {};
    let   totalAfter = 0;
    Object.values(afterRoot).forEach(v => {
      if (v && typeof v === 'object') totalAfter += Object.keys(v).length;
    });
    console.log(`   → ${totalAfter} posts accessibles dans Firebase après migration`);
  }

  /* ── Résumé ── */
  console.log('\n─── Résumé ─────────────────────────────────────────────────────');
  console.log(`  Migrés  : ${migrated}`);
  console.log(`  Ignorés : ${skipped}  (déjà au bon format)`);
  console.log(`  Erreurs : ${errors}`);
  if (!DRY_RUN && migrated > 0) {
    console.log(`\n  Sauvegarde disponible dans : gw/${backupKey}`);
    console.log('  Pour annuler : node rollback-posts-to-array.js ' + backupKey);
  }
  console.log('────────────────────────────────────────────────────────────────\n');

  if (errors > 0) process.exit(1);
  process.exit(0);
}

migrate().catch(e => {
  console.error('[MIGRATE] ❌ Erreur fatale :', e.message);
  process.exit(1);
});
