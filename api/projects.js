'use strict';

async function getKv() {
  try { return require('@vercel/kv').kv; } catch { return null; }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const kv = await getKv();
  const kvOk = kv && process.env.KV_REST_API_URL;

  if (req.method === 'GET') {
    const email = req.query?.email;
    if (!email || typeof email !== 'string') return res.status(400).json({ error: 'email required' });
    try {
      const projects = kvOk ? (await kv.get(`fa:user:projects:${email}`)) || [] : [];
      res.json({ projects });
    } catch(e) {
      res.json({ projects: [] });
    }
    return;
  }

  if (req.method === 'POST') {
    const { email, projects } = req.body || {};
    if (!email || typeof email !== 'string') return res.status(400).json({ error: 'email required' });
    if (!Array.isArray(projects)) return res.status(400).json({ error: 'projects array required' });
    const validated = projects
      .filter(p => typeof p === 'string' && p.length > 0 && p.length <= 64)
      .slice(0, 10);
    try {
      if (kvOk) await kv.set(`fa:user:projects:${email}`, validated);
      res.json({ projects: validated });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
    return;
  }

  res.status(405).end();
};
