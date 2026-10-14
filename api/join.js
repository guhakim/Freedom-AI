'use strict';
const { isValidRoomId, checkAccess } = require('../lib/auth');

const COLORS = ['#8b5cf6','#0ea5e9','#ef4444','#22c55e','#f59e0b','#ec4899','#06b6d4','#f97316'];
let colorCounter = 0;

async function getKv() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  try { return require('@vercel/kv').kv; } catch { return null; }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { roomId, email, clientId } = req.body || {};
  if (!isValidRoomId(roomId)) return res.status(400).json({ error: 'roomId required' });

  // 클라이언트가 localStorage에 보관한 고정 id를 그대로 써서, 새로고침·재접속해도
  // userId가 매번 바뀌지 않게 한다 — 안 그러면 노트/획 등의 "본인 것만 삭제/이동" 권한
  // 체크가 새로고침 이후엔 항상 실패해, 지운 게 서버엔 반영 안 되고 되살아나 보인다.
  const userId = (typeof clientId === 'string' && /^[A-Za-z0-9]{4,64}$/.test(clientId))
    ? clientId
    : Math.random().toString(36).slice(2, 10);
  let color = COLORS[colorCounter++ % 8];
  let state = { strokes: [], notes: [], images: [], shapes: [], todos: {} };

  const kv = await getKv();
  if (!(await checkAccess(kv, req, roomId, email))) return res.status(403).json({ error: 'access_denied' });

  if (kv && process.env.KV_REST_API_URL) {
    // 접속자 색 번호는 못 받아도 로컬 카운터로 대체되는 장식이라 실패를 삼켜도 된다.
    try { color = COLORS[Number(await kv.incr('fa:colorIdx')) % 8]; } catch { /* 로컬 카운터 유지 */ }
    try {
      const stored = await kv.get(`fa:room:${roomId}`);
      if (stored) state = { ...stored };
      // todos 기능 이전에 만들어진 방은 저장된 state에 todos 키가 없을 수 있다.
      if (!state.todos) state.todos = {};
      delete state.createdBy; // 만든 사람 이메일은 노출하지 않는다
      delete state.contributors; // 함께 쓴 사람들의 이메일도 마찬가지
    } catch (e) {
      // 예전엔 이 실패를 "KV 미설정"과 같이 묶어 삼키고 빈 state를 200으로 돌려줬다. 그러면
      // 처음 들어오는 협업자는 오류 한 줄 없이 백지 캔버스를 받아 그게 방의 전부라고 믿게 된다
      // (돌아오는 사용자만 app.html의 localStorage 사본으로 우연히 구제됐다).
      // api/room.js·api/action.js와 같이 500으로 알려서 클라이언트가 다시 시도하게 한다.
      console.error('join kv', e);
      return res.status(500).json({ error: 'server_error' });
    }
  }

  res.json({
    userId,
    color,
    state,
    pusherKey:     process.env.PUSHER_KEY,
    pusherCluster: process.env.PUSHER_CLUSTER,
  });
};
