'use strict';

async function getKv() {
  try { return require('@vercel/kv').kv; } catch { return null; }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).end();
  const roomId = req.query?.roomId;
  if (!roomId || typeof roomId !== 'string') return res.status(400).json({ error: 'roomId required' });

  try {
    const kv = await getKv();
    const state = (kv && process.env.KV_REST_API_URL)
      ? await kv.get(`fa:room:${roomId}`)
      : null;
    res.json(state || { strokes: [], notes: [], images: [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
