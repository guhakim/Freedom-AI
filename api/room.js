'use strict';

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
// 아직 비공개 전환 안 된(레거시 오픈) 방은 지금까지처럼 누구나 조회 가능.
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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).end();
  const roomId = req.query?.roomId;
  const email  = req.query?.email;
  if (!roomId || typeof roomId !== 'string') return res.status(400).json({ error: 'roomId required' });

  try {
    const kv = await getKv();
    if (!(await checkAccess(kv, req, roomId, email))) return res.status(403).json({ error: 'access_denied' });
    const state = (kv && process.env.KV_REST_API_URL)
      ? await kv.get(`fa:room:${roomId}`)
      : null;
    res.json(state || { strokes: [], notes: [], images: [], shapes: [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
