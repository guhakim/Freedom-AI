'use strict';
const Pusher = require('pusher');

// join.js와 동일한 팔레트 — presence user_info.color는 반드시 이 중 하나여야 한다.
// (다른 사용자 브라우저가 이 값을 innerHTML에 그대로 꽂아 쓰므로, 검증 없이
//  통과시키면 임의 문자열이 다른 클라이언트에서 그대로 렌더링되어 XSS로 이어진다.)
const COLORS = ['#8b5cf6','#0ea5e9','#ef4444','#22c55e','#f59e0b','#ec4899','#06b6d4','#f97316'];
const MAX_NAME = 50;

async function getKv() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  try { return require('@vercel/kv').kv; } catch { return null; }
}

// 토큰→이메일 검증 결과를 짧게 캐싱 — 서버리스 인스턴스가 재사용되는 동안은 반복 호출마다
// Google userinfo API를 왕복하지 않아도 되게 한다 (완벽한 보장은 아님)
const verifyCache = new Map(); // token -> { email, exp }
const VERIFY_CACHE_TTL = 5 * 60 * 1000;

async function verifyToken(token) {
  const cached = verifyCache.get(token);
  if (cached && cached.exp > Date.now()) return cached.email;
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const info = await r.json();
    if (typeof info.email !== 'string') return null;
    const email = info.email.toLowerCase();
    verifyCache.set(token, { email, exp: Date.now() + VERIFY_CACHE_TTL });
    return email;
  } catch { return null; }
}

// 방이 비공개로 전환된 경우(팀 초대를 한 번이라도 발급한 방) 멤버인지 검증.
// 아직 비공개 전환 안 된(레거시 오픈) 방은 지금까지처럼 누구나 구독 가능.
async function checkAccess(kv, req, roomId, email) {
  if (!kv) return true;
  const members = await kv.get(`fa:room:${roomId}:members`);
  if (!members) return true;
  if (!email) return false;
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return false;
  const verifiedEmail = await verifyToken(token);
  if (!verifiedEmail || verifiedEmail !== email.toLowerCase()) return false;
  return members.map(m => String(m).toLowerCase()).includes(email.toLowerCase());
}

// 채널 이름(presence-room-<base64url화된 roomId>)에서 실제 roomId를 복원 —
// checkAccess의 fa:room:${roomId}:members 조회에는 원래 roomId가 필요하다.
function fromChannelSafe(str) {
  try { return Buffer.from(str, 'base64url').toString('utf8'); } catch { return str; }
}

let _pusher;
function getPusher() {
  if (!_pusher) _pusher = new Pusher({
    appId:   process.env.PUSHER_APP_ID,
    key:     process.env.PUSHER_KEY,
    secret:  process.env.PUSHER_SECRET,
    cluster: process.env.PUSHER_CLUSTER,
    useTLS:  true,
  });
  return _pusher;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { socket_id, channel_name, user_id, user_name, user_color, email } = req.body || {};
  if (!socket_id || !channel_name) return res.status(400).end();

  if (channel_name.startsWith('presence-room-')) {
    const roomId = fromChannelSafe(channel_name.slice('presence-room-'.length));
    const kv = await getKv();
    if (!(await checkAccess(kv, req, roomId, email))) return res.status(403).json({ error: 'access_denied' });
  }

  const pusher = getPusher();
  let auth;
  if (channel_name.startsWith('presence-')) {
    const name  = typeof user_name === 'string' ? user_name.slice(0, MAX_NAME) : '';
    const color = COLORS.includes(user_color) ? user_color : COLORS[0];
    auth = pusher.authorizeChannel(socket_id, channel_name, {
      user_id,
      user_info: { name, color },
    });
  } else {
    auth = pusher.authorizeChannel(socket_id, channel_name);
  }

  res.json(auth);
};
