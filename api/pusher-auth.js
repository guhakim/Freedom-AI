'use strict';
const Pusher = require('pusher');
const { isValidRoomId, checkAccess } = require('../lib/auth');

// join.js와 동일한 팔레트 — presence user_info.color는 반드시 이 중 하나여야 한다.
// (다른 사용자 브라우저가 이 값을 innerHTML에 그대로 꽂아 쓰므로, 검증 없이
//  통과시키면 임의 문자열이 다른 클라이언트에서 그대로 렌더링되어 XSS로 이어진다.)
const COLORS = ['#8b5cf6','#0ea5e9','#ef4444','#22c55e','#f59e0b','#ec4899','#06b6d4','#f97316'];
const MAX_NAME = 50;

async function getKv() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  try { return require('@vercel/kv').kv; } catch { return null; }
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
  if (typeof socket_id !== 'string' || typeof channel_name !== 'string') return res.status(400).end();
  // 이 앱이 실제로 쓰는 채널(presence-room-*)만 서명한다 — 예전엔 아무 채널 이름이나 서명해줬다
  if (!channel_name.startsWith('presence-room-')) return res.status(403).json({ error: 'invalid_channel' });
  if (typeof user_id !== 'string' || !/^[A-Za-z0-9]{4,64}$/.test(user_id)) return res.status(400).json({ error: 'invalid_user' });

  const roomId = fromChannelSafe(channel_name.slice('presence-room-'.length));
  if (!isValidRoomId(roomId)) return res.status(400).json({ error: 'invalid_room' });
  try {
    const kv = await getKv();
    if (!(await checkAccess(kv, req, roomId, email))) return res.status(403).json({ error: 'access_denied' });
  } catch (e) {
    console.error('pusher-auth', e);
    return res.status(500).json({ error: 'server_error' });
  }

  const name  = typeof user_name === 'string' ? user_name.slice(0, MAX_NAME) : '';
  const color = COLORS.includes(user_color) ? user_color : COLORS[0];
  const auth = getPusher().authorizeChannel(socket_id, channel_name, {
    user_id,
    user_info: { name, color },
  });

  res.json(auth);
};
