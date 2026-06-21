/* GET /api/ai/status?email=... — etat credits/plan courant, sans deduction */

const { getCreditState } = require('./_lib/credits');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const email = req.query && req.query.email;
  if (!email) { res.status(401).json({ error: 'email manquant' }); return; }

  try {
    const state = await getCreditState(email);
    res.status(200).json({ creditState: state });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
