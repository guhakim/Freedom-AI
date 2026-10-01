'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { installMocks, freshHandler, mockReq, mockRes, stubGoogleAuth } = require('./helpers/mockBackend');

const api = name => path.join(__dirname, '..', 'api', `${name}.js`);
const kvKey = roomId => `fa:room:${roomId}`;

// 회귀 테스트: roomId에 방 보조 키 접미사(":members"·":lock")를 붙여 다른 방의 멤버 목록을
// 읽고(이메일 유출), 덮어쓰고(방 잠금), 옮겨서(비공개 해제) 수 있었다.
test('roomIds ending in :members / :lock are rejected by every endpoint', async () => {
  const { kv } = installMocks();
  await kv.set(`${kvKey('victim')}:members`, ['owner@x.com']);

  const room = mockRes();
  await freshHandler(api('room'))(mockReq({ method: 'GET', query: { roomId: 'victim:members' } }), room);
  assert.equal(room.statusCode, 400);

  const join = mockRes();
  await freshHandler(api('join'))(mockReq({ body: { roomId: 'victim:members' } }), join);
  assert.equal(join.statusCode, 400);

  const action = mockRes();
  await freshHandler(api('action'))(mockReq({ body: { roomId: 'victim:members', userId: 'u1',
    action: { type: 'note_add', note: { id: 'n1' } } } }), action);
  assert.equal(action.statusCode, 400);

  const rename = mockRes();
  await freshHandler(api('rename-room'))(mockReq({ body: { oldRoomId: 'victim:members', newRoomId: 'junk' } }), rename);
  assert.equal(rename.statusCode, 400);

  assert.deepEqual(await kv.get(`${kvKey('victim')}:members`), ['owner@x.com']);
  assert.equal(await kv.get(kvKey('junk')), null);
});

// 이미 깨진 멤버 목록(배열이 아닌 값)이 있어도 500으로 죽지 않고 오픈 방으로 취급
test('a non-array members value does not crash access checks', async () => {
  const { kv } = installMocks();
  await kv.set(`${kvKey('r1')}:members`, { strokes: [] });
  const res = mockRes();
  await freshHandler(api('room'))(mockReq({ method: 'GET', query: { roomId: 'r1', email: 'a@x.com' } }), res);
  assert.equal(res.statusCode, 200);
});

// 회귀 테스트: KV 읽기가 한 번 실패하면 빈 방으로 착각해 기존 내용을 통째로 덮어썼다
test('a failed KV read returns 500 and leaves the room untouched', async () => {
  const { kv } = installMocks();
  await kv.set(kvKey('r1'), { strokes: [], notes: [{ id: 'a' }, { id: 'b' }], images: [], shapes: [] });
  const realGet = kv.get.bind(kv);
  kv.get = async k => { if (k === kvKey('r1')) throw new Error('kv down'); return realGet(k); };

  const res = mockRes();
  await freshHandler(api('action'))(mockReq({ body: { roomId: 'r1', userId: 'u1',
    action: { type: 'note_add', note: { id: 'c' } } } }), res);
  assert.equal(res.statusCode, 500);
  kv.get = realGet;
  assert.deepEqual((await kv.get(kvKey('r1'))).notes.map(n => n.id), ['a', 'b']);
});

test('when the room lock cannot be acquired the action is refused with 503, not applied unlocked', async () => {
  const { kv } = installMocks();
  await kv.set(`${kvKey('r1')}:lock`, 'someone-else');
  const res = mockRes();
  await freshHandler(api('action'))(mockReq({ body: { roomId: 'r1', userId: 'u1',
    action: { type: 'note_add', note: { id: 'c' } } } }), res);
  assert.equal(res.statusCode, 503);
  assert.equal(await kv.get(kvKey('r1')), null);
  assert.equal(await kv.get(`${kvKey('r1')}:lock`), 'someone-else'); // 남의 락은 건드리지 않음
});

test('stroke_end stores only sanitized fields and does not broadcast rejected strokes', async () => {
  const { kv, triggers } = installMocks();
  const handler = freshHandler(api('action'));
  await handler(mockReq({ body: { roomId: 'r1', userId: 'u1', action: { type: 'stroke_end', strokeId: 's1',
    stroke: { id: 's1', tool: 'pen', color: '#000000', width: 2, points: [{ x: 1, y: 2, junk: 1 }], evil: 'x', groupId: 'g1' } } } }), mockRes());
  const saved = (await kv.get(kvKey('r1'))).strokes[0];
  assert.deepEqual(saved, { id: 's1', tool: 'pen', color: '#000000', width: 2, userId: 'u1', points: [{ x: 1, y: 2 }], groupId: 'g1' });

  triggers.length = 0;
  await handler(mockReq({ body: { roomId: 'r1', userId: 'u1', action: { type: 'stroke_end', strokeId: 's2',
    stroke: { id: 's2', tool: 'eraser', color: '#000000', width: 2, points: [{ x: 1, y: 1 }] } } } }), mockRes());
  assert.equal(triggers.length, 0);
});

test('oversized Pusher payloads are replaced by a room_resync signal instead of failing', async () => {
  const { triggers } = installMocks();
  const points = Array.from({ length: 2000 }, (_, i) => ({ x: i + 0.123456789, y: i + 0.987654321 }));
  const res = mockRes();
  await freshHandler(api('action'))(mockReq({ body: { roomId: 'r1', userId: 'u1', action: { type: 'stroke_end', strokeId: 's1',
    stroke: { id: 's1', tool: 'pen', color: '#000000', width: 2, points } } } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(triggers.map(t => t.event), ['room_resync']);
});

test('items_update applies many position/size changes in one write', async () => {
  const { kv, triggers } = installMocks();
  await kv.set(kvKey('r1'), {
    strokes: [{ id: 's1', tool: 'pen', points: [{ x: 0, y: 0 }] }],
    notes: [{ id: 'n1', x: 0, y: 0, w: 160, h: 130 }],
    images: [{ id: 'i1', x: 0, y: 0, w: 100, h: 100 }],
    shapes: [{ id: 'a1', type: 'arrow', x1: 0, y1: 0, x2: 10, y2: 0, bend: 0 }],
  });
  await freshHandler(api('action'))(mockReq({ body: { roomId: 'r1', userId: 'u1', action: { type: 'items_update', items: [
    { id: 'n1', x: 5, y: 6, w: 200, h: 150 },
    { id: 'i1', x: 7, y: 8, w: 50, h: 50 },
    { id: 'a1', x1: 1, y1: 2, x2: 3, y2: 4, bend: 5 },
    { id: 's1', points: [{ x: 9, y: 9 }] },
    { id: 'n1', x: 'NaN' },
  ] } } }), mockRes());
  const st = await kv.get(kvKey('r1'));
  assert.deepEqual([st.notes[0].x, st.notes[0].y, st.notes[0].w], [5, 6, 200]);
  assert.deepEqual([st.images[0].x, st.images[0].w], [7, 50]);
  assert.deepEqual([st.shapes[0].x1, st.shapes[0].y2, st.shapes[0].bend], [1, 4, 5]);
  assert.deepEqual(st.strokes[0].points, [{ x: 9, y: 9 }]);
  assert.deepEqual(triggers.map(t => t.event), ['items_update']);
});

test('todo_toggle sets the requested value instead of blindly flipping', async () => {
  const { kv } = installMocks();
  await kv.set(kvKey('r1'), { strokes: [], notes: [], images: [], shapes: [], todos: { '2026-10-1': [{ id: 't1', text: 'x', done: true }] } });
  await freshHandler(api('action'))(mockReq({ body: { roomId: 'r1', userId: 'u1',
    action: { type: 'todo_toggle', date: '2026-10-1', todoId: 't1', done: true } } }), mockRes());
  assert.equal((await kv.get(kvKey('r1'))).todos['2026-10-1'][0].done, true);
});

// 회귀 테스트: 새로 초대받은 멤버가 다른 멤버(방을 비공개로 만든 사람 포함)를 내보낼 수 있었다
test('only the room owner can remove other members; members can remove themselves', async () => {
  const { kv } = installMocks();
  const restore = stubGoogleAuth({ 'sec-owner': 'owner@x.com', 'sec-member': 'm@x.com' });
  try {
    await kv.set(`${kvKey('r1')}:members`, ['owner@x.com', 'm@x.com', 'n@x.com']);
    const handler = freshHandler(api('team'));
    const call = async (token, email, removeEmail) => {
      const res = mockRes();
      await handler(mockReq({ headers: { authorization: `Bearer ${token}` }, body: { action: 'remove', roomId: 'r1', email, removeEmail } }), res);
      return res.statusCode;
    };
    assert.equal(await call('sec-member', 'm@x.com', 'owner@x.com'), 403);
    assert.equal(await call('sec-member', 'm@x.com', 'n@x.com'), 403);
    assert.equal(await call('sec-member', 'm@x.com', 'm@x.com'), 200);
    assert.equal(await call('sec-owner', 'owner@x.com', 'n@x.com'), 200);
    assert.deepEqual(await kv.get(`${kvKey('r1')}:members`), ['owner@x.com']);
  } finally { restore(); }
});

test('tokens issued to other OAuth clients are not accepted', async () => {
  const { kv } = installMocks();
  await kv.set(`${kvKey('r1')}:members`, ['owner@x.com']);
  const original = global.fetch;
  global.fetch = async url => (String(url).startsWith('https://oauth2.googleapis.com/tokeninfo')
    ? { ok: true, json: async () => ({ email: 'owner@x.com', aud: 'some-other-app.apps.googleusercontent.com' }) }
    : original(url));
  try {
    const res = mockRes();
    await freshHandler(api('room'))(mockReq({ method: 'GET', headers: { authorization: 'Bearer foreign-token' },
      query: { roomId: 'r1', email: 'owner@x.com' } }), res);
    assert.equal(res.statusCode, 403);
  } finally { global.fetch = original; }
});

test('pusher-auth only signs this app\'s room channels', async () => {
  installMocks();
  const handler = freshHandler(api('pusher-auth'));
  const res = mockRes();
  await handler(mockReq({ body: { socket_id: '1.2', channel_name: 'private-anything', user_id: 'abcd1234' } }), res);
  assert.equal(res.statusCode, 403);

  const ok = mockRes();
  const ch = 'presence-room-' + Buffer.from('r1').toString('base64url');
  await handler(mockReq({ body: { socket_id: '1.2', channel_name: ch, user_id: 'abcd1234' } }), ok);
  assert.equal(ok.statusCode, 200);
});

test('contact form reports failure when the message could not be stored', async () => {
  const { kv } = installMocks();
  kv.lpush = async () => { throw new Error('kv down'); };
  const res = mockRes();
  await freshHandler(api('contact'))(mockReq({ body: { name: 'a', email: 'a@x.com', message: 'hi' } }), res);
  assert.equal(res.statusCode, 503);
});
