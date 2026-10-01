'use strict';
const crypto = require('crypto');
// api/*.js가 공통으로 쓰는 인증·검증 함수. (예전엔 파일마다 같은 코드가 복사돼 있었다)

// app.html의 GOOGLE_CLIENT_ID와 같아야 한다. 다른 OAuth 클라이언트로 배포하면 환경변수로 덮어쓴다.
const GOOGLE_CLIENT_IDS = (process.env.GOOGLE_CLIENT_ID || '752878488042-6mc8ggqljhfclng11gsm2ffku8l4uc9k.apps.googleusercontent.com')
  .split(',').map(s => s.trim()).filter(Boolean);

const MAX_ROOMID = 64;

// roomId는 KV 키(`fa:room:${roomId}`)에 그대로 들어간다. "victim:members"·"victim:lock" 같은
// 이름을 허용하면 다른 방의 멤버 목록 키·락 키를 읽고 쓰고 지울 수 있었다 — 방에 딸린 보조 키
// 접미사로 끝나는 이름은 반드시 막는다. (':' 자체는 기존 방 이름에 쓰였을 수 있어 허용)
const RESERVED_SUFFIX = /:(members|lock)$/i;
function isValidRoomId(roomId) {
  return typeof roomId === 'string' && roomId.length > 0 && roomId.length <= MAX_ROOMID
    && !RESERVED_SUFFIX.test(roomId) && !/[\u0000-\u001f]/.test(roomId);
}

function bearerToken(req) {
  const auth = req.headers?.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

// 토큰→이메일 검증 결과를 짧게 캐싱 — 서버리스 인스턴스가 재사용되는 동안은 반복 호출마다
// Google API를 왕복하지 않아도 되게 한다 (완벽한 보장은 아님)
const verifyCache = new Map(); // token -> { email, exp }
const VERIFY_CACHE_TTL = 5 * 60 * 1000;
const VERIFY_CACHE_MAX = 1000;

// userinfo 엔드포인트는 "아무 앱"이 발급받은 토큰도 받아준다 — 사용자가 로그인한 적 있는
// 다른 서비스가 그 토큰으로 이 앱의 비공개 방에 들어올 수 있었다. tokeninfo로 이 앱의
// 클라이언트 ID로 발급된 토큰인지(aud/azp)까지 확인한다.
async function verifyToken(token) {
  if (typeof token !== 'string' || !token) return null;
  const cached = verifyCache.get(token);
  if (cached && cached.exp > Date.now()) return cached.email;
  try {
    const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`);
    if (!r.ok) return null;
    const info = await r.json();
    if (!GOOGLE_CLIENT_IDS.includes(info.aud) && !GOOGLE_CLIENT_IDS.includes(info.azp)) return null;
    if (typeof info.email !== 'string') return null;
    const email = info.email.toLowerCase();
    if (verifyCache.size >= VERIFY_CACHE_MAX) verifyCache.clear();
    verifyCache.set(token, { email, exp: Date.now() + VERIFY_CACHE_TTL });
    return email;
  } catch { return null; }
}

// Authorization 헤더의 토큰이 실제로 email의 주인인지
async function verifyEmail(req, email) {
  if (typeof email !== 'string' || !email) return false;
  const verified = await verifyToken(bearerToken(req));
  return !!verified && verified === email.toLowerCase();
}

// 비공개 방의 멤버 목록. 비공개가 아니면(또는 값이 배열이 아닌 깨진 상태면) null.
async function getMembers(kv, roomId) {
  if (!kv) return null;
  const members = await kv.get(`fa:room:${roomId}:members`);
  return Array.isArray(members) && members.length ? members.map(m => String(m).toLowerCase()) : null;
}

// 방이 비공개로 전환된 경우(팀 초대를 한 번이라도 발급한 방) 멤버인지 검증.
// 아직 비공개 전환 안 된(오픈) 방은 누구나 접근 가능.
async function checkAccess(kv, req, roomId, email) {
  const members = await getMembers(kv, roomId);
  if (!members) return true;
  if (!(await verifyEmail(req, email))) return false;
  return members.includes(email.toLowerCase());
}

// 관리자 키 확인. 쿼리스트링(?key=)으로 받으면 Vercel 요청 로그·브라우저 기록에 키가 남아서
// 헤더(X-Admin-Key)로만 받고, 길이·내용에 따라 응답 시간이 달라지지 않게 해시끼리 비교한다.
function isAdmin(req) {
  const expected = process.env.ADMIN_STATS_KEY;
  const given = req.headers?.['x-admin-key'];
  if (!expected || typeof given !== 'string') return false;
  const h = v => crypto.createHash('sha256').update(v).digest();
  return crypto.timingSafeEqual(h(given), h(expected));
}

module.exports = { isAdmin, MAX_ROOMID, isValidRoomId, bearerToken, verifyToken, verifyEmail, getMembers, checkAccess };
