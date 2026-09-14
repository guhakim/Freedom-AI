'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { installMocks, freshHandler, mockReq, mockRes, stubGoogleAuth } = require('./helpers/mockBackend');

const RENAME = path.join(__dirname, '..', 'api', 'rename-room.js');
const kvKey = roomId => `fa:room:${roomId}`;

test('renames an open room and migrates its content', async () => {
  const { kv } = installMocks();
  await kv.set(kvKey('old1'), { strokes: [{ id: 's1' }] });
  const handler = freshHandler(RENAME);
  const res = mockRes();

  await handler(mockReq({ body: { oldRoomId: 'old1', newRoomId: 'new1' } }), res);

  assert.deepEqual(res.body, { ok: true, migrated: true });
  assert.equal(await kv.get(kvKey('old1')), null);
  assert.deepEqual(await kv.get(kvKey('new1')), { strokes: [{ id: 's1' }] });
});

test('refuses to rename onto an already-existing room name (no accidental overwrite)', async () => {
  const { kv } = installMocks();
  await kv.set(kvKey('existing'), { strokes: [{ id: 'zzz' }] });
  await kv.set(kvKey('old2'), { strokes: [{ id: 's2' }] });
  const handler = freshHandler(RENAME);
  const res = mockRes();

  await handler(mockReq({ body: { oldRoomId: 'old2', newRoomId: 'existing' } }), res);

  assert.equal(res.statusCode, 409);
  assert.deepEqual(await kv.get(kvKey('old2')), { strokes: [{ id: 's2' }] });
  assert.deepEqual(await kv.get(kvKey('existing')), { strokes: [{ id: 'zzz' }] });
});

test('renaming a private room requires being a verified member', async () => {
  const { kv } = installMocks();
  await kv.set(kvKey('priv1'), { strokes: [] });
  await kv.set('fa:room:priv1:members', ['owner@x.com']);
  const handler = freshHandler(RENAME);
  const res = mockRes();

  await handler(mockReq({ body: { oldRoomId: 'priv1', newRoomId: 'priv1new', email: 'owner@x.com' } }), res);

  assert.equal(res.statusCode, 403); // 토큰 없이 이메일만 주장 -> 거부
});

test('missing oldRoomId / too-long newRoomId are rejected with 400', async () => {
  installMocks();
  const handler = freshHandler(RENAME);

  let res = mockRes();
  await handler(mockReq({ body: { oldRoomId: '', newRoomId: 'x' } }), res);
  assert.equal(res.statusCode, 400);

  res = mockRes();
  await handler(mockReq({ body: { oldRoomId: 'a', newRoomId: 'x'.repeat(40) } }), res);
  assert.equal(res.statusCode, 400);
});

test('renaming to the same name is a no-op success', async () => {
  installMocks();
  const handler = freshHandler(RENAME);
  const res = mockRes();

  await handler(mockReq({ body: { oldRoomId: 'same', newRoomId: 'same' } }), res);

  assert.deepEqual(res.body, { ok: true });
});
