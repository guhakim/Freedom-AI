'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { installMocks, freshHandler, mockReq, mockRes, stubGoogleAuth } = require('./helpers/mockBackend');

const api = path.join(__dirname, '..', 'api', 'projects.js');
const key = email => `fa:user:projects:${email}`;

// 사이드바 프로젝트 목록은 이메일만 알면 읽고 쓸 수 있으면 안 된다.
// (이 파일이 생기기 전에는 인증 두 줄을 지워도 전체 테스트가 초록이었다)
test('reading someone else\'s project list requires a token that proves the email', async () => {
  const { kv } = installMocks();
  const restore = stubGoogleAuth({ 'mine': 'me@x.com' });
  try {
    await kv.set(key('victim@x.com'), ['비밀 프로젝트']);

    const noTok = mockRes();
    await freshHandler(api)(mockReq({ method: 'GET', query: { email: 'victim@x.com' } }), noTok);
    assert.equal(noTok.statusCode, 401);

    const otherTok = mockRes();
    await freshHandler(api)(mockReq({ method: 'GET', headers: { authorization: 'Bearer mine' },
      query: { email: 'victim@x.com' } }), otherTok);
    assert.equal(otherTok.statusCode, 401, '남의 이메일로는 조회할 수 없어야 한다');
  } finally { restore(); }
});

test('overwriting someone else\'s project list is rejected', async () => {
  const { kv } = installMocks();
  const restore = stubGoogleAuth({ 'mine': 'me@x.com' });
  try {
    await kv.set(key('victim@x.com'), ['원래 목록']);
    const res = mockRes();
    await freshHandler(api)(mockReq({ headers: { authorization: 'Bearer mine' },
      body: { email: 'victim@x.com', projects: ['덮어쓰기'] } }), res);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(await kv.get(key('victim@x.com')), ['원래 목록']);
  } finally { restore(); }
});

// 회귀 테스트: 읽기 실패를 삼키고 빈 목록을 200으로 돌려주면, 사이드바가 비어 보이고
// 거기서 하나라도 추가하는 순간 그 한 개가 원래 목록을 통째로 덮어쓴다.
test('a failed read returns 500 instead of an empty list', async () => {
  const { kv } = installMocks();
  const restore = stubGoogleAuth({ 'tok': 'me@x.com' });
  try {
    await kv.set(key('me@x.com'), ['A', 'B']);
    const realGet = kv.get.bind(kv);
    kv.get = async k => { if (k === key('me@x.com')) throw new Error('kv down'); return realGet(k); };

    const res = mockRes();
    await freshHandler(api)(mockReq({ method: 'GET', headers: { authorization: 'Bearer tok' },
      query: { email: 'me@x.com' } }), res);
    kv.get = realGet;
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.projects, undefined);
    assert.deepEqual(await kv.get(key('me@x.com')), ['A', 'B'], '읽기 실패가 목록을 건드리면 안 된다');
  } finally { restore(); }
});

// 이메일 대소문자가 달라도 같은 목록을 봐야 한다 (KV 키는 바이트 단위로 구분된다)
test('the list is keyed case-insensitively, with a fallback to the legacy raw-email key', async () => {
  const { kv } = installMocks();
  const restore = stubGoogleAuth({ 'tok': 'me@x.com' });
  try {
    // 소문자 키로 바꾸기 전에 저장된 목록
    await kv.set('fa:user:projects:Me@X.com', ['예전 목록']);
    const get = mockRes();
    await freshHandler(api)(mockReq({ method: 'GET', headers: { authorization: 'Bearer tok' },
      query: { email: 'Me@X.com' } }), get);
    assert.deepEqual(get.body.projects, ['예전 목록'], '레거시 키도 읽어야 한다');

    const post = mockRes();
    await freshHandler(api)(mockReq({ headers: { authorization: 'Bearer tok' },
      body: { email: 'Me@X.com', projects: ['새 목록'] } }), post);
    assert.deepEqual(await kv.get(key('me@x.com')), ['새 목록'], '쓰기는 소문자 키로');
  } finally { restore(); }
});

// 목록 상한과 이름 길이 — 서버가 조용히 잘라내면 사용자는 사라진 이유를 알 수 없다
test('the list is capped at 30 entries and names at the shared room-name limit', async () => {
  const { kv } = installMocks();
  const restore = stubGoogleAuth({ 'tok': 'me@x.com' });
  try {
    const many = Array.from({ length: 40 }, (_, i) => `p${i}`);
    const res = mockRes();
    await freshHandler(api)(mockReq({ headers: { authorization: 'Bearer tok' },
      body: { email: 'me@x.com', projects: [...many, '너무'.repeat(40)] } }), res);
    assert.equal(res.body.projects.length, 30);
    assert.ok(!res.body.projects.some(p => p.length > 32), '방 이름 한도를 넘는 이름은 걸러야 한다');
  } finally { restore(); }
});

// 입력 검증 — 빠지면 이메일 없이 호출해 다른 사람 칸을 건드리거나, 배열이 아닌 값으로
// 목록을 망가뜨릴 수 있다
test('malformed requests are rejected before touching storage', async () => {
  const { kv } = installMocks();
  const restore = stubGoogleAuth({ 'tok': 'me@x.com' });
  try {
    await kv.set(key('me@x.com'), ['지켜져야 함']);
    const bad = [
      [{ method: 'GET', query: {} }, 'GET에 이메일 없음'],
      [{ body: { projects: ['a'] } }, 'POST에 이메일 없음'],
      [{ headers: { authorization: 'Bearer tok' }, body: { email: 'me@x.com', projects: 'not-an-array' } }, '배열이 아닌 목록'],
      [{ headers: { authorization: 'Bearer tok' }, body: { email: 'me@x.com' } }, '목록 누락'],
    ];
    for (const [req, label] of bad) {
      const res = mockRes();
      await freshHandler(api)(mockReq(req), res);
      assert.equal(res.statusCode, 400, `${label}: 400으로 거절해야 한다`);
    }
    assert.deepEqual(await kv.get(key('me@x.com')), ['지켜져야 함'], '거절된 요청이 저장소를 건드리면 안 된다');
  } finally { restore(); }
});
