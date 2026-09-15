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
