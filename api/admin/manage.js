/* ═══════════════════════════════════════════════════════════════
   GENIWORK — POST /api/admin/manage
   Toutes les actions qui modifient la liste des administrateurs
   passent desormais par ici (verifiees via le jeton de session
   signe cote serveur) au lieu d'ecrire directement dans Firebase
   depuis le navigateur.
   Body: { token, action, ...donnees selon l'action }
   Actions : promote, approveRequest, rejectRequest, resetPassword,
             changeRole, revoke
═══════════════════════════════════════════════════════════════ */

const { dbGet, dbSet, dbRemove, emailKey } = require('./_lib/fbrest');
const { hashPwd } = require('./_lib/pwd');
const { verify } = require('./_lib/session');

function toArray(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return Object.keys(v).sort((a, b) => Number(a) - Number(b)).map((k) => v[k]);
  return [];
}

async function getAdmins() { return toArray(await dbGet('/gw/admins')); }
async function getRequests() { return toArray(await dbGet('/gw/admin_requests')); }

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const body = req.body || {};
    const session = verify(body.token);
    if (!session) { res.status(401).json({ error: 'Session admin invalide ou expiree, reconnectez-vous.' }); return; }
    if (session.role !== 'Super Admin') { res.status(403).json({ error: 'Reserve au Super Admin.' }); return; }

    const action = body.action;

    if (action === 'promote') {
      const email = String(body.email || '').trim().toLowerCase();
      const nom = String(body.nom || '').trim().slice(0, 100);
      const role = String(body.role || 'Administrateur').slice(0, 40);
      if (!email) { res.status(400).json({ error: 'Email requis' }); return; }

      let admins = await getAdmins();
      admins = admins.filter((a) => !(a && a.email && a.email.toLowerCase() === email));
      admins.push({ email, nom, role, addedBy: session.email, addedAt: new Date().toISOString() });
      await dbSet('/gw/admins', admins);
      res.status(200).json({ ok: true, admins });
      return;
    }

    if (action === 'approveRequest') {
      const id = body.requestId;
      const requests = await getRequests();
      const reqEntry = requests.find((r) => r && r.id === id);
      if (!reqEntry) { res.status(404).json({ error: 'Demande introuvable' }); return; }

      let admins = await getAdmins();
      const already = admins.some((a) => a && a.email && a.email.toLowerCase() === reqEntry.email.toLowerCase());
      if (already) { res.status(400).json({ error: 'Cet email est deja administrateur' }); return; }

      admins.push({
        email: reqEntry.email, nom: reqEntry.nom, role: reqEntry.role,
        grantedBy: session.email, grantedAt: new Date().toISOString(),
      });
      await dbSet('/gw/admins', admins);

      if (reqEntry.pwHash) {
        await dbSet('/gw/admin_secrets/admins/' + emailKey(reqEntry.email), { pwHash: reqEntry.pwHash });
      }

      const updatedRequests = requests.map((r) => (r && r.id === id
        ? Object.assign({}, r, { status: 'approved', resolvedAt: new Date().toISOString(), pwHash: undefined, salt: undefined })
        : r));
      await dbSet('/gw/admin_requests', updatedRequests);

      res.status(200).json({ ok: true, admins, requests: updatedRequests, approvedEmail: reqEntry.email, approvedRole: reqEntry.role });
      return;
    }

    if (action === 'rejectRequest') {
      const id = body.requestId;
      const requests = await getRequests();
      const reqEntry = requests.find((r) => r && r.id === id);
      if (!reqEntry) { res.status(404).json({ error: 'Demande introuvable' }); return; }

      const updatedRequests = requests.map((r) => (r && r.id === id
        ? Object.assign({}, r, { status: 'rejected', resolvedAt: new Date().toISOString() })
        : r));
      await dbSet('/gw/admin_requests', updatedRequests);
      res.status(200).json({ ok: true, requests: updatedRequests, rejectedEmail: reqEntry.email });
      return;
    }

    if (action === 'resetPassword') {
      const email = String(body.email || '').trim().toLowerCase();
      const newPassword = String(body.newPassword || '');
      if (!email) { res.status(400).json({ error: 'Email requis' }); return; }
      if (newPassword.length < 6) { res.status(400).json({ error: 'Mot de passe trop court (6 min)' }); return; }

      const admins = await getAdmins();
      const entry = admins.find((a) => a && a.email && a.email.toLowerCase() === email);
      if (!entry) { res.status(404).json({ error: 'Membre introuvable' }); return; }

      const pwHash = hashPwd(newPassword);
      await dbSet('/gw/admin_secrets/admins/' + emailKey(email), { pwHash });

      // Garde le compte utilisateur normal synchronise (comportement historique)
      const users = toArray(await dbGet('/gw/users'));
      const uIdx = users.findIndex((u) => u && u.email && u.email.toLowerCase() === email);
      if (uIdx !== -1) {
        users[uIdx] = Object.assign({}, users[uIdx], { password: pwHash });
        await dbSet('/gw/users', users);
      }

      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'changeRole') {
      const email = String(body.email || '').trim().toLowerCase();
      const newRole = String(body.role || '').trim().slice(0, 40);
      if (!email || !newRole) { res.status(400).json({ error: 'Email et role requis' }); return; }

      const admins = await getAdmins();
      const idx = admins.findIndex((a) => a && a.email && a.email.toLowerCase() === email);
      if (idx === -1) { res.status(404).json({ error: 'Membre introuvable' }); return; }

      const oldRole = admins[idx].role;
      admins[idx] = Object.assign({}, admins[idx], { role: newRole });
      await dbSet('/gw/admins', admins);
      res.status(200).json({ ok: true, admins, oldRole, newRole });
      return;
    }

    if (action === 'revoke') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!email) { res.status(400).json({ error: 'Email requis' }); return; }
      if (email === session.email.toLowerCase()) { res.status(400).json({ error: 'Impossible de se retirer soi-meme' }); return; }

      const admins = await getAdmins();
      const updated = admins.filter((a) => !(a && a.email && a.email.toLowerCase() === email));
      await dbSet('/gw/admins', updated);
      await dbRemove('/gw/admin_secrets/admins/' + emailKey(email));
      res.status(200).json({ ok: true, admins: updated });
      return;
    }

    res.status(400).json({ error: 'Action inconnue: ' + action });
  } catch (err) {
    console.error('[Geniwork Admin] erreur manage:', err.message);
    res.status(500).json({ error: err.message });
  }
};
