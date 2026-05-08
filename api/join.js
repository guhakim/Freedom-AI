'use strict';
const { kv } = require('@vercel/kv');

const COLORS = ['#8b5cf6','#0ea5e9','#ef4444','#22c55e','#f59e0b','#ec4899','#06b6d4','#f97316'];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { roomId } = req.body || {};
  if (!roomId) return res.status(400).json({ error: 'roomId required' });

  const userId   = Math.random().toString(36).slice(2, 10);
  const colorIdx = Number(await kv.incr('fa:colorIdx')) % 8;
  const color    = COLORS[colorIdx];
  const state    = (await kv.get(`fa:room:${roomId}`)) || { strokes: [], notes: [] };

  res.json({
    userId,
    color,
    state,
    pusherKey:     process.env.PUSHER_KEY,
    pusherCluster: process.env.PUSHER_CLUSTER,
  });
};
