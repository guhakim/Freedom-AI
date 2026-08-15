'use strict';

async function getKv() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  try { return require('@vercel/kv').kv; } catch { return null; }
}

const INVITE_TTL = 7 * 24 * 3600; // 초대 링크 유효기간: 7일
const MAX_ROOMID = 32;

// 토큰→이메일 검증 결과를 짧게 캐싱 — 공유 모달이 초대 발급 직후 목록을 바로 다시 조회하는 등
// 같은 요청 흐름에서 verifyOwner가 연달아 호출되는 경우가 많아, 매번 Google API를 왕복하지 않게 한다
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

// Authorization: Bearer <google access token> 이 실제로 email의 소유자인지 검증
async function verifyOwner(req, email) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return false;
  const verifiedEmail = await verifyToken(token);
  return !!verifiedEmail && verifiedEmail === email.toLowerCase();
}

function genToken() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

function normalize(list) {
  return (list || []).map(m => String(m).toLowerCase());
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
    if (!roomId || typeof roomId !== 'string') return res.status(400).json({ error: 'roomId required' });

    const members = await kv.get(`fa:room:${roomId}:members`);
    if (!members) return res.json({ isPrivate: false, members: [] });

    const email = req.query?.email;
    if (!email || !(await verifyOwner(req, email))) return res.status(401).json({ error: 'unauthorized' });
    if (!normalize(members).includes(email.toLowerCase())) return res.status(403).json({ error: 'not_a_member' });
    return res.json({ isPrivate: true, members });
  }

  if (req.method === 'POST') {
    const { action, roomId, email } = req.body || {};

    // 방을 비공개로 전환(최초 1회) + 초대 링크 발급. 이미 비공개인 방이면 기존 멤버만 초대 링크를 새로 만들 수 있음
    if (action === 'invite') {
      if (!roomId || typeof roomId !== 'string' || roomId.length > MAX_ROOMID) return res.status(400).json({ error: 'roomId required' });
      if (!email || !(await verifyOwner(req, email))) return res.status(401).json({ error: 'unauthorized' });

      const key = `fa:room:${roomId}:members`;
      let members = await kv.get(key);
      if (!members) {
        members = [email.toLowerCase()];
        await kv.set(key, members);
      } else if (!normalize(members).includes(email.toLowerCase())) {
        return res.status(403).json({ error: 'not_a_member' });
      }

      const inviteToken = genToken();
      await kv.set(`fa:invite:${inviteToken}`, { roomId }, { ex: INVITE_TTL });
      return res.json({ token: inviteToken });
    }

    // 초대 링크 사용 — 로그인한 이메일을 해당 방 멤버로 추가
    if (action === 'redeem') {
      const { token } = req.body || {};
      if (!token || typeof token !== 'string') return res.status(400).json({ error: 'token required' });
      if (!email || !(await verifyOwner(req, email))) return res.status(401).json({ error: 'unauthorized' });

      const invite = await kv.get(`fa:invite:${token}`);
      if (!invite?.roomId) return res.status(404).json({ error: 'invalid_or_expired_invite' });

      const key = `fa:room:${invite.roomId}:members`;
      const members = normalize(await kv.get(key));
      const lower = email.toLowerCase();
      if (!members.includes(lower)) {
        members.push(lower);
        await kv.set(key, members);
      }
      return res.json({ roomId: invite.roomId });
    }

    // 멤버 제거 — 요청자도 그 방의 멤버여야 함
    if (action === 'remove') {
      const { removeEmail } = req.body || {};
      if (!roomId || typeof roomId !== 'string') return res.status(400).json({ error: 'roomId required' });
      if (!removeEmail || typeof removeEmail !== 'string') return res.status(400).json({ error: 'removeEmail required' });
      if (!email || !(await verifyOwner(req, email))) return res.status(401).json({ error: 'unauthorized' });

      const key = `fa:room:${roomId}:members`;
      const members = normalize(await kv.get(key));
      if (!members.includes(email.toLowerCase())) return res.status(403).json({ error: 'not_a_member' });

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
