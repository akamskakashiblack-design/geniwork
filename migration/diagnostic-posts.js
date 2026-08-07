/**
 * GENIWORK — Diagnostic de la structure Firebase gw/posts
 *
 * Ce script lit la base de données Firebase en mode admin et produit un rapport
 * sur l'état actuel des publications : format (array vs object), nombre de posts
 * par utilisateur, posts perdus par l'ancien cap de 50, etc.
 *
 * Prérequis :
 *   npm install firebase-admin
 *   Mettre la clé de service dans GOOGLE_APPLICATION_CREDENTIALS ou la charger manuellement.
 *
 * Usage :
 *   GOOGLE_APPLICATION_CREDENTIALS=./serviceAccount.json node diagnostic-posts.js
 *   -- ou --
 *   SERVICE_ACCOUNT_PATH=./serviceAccount.json node diagnostic-posts.js
 *
 * NE MODIFIE AUCUNE DONNÉE.
 */

'use strict';

const admin = require('firebase-admin');
const path  = require('path');

/* ── Chargement des credentials ── */
const saPath = process.env.SERVICE_ACCOUNT_PATH
  || process.env.GOOGLE_APPLICATION_CREDENTIALS
  || path.join(__dirname, '..', 'serviceAccount.json');

let serviceAccount;
try {
  serviceAccount = require(saPath);
} catch(e) {
  console.error('[DIAGNOSTIC] ❌ Impossible de charger le compte de service :', saPath);
  console.error('  → Créez serviceAccount.json depuis Firebase Console > Paramètres > Comptes de service');
  process.exit(1);
}

admin.initializeApp({
  credential:   admin.credential.cert(serviceAccount),
  databaseURL:  process.env.FIREBASE_DATABASE_URL || serviceAccount.databaseURL
                || 'https://geniwork-default-rtdb.firebaseio.com',
});

const db = admin.database();

/* ── Utilitaires ── */
function byteSize(obj) {
  return Buffer.byteLength(JSON.stringify(obj), 'utf8');
}

function formatBytes(n) {
  if (n < 1024)       return n + ' B';
  if (n < 1024*1024)  return (n/1024).toFixed(1) + ' KB';
  return (n/1024/1024).toFixed(2) + ' MB';
}

function fbKeyToEmail(key) {
  return key.replace(/__d__/g, '.').replace(/__a__/g, '@');
}

function detectFormat(val) {
  if (val === null || val === undefined) return 'empty';
  if (Array.isArray(val)) return 'array';
  if (typeof val !== 'object') return 'unknown';
  const keys = Object.keys(val);
  const numericKeys = keys.filter(k => /^\d+$/.test(k));
  if (numericKeys.length === keys.length && keys.length > 0) return 'firebase-array-object';
  return 'object-by-postId';
}

/* ── Diagnostic principal ── */
async function runDiagnostic() {
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  GENIWORK — Diagnostic gw/posts — ' + new Date().toISOString());
  console.log('═══════════════════════════════════════════════════════\n');

  const snap = await db.ref('gw/posts').once('value');
  const postsRoot = snap.val();

  if (!postsRoot) {
    console.log('⚠️  gw/posts est vide ou inexistant.');
    process.exit(0);
  }

  const emailKeys = Object.keys(postsRoot);
  console.log(`Utilisateurs avec des posts dans Firebase : ${emailKeys.length}\n`);

  let totalPosts     = 0;
  let usersOver50    = 0;
  let usersAsArray   = 0;
  let usersAsObject  = 0;
  let totalSizeBytes = 0;

  const userReports = [];

  for (const fbKey of emailKeys) {
    const val    = postsRoot[fbKey];
    const email  = fbKeyToEmail(fbKey);
    const format = detectFormat(val);
    const size   = byteSize(val);
    totalSizeBytes += size;

    let posts = [];
    if (format === 'array') {
      posts = val.filter(Boolean);
    } else if (format === 'firebase-array-object' || format === 'object-by-postId') {
      posts = Object.values(val).filter(Boolean);
    }

    const count     = posts.length;
    const hasOver50 = count > 50;
    totalPosts += count;

    if (format === 'array' || format === 'firebase-array-object') usersAsArray++;
    else usersAsObject++;
    if (hasOver50) usersOver50++;

    /* Vérification des IDs */
    const ids       = posts.map(p => String(p.id || '')).filter(Boolean);
    const uniqueIds = new Set(ids);
    const dupIds    = ids.length !== uniqueIds.size;

    userReports.push({ email, fbKey, format, count, size, hasOver50, dupIds });
  }

  /* ── Tableau récapitulatif ── */
  console.log('┌─────────────────────────────────────────┬────────┬──────────────────────┬───────────┐');
  console.log('│ Email                                   │ Posts  │ Format               │ Taille    │');
  console.log('├─────────────────────────────────────────┼────────┼──────────────────────┼───────────┤');
  userReports.forEach(r => {
    const emailCol  = r.email.padEnd(39).slice(0, 39);
    const countCol  = (r.hasOver50 ? '⚠️ ' + r.count : String(r.count)).padEnd(6);
    const formatCol = r.format.padEnd(20);
    const sizeCol   = formatBytes(r.size).padEnd(9);
    const dupFlag   = r.dupIds ? ' [IDs dupliqués!]' : '';
    console.log(`│ ${emailCol} │ ${countCol} │ ${formatCol} │ ${sizeCol} │${dupFlag}`);
  });
  console.log('└─────────────────────────────────────────┴────────┴──────────────────────┴───────────┘');

  /* ── Résumé ── */
  console.log('\n─── Résumé ───────────────────────────────────────────');
  console.log(`  Total posts Firebase       : ${totalPosts}`);
  console.log(`  Taille totale              : ${formatBytes(totalSizeBytes)}`);
  console.log(`  Utilisateurs > 50 posts    : ${usersOver50}  ${usersOver50 > 0 ? '← affectés par l\'ancien cap' : '✅'}`);
  console.log(`  Noeuds en format array     : ${usersAsArray}  ${usersAsArray > 0 ? '← migration recommandée' : '✅'}`);
  console.log(`  Noeuds en format objet     : ${usersAsObject}`);
  console.log('──────────────────────────────────────────────────────\n');

  if (usersOver50 > 0) {
    console.log('⚠️  ACTION REQUISE : Des utilisateurs ont plus de 50 posts mais seuls 50 étaient');
    console.log('   synchronisés avec l\'ancien code. Leurs publications > 50 ne sont pas visibles');
    console.log('   par les autres utilisateurs. Exécutez migrate-posts-to-object.js pour corriger.\n');
  }

  if (usersAsArray > 0) {
    console.log('ℹ️  INFO : Certains nœuds sont en format array (ancien format). Le nouveau code');
    console.log('   peut lire les deux formats. La migration convertit en object-by-postId pour');
    console.log('   permettre les writes granulaires et la pagination future.\n');
  }

  process.exit(0);
}

runDiagnostic().catch(e => {
  console.error('[DIAGNOSTIC] ❌ Erreur fatale :', e.message);
  process.exit(1);
});
