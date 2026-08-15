'use strict';

const COLORS = ['#8b5cf6','#0ea5e9','#ef4444','#22c55e','#f59e0b','#ec4899','#06b6d4','#f97316'];
let colorCounter = 0;

async function getKv() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  try { return require('@vercel/kv').kv; } catch { return null; }
}

// 방이 비공개로 전환된 경우(팀 초대를 한 번이라도 발급한 방) 멤버인지 검증.
// 아직 비공개 전환 안 된(레거시 오픈) 방은 지금까지처럼 누구나 입장 가능.
async function checkAccess(kv, req, roomId, email) {
  if (!kv) return true;
  const members = await kv.get(`fa:room:${roomId}:members`);
  if (!members) return true;
  if (!email) return false;
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return false;
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return false;
    const info = await r.json();
    if (typeof info.email !== 'string' || info.email.toLowerCase() !== email.toLowerCase()) return false;
  } catch { return false; }
  return members.map(m => String(m).toLowerCase()).includes(email.toLowerCase());
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { roomId, email } = req.body || {};
  if (!roomId) return res.status(400).json({ error: 'roomId required' });

  const userId = Math.random().toString(36).slice(2, 10);
  let color = COLORS[colorCounter++ % 8];
  let state = { strokes: [], notes: [], images: [], shapes: [] };

  const kv = await getKv();
  if (!(await checkAccess(kv, req, roomId, email))) return res.status(403).json({ error: 'access_denied' });

  try {
    if (kv && process.env.KV_REST_API_URL) {
      color = COLORS[Number(await kv.incr('fa:colorIdx')) % 8];
      state = (await kv.get(`fa:room:${roomId}`)) || state;
    }
  } catch (e) { /* KV 없으면 빈 캔버스로 시작 */ }

  res.json({
    userId,
    color,
    state,
    pusherKey:     process.env.PUSHER_KEY,
    pusherCluster: process.env.PUSHER_CLUSTER,
  });
};
