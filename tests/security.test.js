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

// 회귀 테스트: 방 이름만 알면 누구나 그 방을 비공개로 잠그거나 이름을 바꿔 옮길 수 있었다
test('the creator recorded on first write is the only one who can make the room private or rename it', async () => {
  const { kv } = installMocks();
  const restore = stubGoogleAuth({ 'own-tok': 'creator@x.com', 'oth-tok': 'other@x.com' });
  try {
    await freshHandler(api('action'))(mockReq({ headers: { authorization: 'Bearer own-tok' }, body: { roomId: 'board', userId: 'u1',
      email: 'creator@x.com', action: { type: 'note_add', note: { id: 'n1' } } } }), mockRes());
    assert.equal((await kv.get(kvKey('board'))).createdBy, 'creator@x.com');

    // 다른 사람이 방을 열어도 만든 사람 이메일은 보이지 않음
    const view = mockRes();
    await freshHandler(api('room'))(mockReq({ method: 'GET', query: { roomId: 'board' } }), view);
    assert.equal(view.body.createdBy, undefined);

    const team = freshHandler(api('team'));
    const invite = mockRes();
    await team(mockReq({ headers: { authorization: 'Bearer oth-tok' }, body: { action: 'invite', roomId: 'board', email: 'other@x.com' } }), invite);
    assert.equal(invite.statusCode, 403);
    assert.equal(await kv.get(`${kvKey('board')}:members`), null);

    const rename = mockRes();
    await freshHandler(api('rename-room'))(mockReq({ headers: { authorization: 'Bearer oth-tok' },
      body: { oldRoomId: 'board', newRoomId: 'stolen', email: 'other@x.com' } }), rename);
    assert.equal(rename.statusCode, 403);
    assert.ok(await kv.get(kvKey('board')));

    const ownInvite = mockRes();
    await team(mockReq({ headers: { authorization: 'Bearer own-tok' }, body: { action: 'invite', roomId: 'board', email: 'creator@x.com' } }), ownInvite);
    assert.equal(ownInvite.statusCode, 200);
  } finally { restore(); }
});

test('image_update reports image_too_large instead of silently dropping the result', async () => {
  const { kv } = installMocks();
  await kv.set(kvKey('r1'), { strokes: [], notes: [], shapes: [], images: [{ id: 'i1', src: 'data:image/png;base64,AAAA', x: 0, y: 0, w: 10, h: 10 }] });
  const res = mockRes();
  await freshHandler(api('action'))(mockReq({ body: { roomId: 'r1', userId: 'u1',
    action: { type: 'image_update', imageId: 'i1', src: 'data:image/png;base64,' + 'A'.repeat(2_100_000), bgRemoved: true } } }), res);
  assert.equal(res.body.rejected, 'image_too_large');
  assert.equal((await kv.get(kvKey('r1'))).images[0].src, 'data:image/png;base64,AAAA');
});

// 회귀 테스트: 주인이 기록되지 않은 방(이 기능 이전에 만들어졌거나 게스트가 만든 방)에
// 대해 한때 "먼저 쓴 로그인 사용자를 주인으로 기록"하게 했더니, 방 이름만 아는 제3자가
// 한 글자 쓰고 주인이 되어 원래 쓰던 사람을 비공개 전환으로 영구히 쫓아낼 수 있었다.
// 이제는 주인을 추측하지 않고, 대신 그 방을 실제로 쓴 사람만 잠글 수 있게 한다.
test('a stranger cannot take over a room that has no recorded owner', async () => {
  const { kv } = installMocks();
  const restore = stubGoogleAuth({ 'alice-tok': 'alice@x.com', 'evil-tok': 'stranger@evil.com' });
  try {
    // alice가 쭉 쓰던, 주인이 기록되지 않은 방
    await kv.set(kvKey('board'), { strokes: [], notes: [{ id: 'a1' }], images: [], shapes: [] });
    await freshHandler(api('action'))(mockReq({ headers: { authorization: 'Bearer alice-tok' },
      body: { roomId: 'board', userId: 'u1', email: 'alice@x.com',
        action: { type: 'note_add', note: { id: 'a2' } } } }), mockRes());

    // 주인을 멋대로 정하지 않는다
    assert.equal((await kv.get(kvKey('board'))).createdBy, undefined);

    // 제3자가 써도 주인이 되지 않고, 비공개로 잠글 수도 없다
    const w = mockRes();
    await freshHandler(api('action'))(mockReq({ headers: { authorization: 'Bearer evil-tok' },
      body: { roomId: 'board', userId: 'u2', email: 'stranger@evil.com',
        action: { type: 'note_add', note: { id: 'e1' } } } }), w);
    assert.equal(w.statusCode, 200); // 쓰기 자체는 공개 방이므로 허용
    assert.equal((await kv.get(kvKey('board'))).createdBy, undefined);

    // 제3자가 비공개로 바꾸더라도 alice가 멤버로 함께 들어가 쫓겨나지 않아야 하고,
    // 소유자(members[0] — 다른 멤버를 내보낼 수 있는 사람)는 먼저 쓴 alice여야 한다
    const invite = mockRes();
    await freshHandler(api('team'))(mockReq({ headers: { authorization: 'Bearer evil-tok' },
      body: { action: 'invite', roomId: 'board', email: 'stranger@evil.com' } }), invite);
    const members = await kv.get(`${kvKey('board')}:members`);
    assert.ok(members.includes('alice@x.com'), 'alice가 멤버에서 빠지면 안 된다');
    assert.equal(members[0], 'alice@x.com', '먼저 쓴 사람이 소유자여야 한다');

    // 그래서 제3자는 alice를 내보낼 수 없다
    const kick = mockRes();
    await freshHandler(api('team'))(mockReq({ headers: { authorization: 'Bearer evil-tok' },
      body: { action: 'remove', roomId: 'board', email: 'stranger@evil.com', removeEmail: 'alice@x.com' } }), kick);
    assert.equal(kick.statusCode, 403);

    // alice는 여전히 들어갈 수 있다
    const view = mockRes();
    await freshHandler(api('room'))(mockReq({ method: 'GET',
      headers: { authorization: 'Bearer alice-tok' }, query: { roomId: 'board', email: 'alice@x.com' } }), view);
    assert.equal(view.statusCode, 200);
  } finally { restore(); }
});

// 주인이 없는 방을 함께 쓰던 사람이 비공개로 바꾸면, 같이 쓰던 사람들이 모두 멤버로
// 들어가야 한다 — 안 그러면 먼저 누른 사람만 남고 나머지가 조용히 쫓겨난다.
test('making an ownerless room private keeps everyone who worked in it', async () => {
  const { kv } = installMocks();
  const restore = stubGoogleAuth({ 'a-tok': 'alice@x.com', 'b-tok': 'bob@x.com' });
  try {
    await kv.set(kvKey('team'), { strokes: [], notes: [], images: [], shapes: [] });
    for (const [tok, em, id] of [['a-tok','alice@x.com','n1'], ['b-tok','bob@x.com','n2']]) {
      await freshHandler(api('action'))(mockReq({ headers: { authorization: `Bearer ${tok}` },
        body: { roomId: 'team', userId: 'u', email: em, action: { type: 'note_add', note: { id } } } }), mockRes());
    }
    // 함께 쓴 사람이 둘 다 기록된다
    assert.deepEqual((await kv.get(kvKey('team'))).contributors, ['alice@x.com', 'bob@x.com']);

    const invite = mockRes();
    await freshHandler(api('team'))(mockReq({ headers: { authorization: 'Bearer b-tok' },
      body: { action: 'invite', roomId: 'team', email: 'bob@x.com' } }), invite);
    assert.equal(invite.statusCode, 200);
    const members = await kv.get(`${kvKey('team')}:members`);
    assert.ok(members.includes('alice@x.com'), 'alice가 쫓겨나면 안 된다');
    assert.ok(members.includes('bob@x.com'));

    // alice는 그대로 들어갈 수 있다
    const view = mockRes();
    await freshHandler(api('room'))(mockReq({ method: 'GET',
      headers: { authorization: 'Bearer a-tok' }, query: { roomId: 'team', email: 'alice@x.com' } }), view);
    assert.equal(view.statusCode, 200);
    assert.equal(view.body.contributors, undefined, '함께 쓴 사람 이메일은 내려보내지 않는다');
  } finally { restore(); }
});

// 회귀 테스트: _guest 플래그가 저장된 state에서 계속 읽혀 한 번 붙으면 떨어지지 않았다.
// 그래서 로그인 사용자가 그 방을 이어 써도 쓰기마다 24시간 TTL이 새로 걸렸고, 하루만
// 쉬면 방이 통째로 삭제됐다 (게스트로 체험 → 로그인해서 계속 쓰는 흔한 흐름).
test('a guest-created room loses its 24h expiry once a verified user adopts it', async () => {
  const { kv } = installMocks();
  const restore = stubGoogleAuth({ 'own-tok': 'owner@x.com' });
  try {
    await freshHandler(api('action'))(mockReq({ body: { roomId: 'board', userId: 'g1', isGuest: true,
      action: { type: 'note_add', note: { id: 'n1' } } } }), mockRes());
    assert.equal((await kv.get(kvKey('board')))._guest, true);

    const opts = [];
    const realSet = kv.set.bind(kv);
    kv.set = async (k, v, o) => { if (k === kvKey('board')) opts.push(o); return realSet(k, v, o); };

    await freshHandler(api('action'))(mockReq({ headers: { authorization: 'Bearer own-tok' },
      body: { roomId: 'board', userId: 'u1', email: 'owner@x.com',
        action: { type: 'note_add', note: { id: 'n2' } } } }), mockRes());
    kv.set = realSet;

    assert.equal((await kv.get(kvKey('board')))._guest, undefined);
    assert.deepEqual(opts, [undefined]); // TTL 없이 저장 — 더는 만료되지 않는다
  } finally { restore(); }
});

// 회귀 테스트: 이름 변경이 "읽어서 비었는지 확인 → 쓰기"였고 락도 안 잡아서, 서로 다른 두 방을
// 같은 이름으로 동시에 바꾸면 둘 다 ok를 받고 한쪽 방이 오류 없이 사라졌다.
test('two rooms renamed to the same name concurrently: one wins, the loser keeps its content', async () => {
  const { kv } = installMocks();
  await kv.set(kvKey('a'), { strokes: [], notes: [{ id: 'from-a' }], images: [], shapes: [] });
  await kv.set(kvKey('b'), { strokes: [], notes: [{ id: 'from-b' }], images: [], shapes: [] });

  const [ra, rb] = [mockRes(), mockRes()];
  await Promise.all([
    freshHandler(api('rename-room'))(mockReq({ body: { oldRoomId: 'a', newRoomId: 'c' } }), ra),
    freshHandler(api('rename-room'))(mockReq({ body: { oldRoomId: 'b', newRoomId: 'c' } }), rb),
  ]);

  const codes = [ra.statusCode, rb.statusCode].sort();
  assert.deepEqual(codes, [200, 409], '한쪽은 반드시 name_taken으로 거절돼야 한다');

  // 이긴 쪽만 c로 옮겨지고, 진 쪽은 원래 이름에 내용이 그대로 남아 있어야 한다
  const winner = ra.statusCode === 200 ? 'a' : 'b';
  const loser  = winner === 'a' ? 'b' : 'a';
  assert.equal((await kv.get(kvKey('c'))).notes[0].id, `from-${winner}`);
  assert.equal(await kv.get(kvKey(winner)), null);
  assert.equal((await kv.get(kvKey(loser))).notes[0].id, `from-${loser}`);
});

// 회귀 테스트: 이름 변경이 api/action.js의 룸 락을 무시해서, 변경 도중에 들어온 액션이 이미
// 지워진 옛 키에 상태를 되살려 써 넣었다 — 방이 두 이름으로 갈라지고 그 사이 그린 게 유실됐다.
test('rename refuses with 503 while the room lock is held, instead of splitting the room', async () => {
  const { kv } = installMocks();
  await kv.set(kvKey('a'), { strokes: [], notes: [{ id: 'n1' }], images: [], shapes: [] });
  await kv.set(`${kvKey('a')}:lock`, 'someone-elses-token');

  const res = mockRes();
  await freshHandler(api('rename-room'))(mockReq({ body: { oldRoomId: 'a', newRoomId: 'c' } }), res);
  assert.equal(res.statusCode, 503);
  assert.equal(await kv.get(kvKey('c')), null);
  assert.ok(await kv.get(kvKey('a')), '거절된 이름 변경은 원래 방을 건드리지 않아야 한다');
});

// 회귀 테스트: join이 KV 읽기 실패를 "KV 미설정"과 같이 묶어 삼키고 빈 캔버스를 200으로
// 돌려줬다 — 처음 들어오는 협업자는 오류 없이 백지를 받아 그게 방의 전부라고 믿었다.
test('join returns 500 when the room state cannot be read, instead of serving a blank canvas', async () => {
  const { kv } = installMocks();
  await kv.set(kvKey('r1'), { strokes: [], notes: [{ id: 'a' }, { id: 'b' }], images: [], shapes: [] });
  const realGet = kv.get.bind(kv);
  kv.get = async k => { if (k === kvKey('r1')) throw new Error('kv down'); return realGet(k); };

  const res = mockRes();
  await freshHandler(api('join'))(mockReq({ body: { roomId: 'r1' } }), res);
  kv.get = realGet;
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.state, undefined);
});

// 회귀 테스트: 이미지·도형 개수 한도를 넘으면 조용히 버리고 ok만 돌려줬다. 클라이언트에는
// 한도 검사가 아예 없어서, 사용자는 화면에 그려진 것을 보고 작업을 이어가다 새로고침하면
// 그 항목만 사라진 것을 발견했다.
test('image_add and shape_add report the cap instead of dropping the item with ok:true', async () => {
  const { kv } = installMocks();
  const img = i => ({ id: `i${i}`, src: 'data:image/png;base64,AAAA', x: 0, y: 0, w: 10, h: 10 });
  await kv.set(kvKey('r1'), {
    strokes: [], notes: [],
    images: Array.from({ length: 20 }, (_, i) => img(i)),
    shapes: Array.from({ length: 300 }, (_, i) => ({ id: `s${i}`, type: 'rect', x: 0, y: 0, w: 5, h: 5 })),
  });

  const ri = mockRes();
  await freshHandler(api('action'))(mockReq({ body: { roomId: 'r1', userId: 'u1',
    action: { type: 'image_add', image: img(99) } } }), ri);
  assert.equal(ri.body.rejected, 'image_limit');
  assert.equal((await kv.get(kvKey('r1'))).images.length, 20);

  const rs = mockRes();
  await freshHandler(api('action'))(mockReq({ body: { roomId: 'r1', userId: 'u1',
    action: { type: 'shape_add', shape: { id: 's999', type: 'rect', x: 0, y: 0, w: 5, h: 5 } } } }), rs);
  assert.equal(rs.body.rejected, 'shape_limit');
  assert.equal((await kv.get(kvKey('r1'))).shapes.length, 300);
});

// 회귀 테스트: userId는 빈 문자열만 걸러서 10만 자짜리도 모든 객체에 그대로 저장됐다 —
// 방 상태를 부풀려 결국 kv.set이 실패하면 그 방 사용자 전원이 500을 받는다.
test('an absurdly long userId is rejected instead of being persisted onto every object', async () => {
  const { kv } = installMocks();
  const res = mockRes();
  await freshHandler(api('action'))(mockReq({ body: { roomId: 'r1', userId: 'u'.repeat(100_000),
    action: { type: 'note_add', note: { id: 'n1' } } } }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(await kv.get(kvKey('r1')), null);
});

// 회귀 테스트: 이름 변경이 출발지 락만 잡아서, 목적지 이름으로 이미 작업 중인 요청이
// 자기가 읽은(비어 있던) 상태를 나중에 써 넣어 방금 옮겨온 내용을 통째로 덮어썼다.
test('rename refuses with 503 while the DESTINATION room is locked', async () => {
  const { kv } = installMocks();
  await kv.set(kvKey('a'), { strokes: [], notes: [{ id: 'keep-me' }], images: [], shapes: [] });
  await kv.set(`${kvKey('c')}:lock`, 'someone-working-in-c');

  const res = mockRes();
  await freshHandler(api('rename-room'))(mockReq({ body: { oldRoomId: 'a', newRoomId: 'c' } }), res);
  assert.equal(res.statusCode, 503, '목적지가 잠겨 있으면 거절해야 한다');
  assert.equal(await kv.get(kvKey('c')), null, '목적지에 아무것도 쓰면 안 된다');
  assert.equal((await kv.get(kvKey('a'))).notes[0].id, 'keep-me', '출발지는 그대로여야 한다');
});

// 회귀 테스트: 비공개 방의 실시간 채널 인증이 멤버 검사 없이 서명해 주면, 멤버가 아닌
// 사람이 접속자 목록(이메일·이름)과 커서·그리는 중인 획을 그대로 받아볼 수 있다.
test('pusher-auth refuses to sign a private room channel for a non-member', async () => {
  const { kv } = installMocks();
  const restore = stubGoogleAuth({ 'mem-tok': 'member@x.com', 'out-tok': 'outsider@x.com' });
  try {
    await kv.set(`${kvKey('secret')}:members`, ['member@x.com']);
    const chan = `presence-room-${Buffer.from('secret', 'utf8').toString('base64url')}`;

    const denied = mockRes();
    await freshHandler(api('pusher-auth'))(mockReq({ headers: { authorization: 'Bearer out-tok' },
      body: { socket_id: '1.1', channel_name: chan, email: 'outsider@x.com', user_id: 'abcd1234' } }), denied);
    assert.equal(denied.statusCode, 403);

    const allowed = mockRes();
    await freshHandler(api('pusher-auth'))(mockReq({ headers: { authorization: 'Bearer mem-tok' },
      body: { socket_id: '1.1', channel_name: chan, email: 'member@x.com', user_id: 'abcd1234' } }), allowed);
    assert.equal(allowed.statusCode, 200);
  } finally { restore(); }
});

// 회귀 테스트: 락은 내가 건 것일 때만 풀어야 한다. 무조건 삭제하면, 처리 시간이 TTL을
// 넘긴 사이 다른 요청이 새로 건 락을 지워 두 요청이 같은 방을 동시에 고치게 된다.
test('releaseRoomLock only deletes the lock it acquired', async () => {
  const { kv } = installMocks();
  const { acquireRoomLock, releaseRoomLock } = freshHandler(path.join(__dirname, '..', 'lib', 'auth.js'));
  const lock = await acquireRoomLock(kv, kvKey('r1'));
  assert.ok(lock);
  // TTL이 지나 다른 요청이 새로 락을 건 상황을 흉내낸다
  await kv.set(`${kvKey('r1')}:lock`, 'someone-elses-token');
  await releaseRoomLock(kv, lock);
  assert.equal(await kv.get(`${kvKey('r1')}:lock`), 'someone-elses-token', '남의 락을 지우면 안 된다');
});

// 회귀 테스트: 처리 중 예외가 나도 락은 반드시 풀려야 한다. 안 풀리면 그 방의 모든 쓰기가
// TTL(10초) 동안 503이 되어 사용자마다 "저장 실패" 안내와 전체 재동기화를 반복한다.
test('the room lock is released even when the handler throws', async () => {
  const { kv } = installMocks();
  await kv.set(kvKey('r1'), { strokes: [], notes: [], images: [], shapes: [] });
  const realSet = kv.set.bind(kv);
  kv.set = async (k, v, o) => { if (k === kvKey('r1')) throw new Error('kv down'); return realSet(k, v, o); };

  const res = mockRes();
  await freshHandler(api('action'))(mockReq({ body: { roomId: 'r1', userId: 'u1',
    action: { type: 'note_add', note: { id: 'n1' } } } }), res);
  kv.set = realSet;
  assert.equal(res.statusCode, 500);
  assert.equal(await kv.get(`${kvKey('r1')}:lock`), null, '예외가 나도 락은 풀려 있어야 한다');
});

// 회귀 테스트: 방 이름 한도가 파일마다 32자/64자로 달라서, 33~64자 방은 만들 수는 있는데
// 이름 변경·비공개 전환이 영구히 400으로 거절됐다. 한 곳(lib/auth.js)에서만 정한다.
test('a room name that can be created can also be renamed and made private', async () => {
  const { kv } = installMocks();
  const restore = stubGoogleAuth({ 'tok': 'owner@x.com' });
  try {
    const long = '방'.repeat(40); // 한도를 넘는 이름
    const act = mockRes();
    await freshHandler(api('action'))(mockReq({ headers: { authorization: 'Bearer tok' },
      body: { roomId: long, userId: 'u1', email: 'owner@x.com',
        action: { type: 'note_add', note: { id: 'n1' } } } }), act);
    assert.equal(act.statusCode, 400, '만들 수 없는 길이라면 쓰기 단계에서 막혀야 한다');

    // 한도 안의 이름은 세 곳 모두에서 받아들여져야 한다
    const ok = '방'.repeat(32);
    await freshHandler(api('action'))(mockReq({ headers: { authorization: 'Bearer tok' },
      body: { roomId: ok, userId: 'u1', email: 'owner@x.com',
        action: { type: 'note_add', note: { id: 'n1' } } } }), mockRes());
    assert.ok(await kv.get(kvKey(ok)));

    const inv = mockRes();
    await freshHandler(api('team'))(mockReq({ headers: { authorization: 'Bearer tok' },
      body: { action: 'invite', roomId: ok, email: 'owner@x.com' } }), inv);
    assert.equal(inv.statusCode, 200, '만들 수 있는 이름은 비공개 전환도 돼야 한다');
  } finally { restore(); }
});

// 회귀 테스트: 좌표·크기를 typeof로만 검사하면 Infinity·NaN이 통과하는데, 그 값은 KV에
// JSON으로 저장되는 순간 null이 되어 항목이 화면에서 위치를 잃거나 사라진다.
// (가짜 KV가 structuredClone만 쓰던 동안에는 Infinity가 그대로 살아남아 재현되지 않았다)
test('Infinity / NaN coordinates are replaced with a usable value, not stored as null', async () => {
  const { kv } = installMocks();
  const drawable = v => typeof v === 'number' && Number.isFinite(v);

  await freshHandler(api('action'))(mockReq({ body: { roomId: 'r1', userId: 'u1',
    action: { type: 'note_add', note: { id: 'n1', x: Infinity, y: NaN, w: 200, h: 150 } } } }), mockRes());
  await freshHandler(api('action'))(mockReq({ body: { roomId: 'r1', userId: 'u1',
    action: { type: 'image_add', image: { id: 'i1', src: 'data:image/png;base64,AAAA',
      x: NaN, y: -Infinity, w: 10, h: 10, z: NaN } } } }), mockRes());
  await freshHandler(api('action'))(mockReq({ body: { roomId: 'r1', userId: 'u1',
    action: { type: 'shape_add', shape: { id: 's1', type: 'rect', x: NaN, y: Infinity, w: 10, h: 10 } } } }), mockRes());

  const st = await kv.get(kvKey('r1'));
  for (const [label, o] of [['노트', st.notes[0]], ['이미지', st.images[0]], ['도형', st.shapes[0]]]) {
    assert.ok(drawable(o.x) && drawable(o.y), `${label}의 좌표가 화면에 그릴 수 없는 값이다: ${JSON.stringify([o.x, o.y])}`);
  }
  assert.ok(drawable(st.images[0].z), '이미지 앞뒤 순서도 숫자여야 정렬이 깨지지 않는다');
});
