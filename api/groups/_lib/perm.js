/* ═══════════════════════════════════════════════════════════════
   GENIWORK — Verification de role pour un groupe libre (owner / admin /
   membre), partagee par tous les endpoints /api/groups/*.js (cover,
   admins, delete — Phase GROUPS-FREE-04). Lecture RTDB via compte de
   service (bypass Rules, meme pattern que ebook-download.js).
═══════════════════════════════════════════════════════════════ */

const { dbGet, emailKey } = require('../../admin/_lib/fbrest');

function isValidGroupId(v) {
  return typeof v === 'string' && /^gw_grp_adhoc_[A-Za-z0-9_]{1,64}$/.test(v);
}

/* Retourne null si le groupe n'existe pas / n'est pas un groupe libre. */
async function loadGroupRole(groupId, callerEmail) {
  if (!isValidGroupId(groupId)) return null;
  const meta = await dbGet('/gw/group_msgs/' + groupId + '/meta');
  if (!meta || !meta.isFreeGroup) return null;
  const myUid = emailKey(callerEmail);
  const isMember = !!(meta.members && meta.members[myUid] === true);
  const isOwner = meta.owner === myUid;
  const isAdmin = !!(meta.admins && meta.admins[myUid] === true);
  return { meta, myUid, isMember, isOwner, isAdmin };
}

module.exports = { loadGroupRole, isValidGroupId };
