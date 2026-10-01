'use strict';
const crypto = require('crypto');
const { isValidRoomId, verifyEmail } = require('../lib/auth');

async function getKv() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  try { return require('@vercel/kv').kv; } catch { return null; }
}

const INVITE_TTL = 7 * 24 * 3600; // 초대 링크 유효기간: 7일
const MAX_ROOMID = 32;

const verifyOwner = verifyEmail;

// 초대 토큰은 추측할 수 없어야 한다 (Math.random은 예측 가능)
function genToken() {
  return crypto.randomBytes(18).toString('base64url');
}

function normalize(list) {
  return Array.isArray(list) ? list.map(m => String(m).toLowerCase()) : [];
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const kv = await getKv();
  if (!kv || !process.env.KV_REST_API_URL) return res.status(500).json({ error: 'kv_not_configured' });

  // 팀원 목록 조회 — 아직 비공개 전환 안 된(레거시 오픈) 방은 누구나 조회 가능,
  // 비공개 전환된 방은 멤버만 조회 가능
  if (req.method === 'GET') {
    const roomId = req.query?.roomId;
    if (!isValidRoomId(roomId)) return res.status(400).json({ error: 'roomId required' });

    const members = normalize(await kv.get(`fa:room:${roomId}:members`));
    if (!members.length) return res.json({ isPrivate: false, members: [] });

    const email = req.query?.email;
    if (!email || !(await verifyOwner(req, email))) return res.status(401).json({ error: 'unauthorized' });
    if (!normalize(members).includes(email.toLowerCase())) return res.status(403).json({ error: 'not_a_member' });
    return res.json({ isPrivate: true, members });
  }

  if (req.method === 'POST') {
    const { action, roomId, email } = req.body || {};

    // 방을 비공개로 전환(최초 1회) + 초대 링크 발급. 이미 비공개인 방이면 기존 멤버만 초대 링크를 새로 만들 수 있음
    if (action === 'invite') {
      if (!isValidRoomId(roomId) || roomId.length > MAX_ROOMID) return res.status(400).json({ error: 'roomId required' });
      if (!email || !(await verifyOwner(req, email))) return res.status(401).json({ error: 'unauthorized' });

      const key = `fa:room:${roomId}:members`;
      let members = normalize(await kv.get(key));
      if (!members.length) {
        members = [email.toLowerCase()];
        await kv.set(key, members);
      } else if (!members.includes(email.toLowerCase())) {
        return res.status(403).json({ error: 'not_a_member' });
      }

      const inviteToken = genToken();
      await kv.set(`fa:invite:${inviteToken}`, { roomId }, { ex: INVITE_TTL });
      return res.json({ token: inviteToken });
    }

    // 초대 링크 사용 — 로그인한 이메일을 해당 방 멤버로 추가
    if (action === 'redeem') {
      const { token } = req.body || {};
      if (!token || typeof token !== 'string' || token.length > 64) return res.status(400).json({ error: 'token required' });
      if (!email || !(await verifyOwner(req, email))) return res.status(401).json({ error: 'unauthorized' });

      const invite = await kv.get(`fa:invite:${token}`);
      if (!invite?.roomId) return res.status(404).json({ error: 'invalid_or_expired_invite' });

      const key = `fa:room:${invite.roomId}:members`;
      const members = normalize(await kv.get(key));
      // 방 이름이 바뀌었거나 비공개가 풀린 뒤의 옛 초대 링크로, 사용자 혼자만 멤버인 새 목록을
      // 만들어 방을 차지하지 못하게 한다
      if (!members.length) return res.status(404).json({ error: 'invalid_or_expired_invite' });
      const lower = email.toLowerCase();
      if (!members.includes(lower)) {
        members.push(lower);
        await kv.set(key, members);
      }
      return res.json({ roomId: invite.roomId });
    }

    // 멤버 제거 — 방을 비공개로 전환한 사람(목록의 첫 멤버)만 다른 멤버를 내보낼 수 있고,
    // 나머지 멤버는 자기 자신만 나갈 수 있다. (예전엔 새로 초대받은 멤버가 다른 모두를 내보내고
    // 방을 차지할 수 있었다.) 소유자 본인은 제거할 수 없다.
    if (action === 'remove') {
      const { removeEmail } = req.body || {};
      if (!isValidRoomId(roomId)) return res.status(400).json({ error: 'roomId required' });
      if (!removeEmail || typeof removeEmail !== 'string') return res.status(400).json({ error: 'removeEmail required' });
      if (!email || !(await verifyOwner(req, email))) return res.status(401).json({ error: 'unauthorized' });

      const key = `fa:room:${roomId}:members`;
      const members = normalize(await kv.get(key));
      const me = email.toLowerCase(), target = removeEmail.toLowerCase();
      if (!members.includes(me)) return res.status(403).json({ error: 'not_a_member' });
      if (target === members[0]) return res.status(403).json({ error: 'cannot_remove_owner' });
      if (me !== members[0] && me !== target) return res.status(403).json({ error: 'owner_only' });

      const updated = members.filter(m => m !== removeEmail.toLowerCase());
      // 멤버가 0명이 되면, kv에 저장된 빈 배열([])은 "값 있음"으로 취급되어
      // checkAccess()가 그 방을 아무도 못 들어오는 상태로 영구히 잠가버린다 — 마지막 멤버는 제거 금지
      if (!updated.length) return res.status(400).json({ error: 'cannot_remove_last_member' });
      await kv.set(key, updated);
      return res.json({ members: updated });
    }

    return res.status(400).json({ error: 'unknown_action' });
  }

  res.status(405).end();
};
