'use strict';
const crypto = require('crypto');
const { isValidRoomId, verifyEmail, MAX_ROOMID } = require('../lib/auth');

async function getKv() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  try { return require('@vercel/kv').kv; } catch { return null; }
}

const INVITE_TTL = 7 * 24 * 3600; // 초대 링크 유효기간: 7일
// 방 이름 한도는 lib/auth.js의 MAX_ROOMID와 같아야 한다

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
        const room = await kv.get(`fa:room:${roomId}`);
        const me = email.toLowerCase();
        // 만든 사람이 기록된 방은 그 사람만 비공개로 전환할 수 있다
        if (room?.createdBy && room.createdBy !== me) return res.status(403).json({ error: 'owner_only' });
        // 만든 사람이 기록되지 않은 방(이 기능 이전에 만들어졌거나 게스트가 만든 방)은 주인을
        // 알 수 없다. 그렇다고 아무나 잠그게 두면 원래 쓰던 사람이 영구히 쫓겨나므로:
        //  (1) 그 방에서 실제로 작업한 적 있는 사람만 비공개로 바꿀 수 있고,
        //  (2) 바꿀 때 함께 쓰던 사람을 모두 멤버로 넣어 아무도 떨어져 나가지 않게 한다.
        const contributors = Array.isArray(room?.contributors) ? room.contributors.map(c => String(c).toLowerCase()) : [];
        if (!room?.createdBy && contributors.length && !contributors.includes(me)) {
          return res.status(403).json({ error: 'not_a_member' });
        }
        // 기록된 순서를 그대로 둔다 — members[0]이 소유자(다른 멤버를 내보낼 수 있는 사람)다.
        // 요청한 사람을 앞에 두면, 남의 방에 한 글자 쓰고 비공개로 바꾼 사람이 소유자가 되어
        // 원래 쓰던 사람을 내보낼 수 있다. 가장 먼저 그 방을 쓴 사람을 소유자로 둔다.
        members = [...new Set([...contributors, me])];
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
      // checkAccess()가 그 방을 아무도 못 들어오는 상태로 영구히 잠가버린다 — 마지막 멤버는 제거 금지.
      // 지금 구조에서는 위의 cannot_remove_owner가 members[0]을 항상 지켜주므로 여기까지 오지
      // 않는다(변이 테스트로 확인: 이 줄을 지워도 깨지는 테스트가 없다). 소유자 규칙이 바뀌면
      // 바로 필요해지는 마지막 방어선이라 남겨 둔다.
      if (!updated.length) return res.status(400).json({ error: 'cannot_remove_last_member' });
      await kv.set(key, updated);
      return res.json({ members: updated });
    }

    return res.status(400).json({ error: 'unknown_action' });
  }

  res.status(405).end();
};
