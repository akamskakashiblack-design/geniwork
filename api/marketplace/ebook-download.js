/* ═══════════════════════════════════════════════════════════════
   GENIWORK — POST /api/marketplace/ebook-download (Phase MK-EBK-SEC-01)

   Ferme le bypass confirmé en STORAGE-SEC-01 : gw/mk_listings_v2 est
   public en lecture (.read:true, design voulu pour le catalogue) et
   contenait jusqu'ici ebookUrl en clair — n'importe qui pouvait lire
   l'URL Storage permanente d'un ebook payant sans jamais passer par
   gw/ebook_access ni payer.

   Depuis cette phase, ebookUrl n'est plus jamais écrit sur le listing
   public (voir ebook-register.js, js/app.js/_saveListing()). Le fichier
   réel est résolu ici, côté serveur, uniquement après vérification de
   l'identité (authRefreshToken) ET d'un droit d'accès réel :
     - vendeur de l'annonce (toujours autorisé) ;
     - ebook gratuit (isFree, jamais eu de restriction) ;
     - accès accordé dans gw/ebook_access/{listingId}/{emailKey}
       (achat serveur-vérifié via capture-order.js, ou octroi manuel
       vendeur — même contrat déjà utilisé par le produit, non modifié
       ici).

   Auto-migration : si une annonce ebook plus ancienne porte encore un
   ebookUrl public (publiée avant cette phase), il est déplacé vers le
   stockage privé gw/mk_ebook_files/{listingId} puis retiré du listing
   public, avant même de vérifier l'accès de l'appelant — referme le
   trou pour CE listing dès le premier appel authentifié qui le touche,
   sans dépendre d'une migration manuelle séparée.

   Body : { authRefreshToken, listingId }
   Réponse : { ok:true, url, title } ou { ok:false, error }
═══════════════════════════════════════════════════════════════ */

const { dbGet, dbSet, dbRemove, emailKey } = require('../admin/_lib/fbrest');
const { verify: verifyRefreshToken } = require('../auth/_lib/refreshToken');

function isValidListingId(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
}

async function resolveListing(listingId, nestedListingsV2) {
  if (nestedListingsV2 && typeof nestedListingsV2 === 'object') {
    for (const sellerUid of Object.keys(nestedListingsV2)) {
      const bySeller = nestedListingsV2[sellerUid];
      if (bySeller && typeof bySeller === 'object' && bySeller[listingId]) {
        return { listing: bySeller[listingId], sellerUid };
      }
    }
  }
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Method not allowed' }); return; }

  try {
    const body = req.body || {};

    /* ── Identité : dérivée UNIQUEMENT du jeton signé, jamais d'un
       champ email/uid que le client pourrait fournir. ── */
    const ticketData = verifyRefreshToken(body.authRefreshToken);
    if (!ticketData || !ticketData.email) {
      res.status(401).json({ ok: false, error: 'Connecte-toi pour télécharger cet ebook.' });
      return;
    }
    const callerEmail = ticketData.email;

    if (!isValidListingId(body.listingId)) {
      res.status(400).json({ ok: false, error: 'listingId invalide' });
      return;
    }
    const listingId = body.listingId;

    let nestedV2;
    try { nestedV2 = await dbGet('/gw/mk_listings_v2'); } catch (e) {
      res.status(500).json({ ok: false, error: 'Erreur serveur' });
      return;
    }
    const resolved = await resolveListing(listingId, nestedV2);
    if (!resolved) {
      res.status(404).json({ ok: false, error: 'Annonce introuvable' });
      return;
    }
    const { listing, sellerUid } = resolved;

    if (listing.type !== 'ebook') {
      res.status(400).json({ ok: false, error: 'Cette annonce n\'est pas un ebook' });
      return;
    }

    /* ── Résolution du fichier — stockage privé d'abord, sinon
       auto-migration depuis l'ancien champ public legacy. ── */
    let fileUrl = null;
    try { fileUrl = await dbGet('/gw/mk_ebook_files/' + listingId); } catch (e) { fileUrl = null; }
    if (!fileUrl && listing.ebookUrl) {
      fileUrl = listing.ebookUrl;
      try {
        await dbSet('/gw/mk_ebook_files/' + listingId, fileUrl);
        await dbRemove('/gw/mk_listings_v2/' + sellerUid + '/' + listingId + '/ebookUrl');
      } catch (e) { /* migration best-effort : ne bloque jamais la reponse */ }
    }
    if (!fileUrl) {
      res.status(404).json({ ok: false, error: 'Fichier ebook non disponible' });
      return;
    }

    /* ── Vérification d'accès — respecte exactement le contrat déjà
       utilisé par le produit (_mkCheckEbookAccess côté client),
       jamais inventé ici : vendeur, gratuit, ou entrée ebook_access
       existante (achat serveur-vérifié ou octroi manuel vendeur). ── */
    const isOwner = !!listing.sellerEmail && listing.sellerEmail.toLowerCase() === callerEmail.toLowerCase();
    const isFree = !!listing.isFree;
    let hasAccess = isOwner || isFree;

    if (!hasAccess) {
      let accessEntry = null;
      try { accessEntry = await dbGet('/gw/ebook_access/' + listingId + '/' + emailKey(callerEmail)); } catch (e) {
        res.status(500).json({ ok: false, error: 'Erreur serveur' });
        return;
      }
      hasAccess = !!accessEntry;
    }

    if (!hasAccess) {
      res.status(403).json({ ok: false, error: 'Accès non autorisé — achetez cet ebook pour le télécharger.' });
      return;
    }

    res.status(200).json({ ok: true, url: fileUrl, title: listing.title || '' });
  } catch (err) {
    console.error('[Geniwork Marketplace] erreur ebook-download:', err.message);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
};
