'use strict';
const crypto = require('crypto');
// api/*.js가 공통으로 쓰는 인증·검증 함수. (예전엔 파일마다 같은 코드가 복사돼 있었다)

// app.html의 GOOGLE_CLIENT_ID와 같아야 한다. 다른 OAuth 클라이언트로 배포하면 환경변수로 덮어쓴다.
const GOOGLE_CLIENT_IDS = (process.env.GOOGLE_CLIENT_ID || '752878488042-6mc8ggqljhfclng11gsm2ffku8l4uc9k.apps.googleusercontent.com')
  .split(',').map(s => s.trim()).filter(Boolean);

// 방 이름 한도. api/rename-room.js·team.js·projects.js도 같은 값을 써야 한다 — 예전엔 여기만
// 64였어서, 33~64자 방은 만들 수는 있는데 이름 변경·비공개 전환이 영구히 400으로 거절됐다.
const MAX_ROOMID = 32;

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

// 룸 단위 락: 동시 요청이 같은 룸 상태를 읽고-수정하고-쓰는 과정에서 서로를 덮어써
// 스트로크·포스트잇 등이 유실되는 것을 막는다. 확보하지 못하면 null — 예전엔 락 없이 그대로
// 진행해서 동시 요청끼리 서로의 변경을 조용히 덮어썼다. 이제는 503을 돌려 클라이언트가
// 서버 상태로 다시 맞추게 한다.
//
// api/action.js와 api/rename-room.js가 같은 키를 쓴다. 예전엔 이름 변경이 이 락을 무시해서,
// 변경 중에 들어온 액션이 이미 삭제된 옛 키에 상태를 되살려 써 넣고(방이 두 이름으로 갈라짐)
// 그 사이에 그린 내용이 유실됐다.
//
// TTL은 핸들러가 죽어도 방이 영구히 잠기지 않게 하는 안전장치다. 보호 대상 작업(최대 2MB KV
// 쓰기 + 순차 Pusher 전송 수십 회)이 5초를 넘길 수 있어, 그 사이 락이 만료돼 두 요청이
// 겹치면 락이 막으려던 유실이 그대로 발생한다 — Vercel 함수 타임아웃에 맞춰 10초로 둔다.
const LOCK_TTL_SECONDS = 10;
const LOCK_TRIES = 30;

async function acquireRoomLock(kv, kvKey) {
  const key = `${kvKey}:lock`;
  const token = Date.now().toString(36) + Math.random().toString(36).slice(2);
  for (let i = 0; i < LOCK_TRIES; i++) {
    const ok = await kv.set(key, token, { nx: true, ex: LOCK_TTL_SECONDS });
    if (ok) return { key, token };
    await new Promise(r => setTimeout(r, 40 + Math.random() * 60));
  }
  return null;
}

// 내가 건 락일 때만 푼다 — 처리 시간이 TTL을 넘긴 사이 다른 요청이 새로 건 락을
// 지워버리지 않게 한다.
async function releaseRoomLock(kv, lock) {
  if (!lock) return;
  try { if ((await kv.get(lock.key)) === lock.token) await kv.del(lock.key); } catch { /* ignore */ }
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

module.exports = { isAdmin, MAX_ROOMID, isValidRoomId, bearerToken, verifyToken, verifyEmail, getMembers, checkAccess, acquireRoomLock, releaseRoomLock };
