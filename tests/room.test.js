'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { installMocks, freshHandler, mockReq, mockRes } = require('./helpers/mockBackend');

const ROOM = path.join(__dirname, '..', 'api', 'room.js');

// 회귀 테스트: room.js가 Access-Control-Allow-Methods/Headers를 설정하지 않고 OPTIONS도
// 처리하지 않던 시절엔, app.html이 Authorization 헤더를 실어 보내는 GET /api/room 요청이
// 브라우저의 CORS preflight(OPTIONS) 단계에서 막혀버릴 수 있었다 — 다른 모든 엔드포인트는
// 이미 이 세 가지를 갖추고 있었는데 room.js만 빠져 있었다.
test('OPTIONS preflight is handled with full CORS headers, matching every other endpoint', async () => {
  installMocks();
  const handler = freshHandler(ROOM);
  const res = mockRes();

  await handler(mockReq({ method: 'OPTIONS' }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
  assert.equal(res.headers['Access-Control-Allow-Methods'], 'GET, OPTIONS');
  assert.equal(res.headers['Access-Control-Allow-Headers'], 'Content-Type, Authorization');
});

test('a normal GET still returns room state as before', async () => {
  const { kv } = installMocks();
  await kv.set('fa:room:r1', { strokes: [{ id: 's1' }], notes: [], images: [], shapes: [] });
  const handler = freshHandler(ROOM);
  const res = mockRes();

  await handler(mockReq({ method: 'GET', query: { roomId: 'r1' } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.strokes.length, 1);
});

test('non-GET, non-OPTIONS methods are still rejected', async () => {
  installMocks();
  const handler = freshHandler(ROOM);
  const res = mockRes();

  await handler(mockReq({ method: 'POST', query: { roomId: 'r1' } }), res);

  assert.equal(res.statusCode, 405);
});
