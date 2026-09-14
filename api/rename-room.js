'use strict';

const MAX_ROOMID = 32;

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

// 방이 비공개로 전환된 경우(팀 초대를 한 번이라도 발급한 방)는 멤버만 이름을 바꿀 수 있다.
// 아직 비공개 전환 안 된(레거시 오픈) 방은 지금까지처럼 누구나 가능.
async function checkAccess(kv, req, roomId, email) {
  const members = await kv.get(`fa:room:${roomId}:members`);
  if (!members) return { ok: true, members: null };
  if (!email) return { ok: false };
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return { ok: false };
  const verifiedEmail = await verifyToken(token);
  if (!verifiedEmail || verifiedEmail !== email.toLowerCase()) return { ok: false };
  const isMember = members.map(m => String(m).toLowerCase()).includes(email.toLowerCase());
  return { ok: isMember, members };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { oldRoomId, newRoomId, email } = req.body || {};
  if (!oldRoomId || typeof oldRoomId !== 'string') return res.status(400).json({ error: 'oldRoomId required' });
  if (!newRoomId || typeof newRoomId !== 'string' || !newRoomId.trim() || newRoomId.length > MAX_ROOMID) {
    return res.status(400).json({ error: 'invalid_newRoomId' });
  }
  if (oldRoomId === newRoomId) return res.json({ ok: true });

  const kv = await getKv();
  if (!kv || !process.env.KV_REST_API_URL) {
    // KV 미설정 환경: 서버에 옮길 데이터가 없으므로(로컬 저장만 사용) 그대로 성공 처리
    return res.json({ ok: true, migrated: false });
  }

  try {
    const access = await checkAccess(kv, req, oldRoomId, email);
    if (!access.ok) return res.status(403).json({ error: 'access_denied' });

    // 이름이 겹치면 남의(또는 이전) 방 내용을 덮어쓸 수 있으므로 반드시 차단
    const [newState, newMembers] = await Promise.all([
      kv.get(`fa:room:${newRoomId}`),
      kv.get(`fa:room:${newRoomId}:members`),
    ]);
    if (newState || newMembers) return res.status(409).json({ error: 'name_taken' });

    const oldState = await kv.get(`fa:room:${oldRoomId}`);
    if (oldState) {
      await kv.set(`fa:room:${newRoomId}`, oldState);
      await kv.del(`fa:room:${oldRoomId}`);
    }
    if (access.members) {
      await kv.set(`fa:room:${newRoomId}:members`, access.members);
      await kv.del(`fa:room:${oldRoomId}:members`);
    }
    res.json({ ok: true, migrated: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
