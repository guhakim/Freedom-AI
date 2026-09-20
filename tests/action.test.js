'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { installMocks, freshHandler, mockReq, mockRes } = require('./helpers/mockBackend');

const ACTION = path.join(__dirname, '..', 'api', 'action.js');
const kvKey = roomId => `fa:room:${roomId}`;

test('stroke_end persists a valid pen stroke', async () => {
  const { kv } = installMocks();
  const handler = freshHandler(ACTION);
  const res = mockRes();

  await handler(mockReq({ body: {
    roomId: 'r1', userId: 'u1',
    action: { type: 'stroke_end', strokeId: 's1', stroke: { id: 's1', tool: 'pen', color: '#000000', width: 2, points: [{ x: 1, y: 1 }] } },
  } }), res);

  assert.equal(res.statusCode, 200);
  const state = await kv.get(kvKey('r1'));
  assert.equal(state.strokes.length, 1);
  assert.equal(state.strokes[0].userId, 'u1');
});

// 회귀 테스트: 예전엔 "본인이 그린 획만 삭제 가능"이었는데, userId가 새로고침마다
// 바뀌는 구조라 자기 것도 영원히 못 지우는 버그가 됐었다. 지우개와 동일하게
// 소유자 무관 정책으로 바꾼 뒤에도 계속 그렇게 동작하는지 고정해둔다.
test('stroke_manual_delete removes a stroke regardless of owner mismatch', async () => {
  const { kv } = installMocks();
  await kv.set(kvKey('r1'), { strokes: [{ id: 's1', tool: 'pen', color: '#000', width: 2, userId: 'someone-else', points: [{ x: 1, y: 1 }] }], notes: [], images: [], shapes: [] });
  const handler = freshHandler(ACTION);
  const res = mockRes();

  await handler(mockReq({ body: { roomId: 'r1', userId: 'me', action: { type: 'stroke_manual_delete', strokeId: 's1' } } }), res);

  assert.deepEqual(res.body, { ok: true });
  const state = await kv.get(kvKey('r1'));
  assert.equal(state.strokes.find(s => s.id === 's1'), undefined);
});

test('stroke_move updates points regardless of owner mismatch, and caps/validates the array', async () => {
  const { kv } = installMocks();
  await kv.set(kvKey('r1'), { strokes: [{ id: 's1', tool: 'pen', color: '#000', width: 2, userId: 'someone-else', points: [{ x: 1, y: 1 }] }], notes: [], images: [], shapes: [] });
  const handler = freshHandler(ACTION);
  const res = mockRes();

  await handler(mockReq({ body: {
    roomId: 'r1', userId: 'me',
    action: { type: 'stroke_move', strokeId: 's1', points: [{ x: 9, y: 9 }, { x: 10, y: 10 }, 'garbage', { y: 1 }] },
  } }), res);

  const state = await kv.get(kvKey('r1'));
  assert.deepEqual(state.strokes[0].points, [{ x: 9, y: 9 }, { x: 10, y: 10 }]);
});

// 실제 배포된 "웹툰기획" 방에서 발견된 패턴을 그대로 재현: 예전 방식(랜덤 세션별)
// userId로 저장된 노트가 있고, 지금 세션의 userId는 그와 다르다.
test('note_delete removes a note created under a stale legacy userId (production repro)', async () => {
  const { kv } = installMocks();
  await kv.set(kvKey('웹툰기획'), {
    strokes: [], images: [], shapes: [],
    notes: [{ id: 'mty08oyj4gjy', x: 0, y: 0, w: 160, h: 130, color: '#fef08a', text: 'ㅎ호ㅓ', userId: '9k9esrxe' }],
  });
  const handler = freshHandler(ACTION);
  const res = mockRes();

  await handler(mockReq({ body: {
    roomId: '웹툰기획', userId: 'my-current-persistent-client-id',
    action: { type: 'note_delete', noteId: 'mty08oyj4gjy' },
  } }), res);

  assert.deepEqual(res.body, { ok: true });
  const state = await kv.get(kvKey('웹툰기획'));
  assert.equal(state.notes.length, 0);
});

test('note_font_size clamps to the valid range and ignores non-numeric values', async () => {
  const { kv, triggers } = installMocks();
  await kv.set(kvKey('r1'), { strokes: [], images: [], shapes: [],
    notes: [{ id: 'n1', x: 0, y: 0, w: 160, h: 130, color: '#fef08a', text: 'hi', userId: 'old' }] });
  const handler = freshHandler(ACTION);

  let res = mockRes();
  await handler(mockReq({ body: { roomId: 'r1', userId: 'me', action: { type: 'note_font_size', noteId: 'n1', fontSize: 999 } } }), res);
  let state = await kv.get(kvKey('r1'));
  assert.equal(state.notes[0].fontSize, 32); // MAX_NOTE_FONT로 clamp
  assert.deepEqual(triggers.at(-1).data, { noteId: 'n1', fontSize: 32 });

  res = mockRes();
  await handler(mockReq({ body: { roomId: 'r1', userId: 'me', action: { type: 'note_font_size', noteId: 'n1', fontSize: 'big' } } }), res);
  state = await kv.get(kvKey('r1'));
  assert.equal(state.notes[0].fontSize, 32); // 숫자 아니면 무시하고 기존 값 유지

  res = mockRes();
  await handler(mockReq({ body: { roomId: 'r1', userId: 'me', action: { type: 'note_font_size', noteId: 'n1', fontSize: 18 } } }), res);
  state = await kv.get(kvKey('r1'));
  assert.equal(state.notes[0].fontSize, 18);
});

test('image_update replaces src (position/size untouched) and validates the data URI', async () => {
  const { kv, triggers } = installMocks();
  await kv.set(kvKey('r1'), {
    strokes: [], notes: [], shapes: [],
    images: [{ id: 'i1', src: 'data:image/png;base64,AA==', x: 10, y: 20, w: 100, h: 100, userId: 'old' }],
  });
  const handler = freshHandler(ACTION);

  let res = mockRes();
  await handler(mockReq({ body: { roomId: 'r1', userId: 'me', action: { type: 'image_update', imageId: 'i1', src: 'data:image/png;base64,QUJD' } } }), res);
  let state = await kv.get(kvKey('r1'));
  assert.equal(state.images[0].src, 'data:image/png;base64,QUJD');
  assert.equal(state.images[0].x, 10); // 위치는 그대로
  assert.ok(triggers.some(t => t.event === 'image_update' && t.data.imageId === 'i1'));
  // src 자체는 페이로드에 안 실림 (image_add와 동일한 이유 — Pusher 10KB 제한)
  assert.equal(triggers.find(t => t.event === 'image_update').data.src, undefined);

  // 잘못된 데이터 URI는 무시하고 기존 값을 지킨다
  res = mockRes();
  await handler(mockReq({ body: { roomId: 'r1', userId: 'me', action: { type: 'image_update', imageId: 'i1', src: 'not-an-image' } } }), res);
  state = await kv.get(kvKey('r1'));
  assert.equal(state.images[0].src, 'data:image/png;base64,QUJD');
});

// 회귀 테스트: 배경제거 후 투명 PNG로 바뀌어도, 클라이언트가 사각형 그림자를 계속
// 숨기려면 이 사실이 새로고침 후에도 남아있어야 한다 — bgRemoved 플래그로 저장한다.
test('image_update persists the bgRemoved flag alongside a background-removal result', async () => {
  const { kv } = installMocks();
  await kv.set(kvKey('r1'), {
    strokes: [], notes: [], shapes: [],
    images: [{ id: 'i1', src: 'data:image/png;base64,AA==', x: 10, y: 20, w: 100, h: 100, userId: 'old' }],
  });
  const handler = freshHandler(ACTION);

  const res = mockRes();
  await handler(mockReq({ body: {
    roomId: 'r1', userId: 'me',
    action: { type: 'image_update', imageId: 'i1', src: 'data:image/png;base64,QUJD', bgRemoved: true },
  } }), res);
  const state = await kv.get(kvKey('r1'));
  assert.equal(state.images[0].bgRemoved, true);

  // bgRemoved를 안 보내는 일반 업데이트(AI 변환 등)는 기존 값을 건드리지 않는다
  const res2 = mockRes();
  await handler(mockReq({ body: {
    roomId: 'r1', userId: 'me',
    action: { type: 'image_update', imageId: 'i1', src: 'data:image/png;base64,QUJD' },
  } }), res2);
  const state2 = await kv.get(kvKey('r1'));
  assert.equal(state2.images[0].bgRemoved, true);
});

// 배경제거된 이미지끼리 겹칠 때 앞뒤 순서를 사용자가 직접 조절할 수 있게 하는 기능.
test('image_reorder updates z and rejects invalid values', async () => {
  const { kv, triggers } = installMocks();
  await kv.set(kvKey('r1'), {
    strokes: [], notes: [], shapes: [],
    images: [{ id: 'i1', src: 'data:image/png;base64,AA==', x: 0, y: 0, w: 100, h: 100, z: 0, userId: 'old' }],
  });
  const handler = freshHandler(ACTION);

  let res = mockRes();
  await handler(mockReq({ body: { roomId: 'r1', userId: 'me', action: { type: 'image_reorder', imageId: 'i1', z: 5 } } }), res);
  let state = await kv.get(kvKey('r1'));
  assert.equal(state.images[0].z, 5);
  assert.ok(triggers.some(t => t.event === 'image_reorder' && t.data.imageId === 'i1' && t.data.z === 5));

  // 숫자가 아니면 무시하고 기존 값을 지킨다
  res = mockRes();
  await handler(mockReq({ body: { roomId: 'r1', userId: 'me', action: { type: 'image_reorder', imageId: 'i1', z: 'front' } } }), res);
  state = await kv.get(kvKey('r1'));
  assert.equal(state.images[0].z, 5);

  // 극단적인 값은 범위 안으로 clamp된다
  res = mockRes();
  await handler(mockReq({ body: { roomId: 'r1', userId: 'me', action: { type: 'image_reorder', imageId: 'i1', z: 99_999_999 } } }), res);
  state = await kv.get(kvKey('r1'));
  assert.equal(state.images[0].z, 1_000_000);
});

test('image_move and shape_delete also ignore owner mismatch', async () => {
  const { kv } = installMocks();
  await kv.set(kvKey('r1'), {
    strokes: [], notes: [],
    images: [{ id: 'i1', src: 'data:image/png;base64,AA==', x: 0, y: 0, w: 100, h: 100, userId: 'old' }],
    shapes: [{ id: 'sh1', type: 'rect', x: 0, y: 0, w: 100, h: 80, color: '#000', userId: 'old' }],
  });
  const handler = freshHandler(ACTION);

  let res = mockRes();
  await handler(mockReq({ body: { roomId: 'r1', userId: 'me', action: { type: 'image_move', imageId: 'i1', x: 50, y: 60 } } }), res);
  let state = await kv.get(kvKey('r1'));
  assert.equal(state.images[0].x, 50);
  assert.equal(state.images[0].y, 60);

  res = mockRes();
  await handler(mockReq({ body: { roomId: 'r1', userId: 'me', action: { type: 'shape_delete', shapeId: 'sh1' } } }), res);
  state = await kv.get(kvKey('r1'));
  assert.equal(state.shapes.length, 0);
});

// 회귀 테스트: state 기본값에 images/shapes가 없던 시절엔, 그 키가 아예 없는
// 방 상태에서 관련 case가 TypeError로 500을 내며 조용히 실패할 수 있었다.
test('action handler does not throw when stored state is missing images/shapes keys', async () => {
  const { kv } = installMocks();
  await kv.set(kvKey('r1'), { strokes: [], notes: [] }); // 옛날 형식: images/shapes 키 자체가 없음
  const handler = freshHandler(ACTION);
  const res = mockRes();

  await assert.doesNotReject(handler(mockReq({ body: {
    roomId: 'r1', userId: 'me',
    action: { type: 'shape_add', shape: { id: 'sh1', type: 'rect', x: 0, y: 0, w: 100, h: 80, color: '#000000' } },
  } }), res));

  assert.deepEqual(res.body, { ok: true });
});

test('private room (has :members) rejects an action without a valid member email', async () => {
  const { kv } = installMocks();
  await kv.set('fa:room:priv1:members', ['owner@x.com']);
  const handler = freshHandler(ACTION);
  const res = mockRes();

  await handler(mockReq({ body: { roomId: 'priv1', userId: 'me', action: { type: 'stroke_undo', strokeId: 's1' } } }), res);

  assert.equal(res.statusCode, 403);
});

test('erase_result deletes originals and inserts split fragments', async () => {
  const { kv } = installMocks();
  await kv.set(kvKey('r1'), { strokes: [{ id: 'orig1', tool: 'pen', color: '#000000', width: 2, points: [{ x: 0, y: 0 }] }], notes: [], images: [], shapes: [] });
  const handler = freshHandler(ACTION);
  const res = mockRes();

  await handler(mockReq({ body: {
    roomId: 'r1', userId: 'me',
    action: { type: 'erase_result', deletedIds: ['orig1'], newStrokes: [{ id: 'frag1', tool: 'pen', color: '#000000', width: 2, points: [{ x: 5, y: 5 }] }] },
  } }), res);

  const state = await kv.get(kvKey('r1'));
  assert.equal(state.strokes.find(s => s.id === 'orig1'), undefined);
  assert.ok(state.strokes.find(s => s.id === 'frag1'));
});

// 회귀 테스트: erase_result가 deletedIds/newStrokes를 배열인지도 검증 안 하던 시절엔,
// 조작된(또는 버그 있는) 요청 하나로 "x is not iterable" 같은 TypeError가 나며 500이
// 발생할 수 있었다. 또한 newStrokes 각 항목의 필드 검증이 전혀 없어서 MAX_STROKES
// 캡을 우회하거나 임의 필드를 주입할 수 있었다.
test('erase_result rejects malformed payloads instead of crashing, and validates each fragment', async () => {
  const { kv } = installMocks();
  await kv.set(kvKey('r1'), { strokes: [{ id: 'orig1', tool: 'pen', color: '#000000', width: 2, points: [{ x: 0, y: 0 }] }], notes: [], images: [], shapes: [] });
  const handler = freshHandler(ACTION);

  // deletedIds/newStrokes가 배열이 아니면 크래시 없이 그냥 무시(break)해야 한다
  let res = mockRes();
  await assert.doesNotReject(handler(mockReq({ body: {
    roomId: 'r1', userId: 'me',
    action: { type: 'erase_result', deletedIds: null, newStrokes: null },
  } }), res));
  assert.deepEqual(res.body, { ok: true });
  let state = await kv.get(kvKey('r1'));
  assert.ok(state.strokes.find(s => s.id === 'orig1')); // 아무 것도 안 지워짐

  // 유효하지 않은 조각(색상 형식 불량, tool이 pen이 아님, points가 배열이 아님)은
  // 저장되지 않고 조용히 걸러져야 한다
  res = mockRes();
  await handler(mockReq({ body: {
    roomId: 'r1', userId: 'me',
    action: {
      type: 'erase_result', deletedIds: ['orig1'],
      newStrokes: [
        { id: 'bad1', tool: 'pen', color: 'not-a-color', width: 2, points: [{ x: 1, y: 1 }] },
        { id: 'bad2', tool: 'eraser', color: '#000000', width: 2, points: [{ x: 1, y: 1 }] },
        { id: 'bad3', tool: 'pen', color: '#000000', width: 2, points: 'not-an-array' },
        { id: 'good1', tool: 'pen', color: '#000000', width: 2, points: [{ x: 1, y: 1 }] },
      ],
    },
  } }), res);
  state = await kv.get(kvKey('r1'));
  assert.equal(state.strokes.length, 1);
  assert.equal(state.strokes[0].id, 'good1');
});

test('rejects non-POST methods and malformed bodies', async () => {
  installMocks();
  const handler = freshHandler(ACTION);

  let res = mockRes();
  await handler(mockReq({ method: 'GET' }), res);
  assert.equal(res.statusCode, 405);

  res = mockRes();
  await handler(mockReq({ body: { roomId: 'r1' } }), res); // userId, action.type 없음
  assert.equal(res.statusCode, 400);
});

// 게스트가 만든 방은 아무도 다시 찾아올 수 없으니 방치되면 KV에 영원히 남는다 — 처음
// 만들어질 때 TTL이 걸리고(24시간), 이후 게스트 액션마다 새로 걸려서 활동 중엔 안 지워지는지 확인.
test('a brand-new room created by a guest gets tagged and TTL\'d, refreshed on later guest writes', async () => {
  const { kv } = installMocks();
  const setCalls = [];
  const originalSet = kv.set.bind(kv);
  kv.set = async (k, v, opts) => { setCalls.push({ k, v, opts }); return originalSet(k, v, opts); };
  const handler = freshHandler(ACTION);

  const res1 = mockRes();
  await handler(mockReq({ body: {
    roomId: 'guest-room', userId: 'g1', isGuest: true,
    action: { type: 'stroke_end', strokeId: 's1', stroke: { id: 's1', tool: 'pen', color: '#000000', width: 2, points: [{ x: 1, y: 1 }] } },
  } }), res1);
  assert.equal(res1.statusCode, 200);

  const roomSetCalls = setCalls.filter(c => c.k === kvKey('guest-room'));
  assert.equal(roomSetCalls.length, 1);
  assert.equal(roomSetCalls[0].opts?.ex, 60 * 60 * 24);
  assert.equal(roomSetCalls[0].v._guest, true);

  // 같은 방에 두 번째 게스트 액션 — TTL이 계속 갱신돼야 한다(옵션 없이 set하면 Redis가
  // 기존 TTL을 지워버리므로, 매번 ex를 다시 넘기는지가 핵심).
  const res2 = mockRes();
  await handler(mockReq({ body: {
    roomId: 'guest-room', userId: 'g1', isGuest: true,
    action: { type: 'stroke_end', strokeId: 's2', stroke: { id: 's2', tool: 'pen', color: '#000000', width: 2, points: [{ x: 2, y: 2 }] } },
  } }), res2);
  const secondCall = setCalls.filter(c => c.k === kvKey('guest-room'))[1];
  assert.equal(secondCall.opts?.ex, 60 * 60 * 24);
});

// 게스트가 이미 존재하는(진짜 로그인 사용자의) 방과 같은 이름을 우연히 입력해도,
// 그 기존 방에 만료가 걸려서는 안 된다.
test('a guest writing into a pre-existing room does not get it TTL\'d', async () => {
  const { kv } = installMocks();
  await kv.set(kvKey('real-project'), { strokes: [], notes: [], images: [], shapes: [] });
  const setCalls = [];
  const originalSet = kv.set.bind(kv);
  kv.set = async (k, v, opts) => { setCalls.push({ k, v, opts }); return originalSet(k, v, opts); };
  const handler = freshHandler(ACTION);

  const res = mockRes();
  await handler(mockReq({ body: {
    roomId: 'real-project', userId: 'g1', isGuest: true,
    action: { type: 'stroke_end', strokeId: 's1', stroke: { id: 's1', tool: 'pen', color: '#000000', width: 2, points: [{ x: 1, y: 1 }] } },
  } }), res);

  const call = setCalls.find(c => c.k === kvKey('real-project'));
  assert.equal(call.opts, undefined);
  assert.equal(call.v._guest, undefined);
});

test('todo_add creates a to-do item under the given date, rejects invalid dates/empty text', async () => {
  const { kv } = installMocks();
  const handler = freshHandler(ACTION);

  let res = mockRes();
  await handler(mockReq({ body: {
    roomId: 'r1', userId: 'u1',
    action: { type: 'todo_add', date: '2026-9-18', todo: { id: 't1', text: '  회의 준비  ' } },
  } }), res);
  assert.equal(res.statusCode, 200);
  let state = await kv.get(kvKey('r1'));
  assert.deepEqual(state.todos['2026-9-18'], [{ id: 't1', text: '회의 준비', done: false, userId: 'u1' }]);

  // 날짜 형식이 아니면 조용히 무시(크래시 없이)
  res = mockRes();
  await handler(mockReq({ body: {
    roomId: 'r1', userId: 'u1',
    action: { type: 'todo_add', date: 'not-a-date', todo: { id: 't2', text: 'x' } },
  } }), res);
  assert.equal(res.statusCode, 200);
  state = await kv.get(kvKey('r1'));
  assert.equal(state.todos['not-a-date'], undefined);

  // 공백만 있는 텍스트는 추가되지 않음
  res = mockRes();
  await handler(mockReq({ body: {
    roomId: 'r1', userId: 'u1',
    action: { type: 'todo_add', date: '2026-9-18', todo: { id: 't3', text: '   ' } },
  } }), res);
  state = await kv.get(kvKey('r1'));
  assert.equal(state.todos['2026-9-18'].length, 1);
});

test('todo_toggle flips done, todo_delete removes the item and cleans up the empty date', async () => {
  const { kv } = installMocks();
  await kv.set(kvKey('r1'), {
    strokes: [], notes: [], images: [], shapes: [],
    todos: { '2026-9-18': [{ id: 't1', text: '회의 준비', done: false, userId: 'u1' }] },
  });
  const handler = freshHandler(ACTION);

  let res = mockRes();
  await handler(mockReq({ body: {
    roomId: 'r1', userId: 'u1',
    action: { type: 'todo_toggle', date: '2026-9-18', todoId: 't1' },
  } }), res);
  assert.equal(res.statusCode, 200);
  let state = await kv.get(kvKey('r1'));
  assert.equal(state.todos['2026-9-18'][0].done, true);

  res = mockRes();
  await handler(mockReq({ body: {
    roomId: 'r1', userId: 'u1',
    action: { type: 'todo_delete', date: '2026-9-18', todoId: 't1' },
  } }), res);
  state = await kv.get(kvKey('r1'));
  // 그 날짜에 항목이 하나도 안 남으면 date 키 자체가 정리돼야 한다
  assert.equal(state.todos['2026-9-18'], undefined);
});

// 회귀 테스트: todo_add는 날짜 형식을 검증하지만 todo_toggle/todo_delete는 검증이
// 빠져있었다. state.todos는 평범한 {}라서 date:"__proto__"를 넣으면
// state.todos[date]가 Object.prototype을 반환해(truthy) list.find가 없는 메서드라
// 크래시했다. 셋 다 크래시 없이 조용히 무시되는지 확인한다.
test('todo_toggle/todo_delete reject non-date-shaped "date" values instead of crashing', async () => {
  const { kv } = installMocks();
  await kv.set(kvKey('r1'), { strokes: [], notes: [], images: [], shapes: [], todos: {} });
  const handler = freshHandler(ACTION);

  for (const type of ['todo_toggle', 'todo_delete']) {
    for (const badDate of ['__proto__', 'constructor', 'not-a-date']) {
      const res = mockRes();
      await assert.doesNotReject(handler(mockReq({ body: {
        roomId: 'r1', userId: 'u1',
        action: { type, date: badDate, todoId: 't1' },
      } }), res));
      assert.equal(res.statusCode, 200);
    }
  }
});

// 회귀 테스트: 날짜당 개수 제한에 걸려 조용히 버려지면, 서버는 항상 {ok:true}만 보내서
// 클라이언트가 실패를 알 방법이 없었다. 한도 초과 시 rejected 플래그가 내려오는지 확인.
test('todo_add signals rejection via response body when the per-date cap is hit', async () => {
  const { kv } = installMocks();
  const many = Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, text: `item ${i}`, done: false, userId: 'u1' }));
  await kv.set(kvKey('r1'), { strokes: [], notes: [], images: [], shapes: [], todos: { '2026-9-18': many } });
  const handler = freshHandler(ACTION);

  const res = mockRes();
  await handler(mockReq({ body: {
    roomId: 'r1', userId: 'u1',
    action: { type: 'todo_add', date: '2026-9-18', todo: { id: 't-overflow', text: '넘치는 항목' } },
  } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.rejected, 'todo_limit');
  const state = await kv.get(kvKey('r1'));
  assert.equal(state.todos['2026-9-18'].length, 50); // 추가되지 않아야 함

  // 정상 케이스는 rejected 필드가 아예 없어야 한다(기존 클라이언트 호환)
  const res2 = mockRes();
  await handler(mockReq({ body: {
    roomId: 'r2', userId: 'u1',
    action: { type: 'todo_add', date: '2026-9-18', todo: { id: 't-ok', text: '정상 항목' } },
  } }), res2);
  assert.equal(res2.body.rejected, undefined);
});
