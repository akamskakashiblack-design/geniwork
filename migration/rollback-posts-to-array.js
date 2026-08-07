/**
 * GENIWORK — Rollback : restaure gw/posts depuis la sauvegarde
 *
 * Utilisation :
 *   node rollback-posts-to-array.js posts_backup_1720000000000
 *
 * Ce script restaure le contenu de gw/posts depuis la sauvegarde créée par
 * migrate-posts-to-object.js. Il écrase le contenu ACTUEL de gw/posts.
 *
 * ⚠️  ATTENTION : Les publications créées APRÈS la migration (et présentes dans
 *    le nouveau format) seront perdues si elles ne sont pas dans la sauvegarde.
 *    Effectuez un diagnostic avant de rollback :
 *      node diagnostic-posts.js
 *
 * Pour lister les sauvegardes disponibles :
 *   SERVICE_ACCOUNT_PATH=./serviceAccount.json node rollback-posts-to-array.js --list
 */

'use strict';

const admin = require('firebase-admin');
const path  = require('path');

const saPath = process.env.SERVICE_ACCOUNT_PATH
  || process.env.GOOGLE_APPLICATION_CREDENTIALS
  || path.join(__dirname, '..', 'serviceAccount.json');

let serviceAccount;
try {
  serviceAccount = require(saPath);
} catch(e) {
  console.error('[ROLLBACK] ❌ Impossible de charger le compte de service :', saPath);
  process.exit(1);
}

admin.initializeApp({
  credential:   admin.credential.cert(serviceAccount),
  databaseURL:  process.env.FIREBASE_DATABASE_URL || serviceAccount.databaseURL
                || 'https://geniwork-default-rtdb.firebaseio.com',
});

const db = admin.database();

const backupKey = process.argv[2];

async function listBackups() {
  console.log('\n📋 Sauvegardes disponibles dans Firebase (gw/posts_backup_*)...');
  const snap = await db.ref('gw').once('value');
  const root = snap.val() || {};
  const keys = Object.keys(root).filter(k => k.startsWith('posts_backup_'));
  if (!keys.length) {
    console.log('  Aucune sauvegarde trouvée.');
  } else {
    keys.sort().forEach(k => {
      const ts = parseInt(k.replace('posts_backup_', ''));
      const d  = isNaN(ts) ? '' : ' (' + new Date(ts).toISOString() + ')';
      const cnt = root[k] ? Object.keys(root[k]).length + ' user(s)' : 'vide';
      console.log(`  ${k}${d} — ${cnt}`);
    });
  }
  console.log('\nUsage : node rollback-posts-to-array.js <backupKey>');
  process.exit(0);
}

async function rollback() {
  if (!backupKey || backupKey === '--list') {
    await listBackups();
    return;
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  GENIWORK — Rollback gw/posts depuis', backupKey);
  console.log('  ' + new Date().toISOString());
  console.log('═══════════════════════════════════════════════════════════════\n');

  /* ── Lecture de la sauvegarde ── */
  console.log('📖 Lecture de la sauvegarde gw/' + backupKey + '...');
  const snapBackup = await db.ref('gw/' + backupKey).once('value');
  const backup     = snapBackup.val();

  if (!backup) {
    console.error('❌ Sauvegarde introuvable : gw/' + backupKey);
    console.log('  → Listez les sauvegardes : node rollback-posts-to-array.js --list');
    process.exit(1);
  }

  const emailKeys = Object.keys(backup);
  console.log(`   → ${emailKeys.length} utilisateur(s) dans la sauvegarde`);

  /* ── Confirmation ── */
  console.log('\n⚠️  ATTENTION : Cette opération va écraser gw/posts avec la sauvegarde.');
  console.log('   Les publications créées APRÈS la migration peuvent être perdues.');
  console.log('   Appuyez sur Ctrl+C pour annuler, ou attendez 10 secondes pour continuer...\n');

  await new Promise(resolve => setTimeout(resolve, 10000));

  /* ── Sauvegarde de l'état actuel avant rollback ── */
  const rollbackBackupKey = 'posts_pre_rollback_' + Date.now();
  console.log('💾 Sauvegarde de l\'état actuel avant rollback dans gw/' + rollbackBackupKey + '...');
  const snapCurrent = await db.ref('gw/posts').once('value');
  await db.ref('gw/' + rollbackBackupKey).set(snapCurrent.val());
  console.log('   → OK\n');

  /* ── Restauration ── */
  console.log('🔄 Restauration de gw/posts depuis la sauvegarde...');
  await db.ref('gw/posts').set(backup);
  console.log('   → OK\n');

  /* ── Vérification ── */
  const snapAfter = await db.ref('gw/posts').once('value');
  const afterVal  = snapAfter.val() || {};
  console.log(`🔍 Vérification : ${Object.keys(afterVal).length} utilisateur(s) dans gw/posts`);

  console.log('\n─── Résumé ─────────────────────────────────────────────────────');
  console.log('  Rollback effectué depuis : gw/' + backupKey);
  console.log('  État pré-rollback sauvegardé dans : gw/' + rollbackBackupKey);
  console.log('────────────────────────────────────────────────────────────────\n');

  process.exit(0);
}

rollback().catch(e => {
  console.error('[ROLLBACK] ❌ Erreur fatale :', e.message);
  process.exit(1);
});
