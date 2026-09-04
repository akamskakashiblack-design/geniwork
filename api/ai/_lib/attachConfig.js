/* ═══════════════════════════════════════════════════════════════
   Pièces jointes Business AI (SYNC-135) — quels outils, quels types,
   quelle taille. Source unique consommée par chat.js pour la
   validation serveur — le mirror client (business-ai.html) doit
   rester numériquement cohérent avec ATTACH_MAX_BASE64_CHARS ici.

   ATTACH_MAX_BASE64_CHARS : budget dédié à la pièce jointe elle-même,
   distinct du plafond global MAX_PAYLOAD_CHARS (chat.js) qui couvre
   tout le tableau messages (texte + historique + structure JSON).
   300000 caractères base64 ≈ 225 Ko de fichier source (base64 ≈
   taille x 4/3) — suffisant pour une photo de facture compressée
   côté client ou un PDF léger, tout en restant loin d'un plafond
   "plusieurs Mo" qui transformerait l'endpoint en upload générique.
═══════════════════════════════════════════════════════════════ */

const ATTACH_CAPABLE = ['document', 'facture-recue'];

const ATTACH_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const ATTACH_PDF_TYPE = 'application/pdf';
const ATTACH_ALLOWED_TYPES = ATTACH_IMAGE_TYPES.concat([ATTACH_PDF_TYPE]);

const ATTACH_MAX_BASE64_CHARS = 300000;

/* Signatures magiques minimales (aucune dépendance) — la pièce jointe
   doit réellement être ce que son media_type prétend, jamais fait
   confiance sur la seule déclaration du client. */
const ATTACH_MAGIC_CHECK = {
  'application/pdf': (buf) => buf.length >= 4 && buf.slice(0, 4).toString('latin1') === '%PDF',
  'image/jpeg': (buf) => buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF,
  'image/png': (buf) => buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47,
  'image/webp': (buf) => buf.length >= 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP',
};

function verifyAttachmentMagicBytes(base64Data, mediaType) {
  const check = ATTACH_MAGIC_CHECK[mediaType];
  if (!check || typeof base64Data !== 'string') return false;
  try {
    const head = Buffer.from(base64Data.slice(0, 32), 'base64');
    return check(head);
  } catch (e) {
    return false;
  }
}

module.exports = {
  ATTACH_CAPABLE,
  ATTACH_IMAGE_TYPES,
  ATTACH_PDF_TYPE,
  ATTACH_ALLOWED_TYPES,
  ATTACH_MAX_BASE64_CHARS,
  verifyAttachmentMagicBytes,
};
