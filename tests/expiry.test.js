'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { installMocks, freshHandler, mockReq, mockRes, stubGoogleAuth } = require('./helpers/mockBackend');

const api = name => path.join(__dirname, '..', 'api', `${name}.js`);
const kvKey = roomId => `fa:room:${roomId}`;

// 만료에 기대는 동작들은 가짜 KV가 TTL을 무시해서 그동안 전혀 검증되지 않았다.
// (한도를 5 -> 99999로 바꿔도, 초대 만료 검사를 지워도 전체가 초록이었다)

test('the contact form rate limit blocks the 6th message, then lets it through after the window', async () => {
  const { kv } = installMocks();
  const send = () => {
    const res = mockRes();
    return freshHandler(api('contact'))(mockReq({
      headers: { 'x-forwarded-for': '1.2.3.4' },
      body: { name: '홍길동', email: 'a@x.com', message: '문의 내용입니다' },
    }), res).then(() => res);
  };
  for (let i = 0; i < 5; i++) {
    const r = await send();
    assert.notEqual(r.statusCode, 429, `${i + 1}번째는 통과해야 한다`);
  }
  const blocked = await send();
  assert.equal(blocked.statusCode, 429, '6번째는 막혀야 한다');

  kv.advance(61_000);                 // 1분 창이 지나면
  const after = await send();
  assert.notEqual(after.statusCode, 429, '창이 지나면 다시 보낼 수 있어야 한다');
});

test('an invite link stops working after it expires', async () => {
  const { kv } = installMocks();
  const restore = stubGoogleAuth({ 'own': 'owner@x.com', 'guest': 'friend@x.com' });
  try {
    await kv.set(kvKey('board'), { strokes: [], notes: [], images: [], shapes: [], createdBy: 'owner@x.com' });
    const inv = mockRes();
    await freshHandler(api('team'))(mockReq({ headers: { authorization: 'Bearer own' },
      body: { action: 'invite', roomId: 'board', email: 'owner@x.com' } }), inv);
    const token = inv.body.token;
    assert.ok(token);

    kv.advance(8 * 24 * 3600 * 1000);   // 유효기간(7일)을 넘긴다

    const late = mockRes();
    await freshHandler(api('team'))(mockReq({ headers: { authorization: 'Bearer guest' },
      body: { action: 'redeem', token, email: 'friend@x.com' } }), late);
    assert.notEqual(late.statusCode, 200, '만료된 초대 링크로는 들어올 수 없어야 한다');
    const members = await kv.get(`${kvKey('board')}:members`);
    assert.ok(!members.includes('friend@x.com'));
  } finally { restore(); }
});

test('a valid invite link adds the member before it expires', async () => {
  const { kv } = installMocks();
  const restore = stubGoogleAuth({ 'own': 'owner@x.com', 'guest': 'friend@x.com' });
  try {
    await kv.set(kvKey('board'), { strokes: [], notes: [], images: [], shapes: [], createdBy: 'owner@x.com' });
    const inv = mockRes();
    await freshHandler(api('team'))(mockReq({ headers: { authorization: 'Bearer own' },
      body: { action: 'invite', roomId: 'board', email: 'owner@x.com' } }), inv);

    kv.advance(6 * 24 * 3600 * 1000);   // 아직 유효한 시점
    const ok = mockRes();
    await freshHandler(api('team'))(mockReq({ headers: { authorization: 'Bearer guest' },
      body: { action: 'redeem', token: inv.body.token, email: 'friend@x.com' } }), ok);
    assert.equal(ok.statusCode, 200);
    assert.ok((await kv.get(`${kvKey('board')}:members`)).includes('friend@x.com'));
  } finally { restore(); }
});

// 게스트 방의 24시간 만료는 "TTL을 걸었는지"가 아니라 "정말 사라지는지"로 확인한다
test('a guest room actually disappears after 24h of inactivity', async () => {
  const { kv } = installMocks();
  await freshHandler(api('action'))(mockReq({ body: { roomId: 'g1', userId: 'g', isGuest: true,
    action: { type: 'note_add', note: { id: 'n1' } } } }), mockRes());
  assert.ok(await kv.get(kvKey('g1')));

  kv.advance(23 * 3600 * 1000);
  assert.ok(await kv.get(kvKey('g1')), '23시간 뒤에는 남아 있어야 한다');

  kv.advance(2 * 3600 * 1000);
  assert.equal(await kv.get(kvKey('g1')), null, '24시간이 지나면 사라져야 한다');
});

// 룸 락의 TTL은 "핸들러가 죽어도 방이 영구히 잠기지 않게" 하는 안전장치다
test('a leaked room lock expires so the room does not stay blocked forever', async () => {
  const { kv } = installMocks();
  await kv.set(kvKey('r1'), { strokes: [], notes: [], images: [], shapes: [] });
  const { acquireRoomLock } = freshHandler(path.join(__dirname, '..', 'lib', 'auth.js'));
  const leaked = await acquireRoomLock(kv, kvKey('r1'));   // 잡고 풀지 않는다
  assert.ok(leaked);

  const blocked = mockRes();
  await freshHandler(api('action'))(mockReq({ body: { roomId: 'r1', userId: 'u1',
    action: { type: 'note_add', note: { id: 'a' } } } }), blocked);
  assert.equal(blocked.statusCode, 503, '락이 살아 있는 동안은 거절');

  kv.advance(11_000);   // TTL 10초가 지나면 저절로 풀린다
  const ok = mockRes();
  await freshHandler(api('action'))(mockReq({ body: { roomId: 'r1', userId: 'u1',
    action: { type: 'note_add', note: { id: 'b' } } } }), ok);
  assert.equal(ok.statusCode, 200, 'TTL이 지나면 다시 쓸 수 있어야 한다');
});
