/* GET /api/ai/status?authRefreshToken=... — etat credits/plan courant, sans deduction

   Phase AI-2 : identite derivee UNIQUEMENT de authRefreshToken (meme
   mecanisme que tous les autres endpoints securises de ce depot). Le
   parametre "email" precedemment utilise n'est plus jamais lu comme
   preuve d'identite. */

const { getCreditState } = require('./_lib/credits');
const { verify: verifyRefreshToken } = require('../auth/_lib/refreshToken');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const ticketData = verifyRefreshToken(req.query && req.query.authRefreshToken);
  if (!ticketData || !ticketData.email) {
    res.status(401).json({ error: 'Session expirée, reconnectez-vous.' });
    return;
  }
  const email = ticketData.email;

  try {
    const state = await getCreditState(email);
    res.status(200).json({ creditState: state });
  } catch (err) {
    console.error('[Geniwork AI] erreur status:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};
