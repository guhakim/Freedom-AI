'use strict';
const Pusher = require('pusher');

// join.js와 동일한 팔레트 — presence user_info.color는 반드시 이 중 하나여야 한다.
// (다른 사용자 브라우저가 이 값을 innerHTML에 그대로 꽂아 쓰므로, 검증 없이
//  통과시키면 임의 문자열이 다른 클라이언트에서 그대로 렌더링되어 XSS로 이어진다.)
const COLORS = ['#8b5cf6','#0ea5e9','#ef4444','#22c55e','#f59e0b','#ec4899','#06b6d4','#f97316'];
const MAX_NAME = 50;

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { socket_id, channel_name, user_id, user_name, user_color } = req.body || {};
  if (!socket_id || !channel_name) return res.status(400).end();

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
