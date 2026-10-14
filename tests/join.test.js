'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { installMocks, freshHandler, mockReq, mockRes, stubGoogleAuth } = require('./helpers/mockBackend');

const JOIN = path.join(__dirname, '..', 'api', 'join.js');

// 회귀 테스트: join.js가 매번 새 랜덤 userId를 발급하면, 새로고침할 때마다 사용자
// 정체성이 바뀌어서 "본인 것만 삭제/이동" 류의 체크가 다시는 통과하지 못하게 된다.
// 클라이언트가 보낸 고정 clientId를 그대로 돌려줘야 한다.
test('a valid client-supplied clientId is echoed back as userId', async () => {
  installMocks();
  const handler = freshHandler(JOIN);
  const res = mockRes();

  await handler(mockReq({ body: { roomId: 'r1', clientId: 'abc12345' } }), res);

  assert.equal(res.body.userId, 'abc12345');
});

test('an invalid clientId (bad characters) falls back to a random id instead of being echoed', async () => {
  installMocks();
  const handler = freshHandler(JOIN);
  const res = mockRes();

  await handler(mockReq({ body: { roomId: 'r1', clientId: '../etc/passwd' } }), res);

  assert.notEqual(res.body.userId, '../etc/passwd');
  assert.equal(typeof res.body.userId, 'string');
  assert.ok(res.body.userId.length > 0);
});

test('missing clientId still returns a usable userId (backward compatible)', async () => {
  installMocks();
  const handler = freshHandler(JOIN);
  const res = mockRes();

  await handler(mockReq({ body: { roomId: 'r1' } }), res);

  assert.equal(typeof res.body.userId, 'string');
  assert.ok(res.body.userId.length > 0);
});

test('missing roomId is rejected', async () => {
  installMocks();
  const handler = freshHandler(JOIN);
  const res = mockRes();

  await handler(mockReq({ body: {} }), res);

  assert.equal(res.statusCode, 400);
});

// 회귀 테스트: todos 기능이 생기기 전에 만들어진 방은 저장된 state에 todos 키가
// 아예 없다. join.js가 kv에서 읽어온 기존 state로 기본값을 통째로 덮어쓰기 때문에,
// 이 백필이 없으면 프론트엔드가 state.todos를 객체로 가정하고 바로 써버려서 깨진다.
test('joining a pre-existing (legacy) room without a todos key backfills todos:{}', async () => {
  const { kv } = installMocks();
  await kv.set('fa:room:legacy1', { strokes: [], notes: [], images: [], shapes: [] }); // todos 없음
  const handler = freshHandler(JOIN);
  const res = mockRes();

  await handler(mockReq({ body: { roomId: 'legacy1', clientId: 'abc12345' } }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.state.todos, {});
});

test('joining a private room without a verified member email is denied', async () => {
  const { kv } = installMocks();
  await kv.set('fa:room:priv1:members', ['owner@x.com']);
  const restore = stubGoogleAuth({ 'good-token': 'owner@x.com' });
  const handler = freshHandler(JOIN);

  try {
    let res = mockRes();
    await handler(mockReq({ body: { roomId: 'priv1', clientId: 'abc12345' } }), res); // 이메일 없음
    assert.equal(res.statusCode, 403);

    res = mockRes();
    await handler(mockReq({
      headers: { authorization: 'Bearer good-token' },
      body: { roomId: 'priv1', clientId: 'abc12345', email: 'owner@x.com' },
    }), res);
    assert.equal(res.statusCode, 200);
  } finally {
    restore();
  }
});
