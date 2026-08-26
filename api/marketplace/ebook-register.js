/* ═══════════════════════════════════════════════════════════════
   GENIWORK — POST /api/marketplace/ebook-register (Phase MK-EBK-SEC-01)

   Contrepartie écriture de ebook-download.js : depuis cette phase,
   gw/mk_listings_v2/{sellerUid}/{listingId} (public, .read:true) ne
   contient plus jamais ebookUrl — le client ne peut donc plus l'y
   écrire non plus (le champ est simplement retiré de la publication,
   js/app.js/_saveListing()).

   Le fichier réel reste stocké tel quel dans Firebase Storage
   (gw_ebooks/..., inchangé, Storage Rules hors périmètre de cette
   phase) ; seule son URL change de destination : gw/mk_ebook_files/
   {listingId}, un chemin qui n'a JAMAIS eu de règle Firebase l'autorisant
   — les Rules RTDB refusent par défaut tout chemin non explicitement
   accordé (vérifié : aucune règle catch-all sur "gw" ni sur la racine).
   Seul le compte de service (ce fichier, via fbrest.js) peut y écrire —
   aucune Rule à ajouter, aucune Rule à modifier.

   Body : { authRefreshToken, listingId, ebookUrl }
   Réponse : { ok:true } ou { ok:false, error }
═══════════════════════════════════════════════════════════════ */

const { dbGet, dbSet } = require('../admin/_lib/fbrest');
const { verify: verifyRefreshToken } = require('../auth/_lib/refreshToken');

function isValidListingId(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
}

/* Identique à resolveListing() de create-order.js/ebook-download.js —
   ne fait jamais confiance à un sellerUid fourni par le client. */
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

    const ticketData = verifyRefreshToken(body.authRefreshToken);
    if (!ticketData || !ticketData.email) {
      res.status(401).json({ ok: false, error: 'Session expirée, reconnectez-vous.' });
      return;
    }
    const callerEmail = ticketData.email;

    if (!isValidListingId(body.listingId)) {
      res.status(400).json({ ok: false, error: 'listingId invalide' });
      return;
    }
    const listingId = body.listingId;

    const ebookUrl = String(body.ebookUrl || '');
    if (!ebookUrl || !/^https:\/\//.test(ebookUrl)) {
      res.status(400).json({ ok: false, error: 'ebookUrl invalide' });
      return;
    }

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
    const { listing } = resolved;

    if (listing.type !== 'ebook') {
      res.status(400).json({ ok: false, error: 'Cette annonce n\'est pas un ebook' });
      return;
    }

    /* Seul le vendeur réel de CETTE annonce (jamais un sellerUid/email
       fourni par le client) peut enregistrer le fichier associé. */
    if (!listing.sellerEmail || listing.sellerEmail.toLowerCase() !== callerEmail.toLowerCase()) {
      res.status(403).json({ ok: false, error: 'Vous n\'êtes pas le vendeur de cette annonce' });
      return;
    }

    try {
      await dbSet('/gw/mk_ebook_files/' + listingId, ebookUrl);
    } catch (e) {
      res.status(500).json({ ok: false, error: 'Erreur serveur' });
      return;
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[Geniwork Marketplace] erreur ebook-register:', err.message);
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  }
};
