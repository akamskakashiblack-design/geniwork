/* ═══════════════════════════════════════════════════════════════
   GENIWORK — Vercel Serverless Function : aperçu Open Graph d'une publication
   GET /api/post?id=POST_ID
   Retourne HTML avec meta OG + redirect vers SPA
═══════════════════════════════════════════════════════════════ */

const https = require('https');

const FB_DB_URL = 'https://geniwork-be35c-default-rtdb.europe-west1.firebasedatabase.app';

function fetchJson(url) {
  return new Promise(function(resolve, reject) {
    https.get(url, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        try { resolve(JSON.parse(data)); } catch(e) { resolve(null); }
      });
    }).on('error', function(e) { reject(e); });
  });
}

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* Cherche un post dans l'objet imbriqué gw/posts/{emailKey}[...] */
function findPost(postsObj, postId) {
  if (!postsObj || typeof postsObj !== 'object') return null;
  var pid = String(postId);
  for (var key in postsObj) {
    var arr = postsObj[key];
    if (!arr) continue;
    var list = Array.isArray(arr) ? arr : Object.values(arr);
    for (var i = 0; i < list.length; i++) {
      if (list[i] && String(list[i].id) === pid) return list[i];
    }
  }
  return null;
}

module.exports = async function handler(req, res) {
  /* CORS */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  var postId = (req.query && req.query.id) ? String(req.query.id).replace(/[^a-zA-Z0-9_\-]/g, '') : '';
  var type   = (req.query && req.query.t)  ? String(req.query.t) : 'post'; /* post | vs */

  var appOrigin = req.headers && req.headers.host
    ? 'https://' + req.headers.host
    : 'https://geniwork.vercel.app';

  var deepLink = appOrigin + '/?p=' + postId + (type !== 'post' ? '&pt=' + type : '');

  var title       = 'Geniwork — Réseau social freelance';
  var description = 'Découvrez cette publication sur Geniwork !';
  var imageUrl    = appOrigin + '/img/logo princ.svg';
  var postType    = 'article';

  /* Tente de charger les données du post depuis Firebase */
  try {
    var post = null;

    if (type === 'vs') {
      /* Short vidéo : cherche dans gw/posts */
    }

    /* Cherche dans les posts utilisateurs */
    if (!post) {
      var userPosts = await fetchJson(FB_DB_URL + '/gw/posts.json');
      post = findPost(userPosts, postId);
    }
    /* Cherche dans les posts officiels */
    if (!post) {
      var offPosts = await fetchJson(FB_DB_URL + '/gw/official_posts.json');
      if (offPosts) {
        var offList = Array.isArray(offPosts) ? offPosts : Object.values(offPosts);
        post = offList.find(function(p) { return p && String(p.id) === String(postId); }) || null;
      }
    }

    if (post) {
      var author = post.author || post.nom || 'Un utilisateur Geniwork';
      var text   = post.text || (post.video && post.video.title) || '';

      if (post.video) {
        title       = author + ' a partagé une vidéo sur Geniwork';
        description = text ? text.slice(0, 160) : 'Regardez cette vidéo sur Geniwork';
        postType    = 'video.other';
        if (post.video.thumb) imageUrl = post.video.thumb;
        else if (post.video.url) imageUrl = post.video.url;
      } else if (post.images && post.images.length > 0) {
        title       = author + ' a partagé une photo sur Geniwork';
        description = text ? text.slice(0, 160) : 'Découvrez cette photo sur Geniwork';
        imageUrl    = post.images[0];
      } else {
        title       = author + ' sur Geniwork';
        description = text ? text.slice(0, 200) : 'Découvrez cette publication sur Geniwork';
      }
    }
  } catch(e) {
    /* Utilise les valeurs par défaut */
  }

  var shareUrl = appOrigin + '/p/' + postId + (type !== 'post' ? '?t=' + type : '');

  var html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <title>${escHtml(title)}</title>

  <!-- Open Graph (Facebook, WhatsApp, LinkedIn) -->
  <meta property="og:type"        content="${escHtml(postType)}">
  <meta property="og:url"         content="${escHtml(shareUrl)}">
  <meta property="og:title"       content="${escHtml(title)}">
  <meta property="og:description" content="${escHtml(description)}">
  <meta property="og:image"       content="${escHtml(imageUrl)}">
  <meta property="og:site_name"   content="Geniwork">
  <meta property="og:locale"      content="fr_FR">

  <!-- Twitter Card -->
  <meta name="twitter:card"        content="summary_large_image">
  <meta name="twitter:title"       content="${escHtml(title)}">
  <meta name="twitter:description" content="${escHtml(description)}">
  <meta name="twitter:image"       content="${escHtml(imageUrl)}">

  <!-- SEO -->
  <meta name="description" content="${escHtml(description)}">
  <link rel="canonical" href="${escHtml(shareUrl)}">

  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#F0F4FF;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
    .card{background:#fff;border-radius:20px;box-shadow:0 4px 30px rgba(0,0,0,.12);max-width:420px;width:100%;overflow:hidden;text-align:center}
    .card-img{width:100%;height:220px;object-fit:cover;background:#E2E8F0}
    .card-body{padding:28px 24px}
    .brand{font-size:13px;font-weight:700;color:#6B7BF7;letter-spacing:1px;text-transform:uppercase;margin-bottom:12px}
    h1{font-size:18px;font-weight:700;color:#1A1A2E;line-height:1.4;margin-bottom:8px}
    p{font-size:14px;color:#6B7280;line-height:1.6;margin-bottom:24px}
    .btn{display:inline-block;background:linear-gradient(135deg,#6B7BF7,#A78BFA);color:#fff;font-weight:700;font-size:15px;padding:14px 32px;border-radius:50px;text-decoration:none;border:none;cursor:pointer;width:100%;transition:.2s}
    .btn:hover{opacity:.9;transform:translateY(-1px)}
    .note{font-size:12px;color:#9CA3AF;margin-top:14px}
  </style>
</head>
<body>
  <div class="card">
    ${imageUrl && !imageUrl.endsWith('.svg') ? `<img class="card-img" src="${escHtml(imageUrl)}" alt="" onerror="this.style.display='none'">` : ''}
    <div class="card-body">
      <div class="brand">Geniwork</div>
      <h1>${escHtml(title)}</h1>
      <p>${escHtml(description)}</p>
      <a href="${escHtml(deepLink)}" class="btn">Voir la publication →</a>
      <p class="note">Redirection automatique dans <span id="cnt">3</span>s…</p>
    </div>
  </div>
  <script>
    var n=3, el=document.getElementById('cnt');
    var t=setInterval(function(){n--;if(el)el.textContent=n;if(n<=0){clearInterval(t);window.location.replace(${JSON.stringify(deepLink)});}},1000);
  </script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.status(200).send(html);
};
