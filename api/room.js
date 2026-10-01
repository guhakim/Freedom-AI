'use strict';
const { isValidRoomId, checkAccess } = require('../lib/auth');

async function getKv() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  try { return require('@vercel/kv').kv; } catch { return null; }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();
  const roomId = req.query?.roomId;
  const email  = req.query?.email;
  if (!isValidRoomId(roomId)) return res.status(400).json({ error: 'roomId required' });

  try {
    const kv = await getKv();
    if (!(await checkAccess(kv, req, roomId, email))) return res.status(403).json({ error: 'access_denied' });
    const state = (kv && process.env.KV_REST_API_URL)
      ? await kv.get(`fa:room:${roomId}`)
      : null;
    // todos 기능 이전에 만들어진 방은 저장된 state에 todos 키 자체가 없을 수 있다 —
    // state가 존재하는 경우에도(=falsy 기본값으로 안 빠지는 경우에도) 보정해준다.
    const resolved = state || { strokes: [], notes: [], images: [], shapes: [], todos: {} };
    if (!resolved.todos) resolved.todos = {};
    res.json(resolved);
  } catch (e) {
    console.error('room', e);
    res.status(500).json({ error: 'server_error' });
  }
};
