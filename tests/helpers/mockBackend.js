'use strict';

// api/*.js는 최상단에서 require('@vercel/kv')와 require('pusher')를 호출한다.
// 테스트에서는 실제 Redis/Pusher 대신 이 가짜 구현을 대신 넣어준다.
// require.cache를 미리 채워두면, 실제로 npm install이 안 돼 있어도(패키지
// 자체는 require.resolve가 성공해야 하므로 최소 1회는 설치돼 있어야 함)
// api/*.js가 그 안의 require() 호출에서 이 가짜 구현을 받아가게 된다.

// 진짜 @vercel/kv는 값을 JSON으로 직렬화해 Redis에 넣고, get할 때마다 새로 파싱한
// 객체를 돌려준다 — 저장소 안의 객체와 핸들러가 들고 있는 객체는 별개다. 가짜 구현이
// 참조를 그대로 내주면 핸들러가 state를 제자리에서 변형하는 순간(action.js의
// `let state = existingState`) 저장소 값도 같이 바뀌어서, kvSet()을 아예 호출하지
// 않아도 "KV에 저장됐다"는 검증이 통과해 버린다. 그러면 운영에서 데이터 유실이 되는
// 저장 누락 버그를 테스트가 전혀 잡지 못한다. 넣을 때와 꺼낼 때 모두 복제해 끊어준다.
function clone(v) {
  return (v === null || typeof v !== 'object') ? v : structuredClone(v);
}

function makeFakeKv() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.has(k) ? clone(store.get(k)) : null; },
    // action.js의 acquireRoomLock()은 진짜 Redis의 SET NX EX 원자적 동작에 기대어
    // 락을 건다. nx를 그냥 무시하면 항상 "이미 있음"으로 취급돼(store.set 자체는
    // 실패하지 않으므로) 매번 20회 재시도 백오프를 다 태워 테스트가 초 단위로
    // 느려진다 — nx를 제대로 흉내내야 락이 1회에 바로 잡혀서 테스트가 빨라진다.
    async set(k, v, opts) {
      if (opts?.nx && store.has(k)) return null;
      store.set(k, clone(v));
      return opts?.nx ? 'OK' : undefined;
    },
    async del(k) { store.delete(k); },
    async incr(k) { const v = (store.get(k) || 0) + 1; store.set(k, v); return v; },
    async expire() { /* 테스트에서는 TTL을 신경 쓰지 않는다 */ },
    async sadd(k, v) { const s = store.get(k) || new Set(); s.add(v); store.set(k, s); },
    async scard(k) { const s = store.get(k); return s ? s.size : 0; },
    async smembers(k) { const s = store.get(k); return s ? [...s] : []; },
    async lpush(k, v) { const l = store.get(k) || []; l.unshift(v); store.set(k, l); },
    async ltrim(k, start, end) { const l = store.get(k) || []; store.set(k, l.slice(start, end + 1)); },
    async lrange(k, start, end) { const l = store.get(k) || []; return l.slice(start, end === -1 ? undefined : end + 1); },
  };
}

function makeFakePusherClass(triggers) {
  return class FakePusher {
    constructor(opts) { this.opts = opts; }
    async trigger(channel, event, data, excl) { triggers.push({ channel, event, data, excl }); }
    authorizeChannel(socketId, channelName, presence) {
      return { auth: 'fake-auth:signature', channel_data: presence ? JSON.stringify(presence) : undefined };
    }
  };
}

// 테스트별로 새 인메모리 kv/pusher를 만들어 require.cache에 꽂아넣는다.
// 반환된 kv.store로 시드 데이터를 넣거나 결과를 직접 들여다볼 수 있고,
// triggers 배열로 어떤 Pusher 이벤트가 나갔는지 확인할 수 있다.
function installMocks() {
  const kv = makeFakeKv();
  const triggers = [];

  const kvPath = require.resolve('@vercel/kv');
  require.cache[kvPath] = { id: kvPath, filename: kvPath, loaded: true, exports: { kv } };

  const pusherPath = require.resolve('pusher');
  require.cache[pusherPath] = { id: pusherPath, filename: pusherPath, loaded: true, exports: makeFakePusherClass(triggers) };

  process.env.KV_REST_API_URL = 'http://fake-kv.test';
  process.env.KV_REST_API_TOKEN = 'fake-token';
  process.env.PUSHER_APP_ID = 'fake';
  process.env.PUSHER_KEY = 'fake';
  process.env.PUSHER_SECRET = 'fake';
  process.env.PUSHER_CLUSTER = 'fake';

  return { kv, triggers };
}

// 핸들러 모듈은 캐시돼 있으면 이전 테스트의 require.cache 조작 이전 상태를 들고
// 있을 수 있으니, 매 테스트마다 새로 require해서 지금 설치된 mock을 확실히 쓰게 한다.
function freshHandler(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  // lib/auth.js도 같이 버린다. 안 그러면 모듈 수준의 verifyCache(토큰→이메일, 5분)가 한
  // 파일의 모든 테스트에 공유돼, 앞선 테스트가 캐싱해 둔 매핑이 뒤 테스트의 결과를 바꾼다
  // — 같은 토큰 문자열을 다른 이메일로 쓰면 조용히 틀린 결과가 나와 디버깅이 어렵다.
  delete require.cache[require.resolve('../../lib/auth')];
  return require(modulePath);
}

function mockReq(overrides = {}) {
  return { method: 'POST', headers: {}, query: {}, body: {}, ...overrides };
}

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

// verifyToken()은 실제 Google tokeninfo API를 호출한다. 비공개 방 테스트에서
// 네트워크 없이 특정 토큰 -> 이메일 매핑만 검증하도록 global.fetch를 바꿔치기한다.
function stubGoogleAuth(tokenToEmail) {
  const original = global.fetch;
  global.fetch = async (url, opts) => {
    if (typeof url === 'string' && url.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
      const token = new URL(url).searchParams.get('access_token');
      const email = token && tokenToEmail[token];
      if (!email) return { ok: false };
      return { ok: true, json: async () => ({ email, aud: '752878488042-6mc8ggqljhfclng11gsm2ffku8l4uc9k.apps.googleusercontent.com' }) };
    }
    return original(url, opts);
  };
  return () => { global.fetch = original; };
}

// 외부 API(예: Hugging Face 추론 엔드포인트) 호출을 흉내낸다.
// responder(url, opts) => 원하는 fetch Response 모양의 객체를 반환하면 된다.
function stubFetch(responder) {
  const original = global.fetch;
  global.fetch = async (url, opts) => responder(url, opts, original);
  return () => { global.fetch = original; };
}

module.exports = { installMocks, freshHandler, mockReq, mockRes, stubGoogleAuth, stubFetch };
