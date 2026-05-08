'use strict';
const Pusher = require('pusher');

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
    auth = pusher.authorizeChannel(socket_id, channel_name, {
      user_id,
      user_info: { name: user_name, color: user_color },
    });
  } else {
    auth = pusher.authorizeChannel(socket_id, channel_name);
  }

  res.json(auth);
};
