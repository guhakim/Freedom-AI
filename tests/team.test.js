'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { installMocks, freshHandler, mockReq, mockRes, stubGoogleAuth } = require('./helpers/mockBackend');

const api = path.join(__dirname, '..', 'api', 'team.js');
const kvKey = roomId => `fa:room:${roomId}`;

// 모든 팀 기능은 "그 이메일의 주인임을 토큰으로 증명"해야 한다. 증명 없이 통과하면
// 이메일만 알면 남의 방을 비공개로 잠그고, 초대를 받고, 멤버를 내보낼 수 있다.
// (이 파일이 생기기 전에는 verifyOwner 네 군데를 모두 지워도 전체가 초록이었다)
test('every team action rejects a request that cannot prove the email', async () => {
  const { kv } = installMocks();
  const restore = stubGoogleAuth({ 'real': 'owner@x.com' });
  try {
    await kv.set(kvKey('board'), { strokes: [], notes: [], images: [], shapes: [], createdBy: 'owner@x.com' });
    await kv.set(`${kvKey('board')}:members`, ['owner@x.com', 'mate@x.com']);

    const cases = [
      ['invite', { action: 'invite', roomId: 'board', email: 'owner@x.com' }],
      ['redeem', { action: 'redeem', token: 'whatever', email: 'owner@x.com' }],
      ['remove', { action: 'remove', roomId: 'board', email: 'owner@x.com', removeEmail: 'mate@x.com' }],
    ];
    for (const [label, body] of cases) {
      const noTok = mockRes();
      await freshHandler(api)(mockReq({ body }), noTok);
      assert.equal(noTok.statusCode, 401, `${label}: 토큰 없이 통과하면 안 된다`);

      const badTok = mockRes();
      await freshHandler(api)(mockReq({ headers: { authorization: 'Bearer forged' }, body }), badTok);
      assert.equal(badTok.statusCode, 401, `${label}: 가짜 토큰으로 통과하면 안 된다`);
    }
    // 멤버 목록 조회도 마찬가지
    const get = mockRes();
    await freshHandler(api)(mockReq({ method: 'GET', query: { roomId: 'board', email: 'owner@x.com' } }), get);
    assert.equal(get.statusCode, 401, '멤버 목록 조회도 증명이 필요하다');

    // 멤버는 그대로여야 한다
    assert.deepEqual(await kv.get(`${kvKey('board')}:members`), ['owner@x.com', 'mate@x.com']);
  } finally { restore(); }
});

test('a non-member cannot read the member list', async () => {
  const { kv } = installMocks();
  const restore = stubGoogleAuth({ 'out': 'outsider@x.com' });
  try {
    await kv.set(`${kvKey('board')}:members`, ['owner@x.com']);
    const res = mockRes();
    await freshHandler(api)(mockReq({ method: 'GET', headers: { authorization: 'Bearer out' },
      query: { roomId: 'board', email: 'outsider@x.com' } }), res);
    assert.equal(res.statusCode, 403, '멤버가 아니면 다른 멤버의 이메일을 볼 수 없어야 한다');
  } finally { restore(); }
});

// 내보내기 규칙 — 소유자만 남을 내보낼 수 있고, 소유자와 마지막 한 명은 못 내보낸다
test('member removal rules', async () => {
  const { kv } = installMocks();
  const restore = stubGoogleAuth({ 'own': 'owner@x.com', 'm1': 'a@x.com', 'out': 'nobody@x.com' });
  try {
    const seed = () => kv.set(`${kvKey('r')}:members`, ['owner@x.com', 'a@x.com', 'b@x.com']);
    await seed();
    const call = (tok, email, removeEmail) => {
      const res = mockRes();
      return freshHandler(api)(mockReq({ headers: { authorization: `Bearer ${tok}` },
        body: { action: 'remove', roomId: 'r', email, removeEmail } }), res).then(() => res);
    };

    assert.equal((await call('out', 'nobody@x.com', 'a@x.com')).statusCode, 403, '멤버가 아니면 내보낼 수 없다');
    assert.equal((await call('m1', 'a@x.com', 'b@x.com')).statusCode, 403, '소유자가 아니면 남을 내보낼 수 없다');
    assert.equal((await call('m1', 'a@x.com', 'owner@x.com')).statusCode, 403, '소유자는 내보낼 수 없다');

    assert.equal((await call('m1', 'a@x.com', 'a@x.com')).statusCode, 200, '자기 자신은 나갈 수 있다');
    assert.deepEqual(await kv.get(`${kvKey('r')}:members`), ['owner@x.com', 'b@x.com']);

    // 멤버가 소유자 한 명뿐일 때 자기 자신을 빼려 해도 거절된다. 빈 목록([])이 저장되면
    // checkAccess가 그 방을 아무도 못 들어오는 상태로 영구히 잠그기 때문이다.
    // (소유자 보호 규칙이 먼저 걸려 403이다 — cannot_remove_last_member까지 가지 않는다)
    await kv.set(`${kvKey('r')}:members`, ['owner@x.com']);
    assert.equal((await call('own', 'owner@x.com', 'owner@x.com')).statusCode, 403);
    assert.deepEqual(await kv.get(`${kvKey('r')}:members`), ['owner@x.com'],
      '어떤 경로로도 멤버 목록이 비워지면 안 된다');
  } finally { restore(); }
});

test('a bogus or missing invite token is rejected', async () => {
  const { kv } = installMocks();
  const restore = stubGoogleAuth({ 'tok': 'friend@x.com' });
  try {
    for (const token of [undefined, '', 'does-not-exist', 'x'.repeat(200)]) {
      const res = mockRes();
      await freshHandler(api)(mockReq({ headers: { authorization: 'Bearer tok' },
        body: { action: 'redeem', token, email: 'friend@x.com' } }), res);
      assert.notEqual(res.statusCode, 200, `토큰 ${JSON.stringify(token)}으로 입장하면 안 된다`);
    }
  } finally { restore(); }
});

// 비공개가 풀린 방(멤버 목록이 비워진 방)의 옛 초대 링크로 방을 혼자 차지할 수 없어야 한다
test('an invite for a room that is no longer private cannot be used to seize it', async () => {
  const { kv } = installMocks();
  const restore = stubGoogleAuth({ 'own': 'owner@x.com', 'ev': 'evil@x.com' });
  try {
    await kv.set(kvKey('board'), { strokes: [], notes: [], images: [], shapes: [], createdBy: 'owner@x.com' });
    const inv = mockRes();
    await freshHandler(api)(mockReq({ headers: { authorization: 'Bearer own' },
      body: { action: 'invite', roomId: 'board', email: 'owner@x.com' } }), inv);
    // 방이 다시 공개로 돌아갔다고 가정 (멤버 목록 삭제)
    await kv.del(`${kvKey('board')}:members`);

    const res = mockRes();
    await freshHandler(api)(mockReq({ headers: { authorization: 'Bearer ev' },
      body: { action: 'redeem', token: inv.body.token, email: 'evil@x.com' } }), res);
    assert.notEqual(res.statusCode, 200, '옛 초대 링크로 빈 방의 유일 멤버가 되면 안 된다');
    assert.equal(await kv.get(`${kvKey('board')}:members`), null);
  } finally { restore(); }
});

// roomId 검증 — 빠지면 "다른방:members" 같은 이름으로 다른 방의 멤버 키를 직접 조작할 수 있다.
// (api/action.js·join.js·room.js·rename-room.js는 기존 테스트가 덮고 있었지만 team.js는 비어 있었다)
test('team actions reject room names that target another room\'s internal keys', async () => {
  const { kv } = installMocks();
  const restore = stubGoogleAuth({ 'tok': 'evil@x.com' });
  try {
    await kv.set(`${kvKey('victim')}:members`, ['owner@x.com']);
    const bad = ['victim:members', 'victim:lock', '방'.repeat(40)];
    for (const roomId of bad) {
      for (const body of [
        { action: 'invite', roomId, email: 'evil@x.com' },
        { action: 'remove', roomId, email: 'evil@x.com', removeEmail: 'owner@x.com' },
      ]) {
        const res = mockRes();
        await freshHandler(api)(mockReq({ headers: { authorization: 'Bearer tok' }, body }), res);
        assert.equal(res.statusCode, 400, `${body.action} / ${roomId} 는 거절돼야 한다`);
      }
      const get = mockRes();
      await freshHandler(api)(mockReq({ method: 'GET', headers: { authorization: 'Bearer tok' },
        query: { roomId, email: 'evil@x.com' } }), get);
      assert.equal(get.statusCode, 400, `GET / ${roomId} 는 거절돼야 한다`);
    }
    assert.deepEqual(await kv.get(`${kvKey('victim')}:members`), ['owner@x.com'], '피해 방은 그대로여야 한다');
  } finally { restore(); }
});

// 내보내기는 "멤버가 아님"과 "소유자가 아님"을 구분해야 한다 — 둘 다 403이라 상태 코드만
// 보면 멤버 검사가 통째로 빠져도 알 수 없다(실제로 그 가드를 지워도 테스트가 통과했다)
test('removal tells apart "not a member" from "not the owner"', async () => {
  const { kv } = installMocks();
  const restore = stubGoogleAuth({ 'out': 'nobody@x.com', 'm': 'a@x.com' });
  try {
    await kv.set(`${kvKey('r')}:members`, ['owner@x.com', 'a@x.com', 'b@x.com']);
    const call = (tok, email, removeEmail) => {
      const res = mockRes();
      return freshHandler(api)(mockReq({ headers: { authorization: `Bearer ${tok}` },
        body: { action: 'remove', roomId: 'r', email, removeEmail } }), res).then(() => res);
    };
    assert.equal((await call('out', 'nobody@x.com', 'a@x.com')).body.error, 'not_a_member');
    assert.equal((await call('m', 'a@x.com', 'b@x.com')).body.error, 'owner_only');
  } finally { restore(); }
});
