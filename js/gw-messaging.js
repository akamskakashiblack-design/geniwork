/* ================================================================
   GW-MESSAGING  v2.2  — Override minimal, safe
   ----------------------------------------------------------------
   Principe : ne surcharger QUE ce qui est nécessaire pour le nouveau
   style de liste. Toute la logique Firebase (DM, groupes, envoi,
   statut en ligne, notifications) reste dans app.js — prouvée.
   Ce fichier ne touche pas à :
     openChat / closeChat / sendChatMessage / _dmOpen / _dmClose /
     _renderChatMessages / openChatWithUser / switchMsgTab /
     filterConversations / openChatMenu
   ================================================================ */

/* ══════════════════════════════════════════════════════════════
   LISTE DES CONVERSATIONS  (remplace renderConversations d'app.js)
   — même logique de filtre/tri, nouveau HTML avec classes gwm-*
══════════════════════════════════════════════════════════════ */
function renderConversations() {
  _loadGroupConvs();
  var list = document.getElementById('conv-list');
  if (!list) return;

  var query = ((document.getElementById('msg-search') || {}).value || '').toLowerCase().trim();

  var convs = DEMO_CONVERSATIONS.filter(function(c) {
    if (!c.isGroup && c.email && _admIsBanned(c.email)) return false;
    if (c.archived  && _msgTab !== 'archived') return false;
    if (!c.archived && _msgTab === 'archived') return false;
    if (_msgTab === 'unread' && c.unread === 0) return false;
    if (query) {
      return (c.name || '').toLowerCase().indexOf(query) !== -1 ||
             (c.lastMsg || '').toLowerCase().indexOf(query) !== -1;
    }
    return true;
  }).sort(function(a, b) {
    return (b.lastAt || b.at || 0) - (a.lastAt || a.at || 0);
  });

  /* ── Badges non-lus ── */
  var totalUnread = DEMO_CONVERSATIONS.reduce(function(s, c) { return s + (c.unread || 0); }, 0);
  _updateMsgNavBadge(totalUnread);
  var tabBadge = document.getElementById('msg-unread-count');
  if (tabBadge) {
    tabBadge.textContent = totalUnread > 99 ? '99+' : totalUnread;
    tabBadge.style.display = totalUnread > 0 ? '' : 'none';
  }

  if (!convs.length) {
    var ico = _msgTab === 'unread' ? 'envelope-open-text' : _msgTab === 'archived' ? 'box-archive' : 'comments';
    var txt = _msgTab === 'unread' ? 'Aucun message non lu'
            : _msgTab === 'archived' ? 'Aucune archive'
            : 'Aucune conversation';
    list.innerHTML = '<div class="gwm-empty"><i class="fas fa-' + ico + '"></i><p>' + txt + '</p></div>';
    return;
  }

  list.innerHTML = convs.map(function(c) {
    var displayName = c.isGroup
      ? c.name
      : (c.email ? getDisplayName(c.email, c.name) : c.name);
    var avHtml  = c.isGroup ? _groupAvatar(c, 50) : _convAvatar(c, 50);
    var badge   = c.unread > 0
      ? '<span class="gwm-badge">' + Math.min(c.unread, 99) + '</span>'
      : '';
    var timeStr = c.lastAt ? _convTimeAgo(c.lastAt) : (c.time || '');
    var preview = c.lastMsg || 'Démarrer la conversation';
    var isOpen  = c.id === _chatConvId;

    return (
      '<div class="gwm-conv' +
        (c.unread > 0 ? ' gwm-conv--unread' : '') +
        (isOpen ? ' gwm-conv--active' : '') +
        '" onclick="openChat(' + c.id + ')" data-conv-id="' + c.id + '">' +
        '<div class="gwm-av-wrap">' +
          avHtml +
          (!c.isGroup
            ? '<span class="gwm-dot' + (c.online ? ' gwm-dot--on' : '') + '"></span>'
            : '') +
        '</div>' +
        '<div class="gwm-info">' +
          '<div class="gwm-row1">' +
            '<span class="gwm-name">' +
              (c.isGroup ? '<i class="fas fa-users gwm-grp-ico"></i>' : '') +
              escHtml(displayName) +
              (!c.isGroup && c.verified
                ? ' <i class="fas fa-circle-check gwm-verified"></i>'
                : '') +
            '</span>' +
            '<span class="gwm-time">' + escHtml(timeStr) + '</span>' +
          '</div>' +
          '<div class="gwm-row2">' +
            '<span class="gwm-preview">' + escHtml(preview) + '</span>' +
            badge +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }).join('');
}

/* ══════════════════════════════════════════════════════════════
   AVATARS  — remplacent _convAvatar et _groupAvatar d'app.js
   Taille fixée par inline style pour éviter les photos géantes.
══════════════════════════════════════════════════════════════ */

function _convAvatar(c, sz) {
  sz = sz || 50;
  var st = 'width:' + sz + 'px;height:' + sz + 'px;border-radius:50%;' +
           'object-fit:cover;display:block;flex-shrink:0';

  if (c.email) {
    var p = loadUserProfile(c.email);
    if (p && p.photo) {
      return '<img src="' + escHtml(p.photo) + '" alt="" style="' + st + '" ' +
             'onerror="this.style.display=\'none\'">';
    }
  }
  if (c.avatar && c.avatar.type === 'img' && c.avatar.url) {
    return '<img src="' + escHtml(c.avatar.url) + '" alt="" style="' + st + '" ' +
           'onerror="this.style.display=\'none\'">';
  }
  var bg  = (c.avatar && c.avatar.color) || '#2563EB';
  var ini = typeof getInitials === 'function' ? getInitials(c.name) : (c.name || '?').charAt(0).toUpperCase();
  return '<div style="width:' + sz + 'px;height:' + sz + 'px;background:' + bg + ';' +
         'border-radius:50%;display:flex;align-items:center;justify-content:center;' +
         'font-weight:700;color:#fff;font-size:' + Math.round(sz * 0.38) + 'px;flex-shrink:0">' +
         escHtml(ini) + '</div>';
}

function _groupAvatar(c, sz) {
  sz = sz || 50;
  var members = (c.members || []).slice(0, 2);
  if (!members.length) {
    return '<div style="width:' + sz + 'px;height:' + sz + 'px;background:#6366F1;border-radius:50%;' +
           'display:flex;align-items:center;justify-content:center;color:#fff;' +
           'font-size:' + Math.round(sz * 0.4) + 'px;flex-shrink:0">' +
           '<i class="fas fa-users"></i></div>';
  }
  var half = Math.round(sz * 0.68);
  function mini(m, pos) {
    if (!m) return '';
    var pr  = (typeof loadUserProfile === 'function' && m.email) ? (loadUserProfile(m.email) || {}) : {};
    var ph  = pr.photo || m.photo;
    var nm  = pr.nom || m.name || m.email || '?';
    var base = 'width:' + half + 'px;height:' + half + 'px;border-radius:50%;' +
               'border:2px solid #fff;position:absolute;object-fit:cover;' + pos;
    if (ph) return '<img src="' + escHtml(ph) + '" style="' + base + '">';
    return '<div style="' + base + 'background:#6366F1;display:flex;align-items:center;' +
           'justify-content:center;color:#fff;font-weight:700;' +
           'font-size:' + Math.round(half * 0.42) + 'px">' +
           escHtml(nm.charAt(0).toUpperCase()) + '</div>';
  }
  return '<div style="width:' + sz + 'px;height:' + sz + 'px;position:relative;flex-shrink:0">' +
    mini(members[0], 'top:0;left:0;') +
    (members[1] ? mini(members[1], 'bottom:0;right:0;') : '') +
  '</div>';
}
