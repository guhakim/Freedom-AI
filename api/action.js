'use strict';
const Pusher = require('pusher');
const { isValidRoomId, checkAccess, verifyEmail, acquireRoomLock, releaseRoomLock } = require('../lib/auth');

async function getKv() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  try { return require('@vercel/kv').kv; } catch { return null; }
}
// KV 읽기/쓰기 에러는 삼키지 않는다 — 예전엔 일시적인 읽기 실패를 "빈 방"으로 착각해
// 빈 상태 + 새 항목 하나로 방 전체를 덮어써 버릴 수 있었다. 에러는 핸들러에서 500으로 돌려준다.
async function kvGet(key) {
  const kv = await getKv();
  if (!kv || !process.env.KV_REST_API_URL) return null;
  return await kv.get(key);
}
async function kvSet(key, val, opts) {
  const kv = await getKv();
  if (!kv || !process.env.KV_REST_API_URL) return;
  await kv.set(key, val, opts);
}

// 게스트가 만든 방은 계정에 귀속되지 않아 아무도 다시 찾아올 수 없으므로, 방치되면 KV에
// 영원히 남는다. 게스트 액션으로 쓸 때마다 TTL을 새로 걸어(마지막 활동 기준 24시간 후 자동
// 삭제) 실제 사용 중에는 안 지워지되 방치된 방은 정리되게 한다. (kv.set은 ex 옵션 없이 쓰면
// Redis 기본 동작상 기존 TTL을 지우므로, 로그인 사용자가 같은 방을 쓰면 TTL이 자연히 해제된다.)
const GUEST_ROOM_TTL_SECONDS = 60 * 60 * 24;

// userId는 획·노트·이미지 등 모든 객체에 그대로 저장된다. 예전엔 빈 문자열만 걸러서,
// 10만 자짜리 userId도 통과해 방 상태를 부풀릴 수 있었다(결국 kv.set이 실패해 그 방
// 사용자 전원이 500을 받는다). api/join.js·api/pusher-auth.js처럼 길이를 제한한다.
// 문자셋까지 강제하지는 않는다 — 예전 버전이 발급한 userId를 들고 있는 클라이언트가
// 갑자기 400을 받으면 그 사람의 삭제·이동이 전부 서버에 반영되지 않는다.
// 이 방을 쓴 로그인 사용자 목록의 상한 (방 상태가 무한정 커지지 않게)
const MAX_CONTRIBUTORS = 50;

const MAX_USERID = 64;
function isValidUserId(userId) {
  return typeof userId === 'string' && userId.length > 0 && userId.length <= MAX_USERID
    && !/[\u0000-\u001f]/.test(userId);
}

const MAX_STROKES  = 1000;
const MAX_NOTE_TXT = 10_000;
const MIN_NOTE_W = 100, MAX_NOTE_W = 3_000;
const MIN_NOTE_H = 80,  MAX_NOTE_H = 3_000;
const MIN_NOTE_FONT = 10, MAX_NOTE_FONT = 32;
const VALID_COLOR  = /^#[0-9a-fA-F]{6}$/;
const MAX_IMAGES   = 20;
const MIN_IMG_W = 20, MAX_IMG_W = 3_000;
const MIN_IMG_H = 20, MAX_IMG_H = 3_000;
const MAX_IMG_SRC  = 2_000_000;
const VALID_IMG_SRC = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/]+=*$/;
const MAX_SHAPES   = 300;
const MIN_SHAPE_W = 20, MAX_SHAPE_W = 3_000;
const MIN_SHAPE_H = 20, MAX_SHAPE_H = 3_000;
const VALID_SHAPE_TYPE = new Set(['rect', 'ellipse', 'triangle', 'arrow']);
const VALID_SIDE = new Set(['top', 'right', 'bottom', 'left']);
const MAX_TODO_TEXT = 200;
const MAX_TODOS_PER_DATE = 50;
// 한 번에 묶을 수 있는 최대 항목 수 — Pusher 이벤트 10KB 한도 안에 id 목록이 들어가게 한다
const MAX_GROUP_IDS = 200;
const MAX_NOTES = 1000;
const VALID_DATE_KEY = /^\d{4}-\d{1,2}-\d{1,2}$/;

// 화살표를 노트 가장자리에 연결(binding)할 때, 대상 노트 id/방향이 유효한 경우에만 통과시킨다.
function resolveBinding(state, id, side) {
  if (typeof id !== 'string' || !VALID_SIDE.has(side)) return { id: null, side: null };
  if (!(state.notes || []).some(n => n.id === id)) return { id: null, side: null };
  return { id, side };
}

let _pusher;
function getPusher() {
  if (!_pusher) _pusher = new Pusher({
    appId:   process.env.PUSHER_APP_ID,
    key:     process.env.PUSHER_KEY,
    secret:  process.env.PUSHER_SECRET,
    cluster: process.env.PUSHER_CLUSTER,
    useTLS:  true,
  });
  return _pusher;
}

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2,6); }

// Pusher 채널 이름은 영문/숫자와 _-=@,.; 만 허용한다. roomId는 사용자가 입력한 임의의
// 문자열(한글 등 포함)이라 그대로 쓰면 Pusher 인증이 서버 에러로 죽어 실시간 기능이 전혀
// 동작하지 않는다 — app.html의 toChannelSafe()와 반드시 동일한 인코딩을 써야 한다.
function toChannelSafe(str) {
  return Buffer.from(str, 'utf8').toString('base64url');
}

// 룸 단위 락은 lib/auth.js로 옮겼다 — api/rename-room.js가 같은 락을 써야 이름 변경과
// 액션이 서로 끼어들지 않는다. (예전엔 action.js 안에만 있어서 이름 변경이 락을 무시했다)

// Pusher 이벤트는 10KB가 한도라, 넘으면 trigger가 예외를 던져 요청 전체가 500이 되고
// 다른 사용자에겐 변경이 전달되지 않았다(긴 획·긴 노트 텍스트). 크기를 넘으면 내용 대신
// room_resync 신호만 보내 받는 쪽이 /api/room에서 다시 읽게 한다. 이미 KV에는 저장된
// 뒤이므로 전송 실패가 요청 실패로 이어지지 않게 로그만 남긴다.
const PUSHER_MAX_BYTES = 9000;
async function safeTrigger(pusher, channel, event, data, excl) {
  try {
    const big = Buffer.byteLength(JSON.stringify(data)) > PUSHER_MAX_BYTES;
    await pusher.trigger(channel, big ? 'room_resync' : event, big ? { reason: event } : data, excl);
  } catch (e) { console.error('pusher trigger failed', event, e?.message); }
}

// 좌표·크기는 반드시 이걸로 검사한다. typeof만 보면 Infinity·NaN이 통과하는데, 그 값은
// KV에 JSON으로 저장되는 순간 null이 되어 항목이 화면에서 깨진다(위치를 잃거나 사라진다).
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const validGroupId = g => (typeof g === 'string' && g.length > 0 && g.length <= 40) ? g : undefined;
const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 64;

// 펜 획 하나를 저장 가능한 형태로 정리 (stroke_end·erase_result 공통). 유효하지 않으면 null.
function sanitizeStroke(s, userId) {
  if (!s || !validId(s.id) || s.tool !== 'pen' || !VALID_COLOR.test(s.color)
      || !isNum(s.width) || s.width <= 0 || s.width > 100 || !Array.isArray(s.points)) return null;
  const points = s.points.slice(0, 5000).filter(p => isNum(p?.x) && isNum(p?.y)).map(p => ({ x: p.x, y: p.y }));
  if (!points.length) return null;
  const out = { id: s.id, tool: 'pen', color: s.color, width: s.width, userId, points };
  const g = validGroupId(s.groupId);
  if (g) out.groupId = g;
  return out;
}

function applyErasure(state, eraserStroke) {
  const r2   = (eraserStroke.width / 2) ** 2;
  const ePts = eraserStroke.points;
  const deletedIds = [eraserStroke.id];
  const newStrokes = [];

  state.strokes = state.strokes.filter(s => {
    if (s.id === eraserStroke.id) return false;
    if (s.tool === 'eraser')      return true;
    const hitMask = s.points.map(p =>
      ePts.some(ep => (p.x-ep.x)**2 + (p.y-ep.y)**2 <= r2)
    );
    if (!hitMask.some(Boolean)) return true;
    deletedIds.push(s.id);
    let seg = [];
    for (let i = 0; i < s.points.length; i++) {
      if (!hitMask[i]) { seg.push(s.points[i]); }
      else { if (seg.length) newStrokes.push({ ...s, id:genId(), points:seg }); seg = []; }
    }
    if (seg.length) newStrokes.push({ ...s, id:genId(), points:seg });
    return false;
  });
  state.strokes.push(...newStrokes);
  return { deletedIds, newStrokes };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).end();

  const { roomId, userId, socketId, action, email, isGuest } = req.body || {};
  if (!isValidRoomId(roomId) || !isValidUserId(userId) || typeof action?.type !== 'string') return res.status(400).json({ error: 'invalid' });

  const pusher  = getPusher();
  const channel = `presence-room-${toChannelSafe(roomId)}`;
  const kvKey   = `fa:room:${roomId}`;
  const excl    = socketId ? { socket_id: socketId } : undefined;

  const trigger = (event, data) => safeTrigger(pusher, channel, event, data, excl);

  const kv = await getKv();
  let lock = null;
  try {
    if (!(await checkAccess(kv, req, roomId, email))) return res.status(403).json({ error: 'access_denied' });
    if (kv && process.env.KV_REST_API_URL) {
      lock = await acquireRoomLock(kv, kvKey);
      if (!lock) return res.status(503).json({ error: 'busy' });
    }
  } catch (e) {
    console.error('action pre', e);
    return res.status(500).json({ error: 'server_error' });
  }
  try {

  const existingState = await kvGet(kvKey);
  let state = existingState || { strokes: [], notes: [], images: [], shapes: [] };
  if (!state.strokes) state.strokes = [];
  if (!state.notes)   state.notes   = [];
  if (!state.images)  state.images  = [];
  if (!state.shapes)  state.shapes  = [];
  if (!state.todos)   state.todos   = {};
  // 특정 액션이 유효성 검사에 걸려 조용히 무시된 경우(예: 날짜당 할 일 개수 한도 초과)를
  // 클라이언트에 알려주기 위한 값. 기본은 null(정상 처리)이고, 아래 각 case에서 필요할 때만 채운다.
  let rejected = null;

  // 이 요청으로 방이 처음 생기는 것이고 게스트가 만든 것이면 표시해 둔다. 이미 존재하던
  // 방(진짜 로그인 사용자의 프로젝트일 수 있음)에는 절대 새로 붙이지 않는다 — 그래야 게스트가
  // 우연히 같은 이름을 입력해도 기존 방에 만료가 걸리는 일이 없다.
  if (existingState === null && isGuest) state._guest = true;
  // 방을 만든 사람은 처음 한 번만 기록한다. 한때 "비어 있으면 뒤늦게라도 채운다"고 했었는데,
  // 그러면 주인이 없는 방(이 기능 이전에 만들어진 방, 게스트가 만든 방)에 **아무 로그인
  // 사용자나 먼저 한 글자 쓰면 주인이 되어** 원래 쓰던 사람을 비공개 전환으로 쫓아낼 수
  // 있었다. 주인이 누구인지 모르는 방은 추측하지 않는다.
  if (existingState === null && !isGuest && typeof email === 'string' && email
      && await verifyEmail(req, email)) {
    state.createdBy = email.toLowerCase();
  }

  // 대신 "이 방을 실제로 쓴 로그인 사용자" 목록을 남긴다. 주인을 정하기 위한 게 아니라,
  // 나중에 누가 이 방을 비공개로 바꿔도 함께 쓰던 사람들이 멤버로 들어가 쫓겨나지 않게
  // 하기 위한 것이다 (api/team.js). 이메일이라 방에 들어온 사람에게는 내려보내지 않는다.
  if (!isGuest && typeof email === 'string' && email && await verifyEmail(req, email)) {
    const me = email.toLowerCase();
    const list = Array.isArray(state.contributors) ? state.contributors : [];
    if (!list.includes(me) && list.length < MAX_CONTRIBUTORS) list.push(me);
    state.contributors = list;
  }

  // 로그인한 클라이언트가 쓰는 방이면 게스트 만료를 해제한다. 토큰 검증 성공에 묶어두면,
  // 토큰이 만료된 1시간 뒤부터는 검증이 실패해 24시간 TTL이 매 쓰기마다 다시 걸리고
  // 하루만 쉬어도 방이 통째로 사라진다 — 바로 그 경우를 고치려던 수정이었다.
  if (!isGuest) delete state._guest;
  const kvSetOpts = state._guest ? { ex: GUEST_ROOM_TTL_SECONDS } : undefined;

  switch (action.type) {

    case 'erase_result': {
      const { deletedIds, newStrokes } = action;
      if (!Array.isArray(deletedIds) || !Array.isArray(newStrokes)) break;

      const ids = deletedIds.filter(id => typeof id === 'string').slice(0, MAX_STROKES);
      // 지우개로 잘린 조각들도 stroke_end와 동일한 기준(펜 도구, 유효한 색상/좌표)으로
      // 검증한다 — 이 검증이 없으면 조작된 요청으로 MAX_STROKES 제한을 우회하거나
      // 저장 상태에 임의 필드를 주입할 수 있었다.
      // (그룹에 속한 획이 잘려도 조각들이 그룹을 유지하도록 groupId도 보존)
      const valid = newStrokes.slice(0, MAX_STROKES).map(s => sanitizeStroke(s, userId)).filter(Boolean);

      state.strokes = state.strokes.filter(s => !ids.includes(s.id));
      const room = Math.max(0, MAX_STROKES - state.strokes.length);
      const toAdd = valid.slice(0, room);
      state.strokes.push(...toAdd);
      await kvSet(kvKey, state, kvSetOpts);
      // 조각이 많으면 이벤트를 수십~수천 개 보내는 대신 다시 읽으라는 신호 하나만 보낸다
      if (ids.length + toAdd.length > 20) {
        await trigger('room_resync', { reason: 'erase_result' });
      } else {
        for (const id of ids)
          await trigger('stroke_delete', { strokeId: id });
        for (const ns of toAdd)
          await trigger('stroke_end', { strokeId: ns.id, stroke: ns });
      }
      break;
    }

    case 'stroke_end': {
      // 저장한 것과 똑같은 정리된 획만 저장·전송한다 — 예전엔 클라이언트가 보낸 객체를 임의
      // 필드·무제한 점 개수 그대로 저장했고, 한도 초과 등으로 저장을 거부한 획도 그대로 전파했다.
      const { strokeId } = action;
      const stroke = sanitizeStroke(action.stroke, userId);
      if (!stroke || stroke.id !== strokeId || state.strokes.find(s => s.id === strokeId)) break;
      if (state.strokes.length >= MAX_STROKES) { rejected = 'stroke_limit'; break; }
      state.strokes.push(stroke);
      await kvSet(kvKey, state, kvSetOpts);
      await trigger('stroke_end', { strokeId, stroke });
      break;
    }

    case 'stroke_undo': {
      const { strokeId } = action;
      const idx = state.strokes.findIndex(s => s.id === strokeId && s.userId === userId);
      if (idx !== -1) {
        state.strokes.splice(idx, 1);
        await kvSet(kvKey, state, kvSetOpts);
        await trigger('stroke_undo', { strokeId });
      }
      break;
    }

    // 선택 도구로 획 삭제 — 지우개 도구와 동일하게 소유자 상관없이 삭제 가능.
    // (userId는 클라이언트가 자체 생성해 보내는 값이라 진짜 신원 증명이 아니고,
    //  지우개로는 어차피 아무 획이나 지울 수 있어 소유권 체크가 실질적 의미가 없었음)
    case 'stroke_manual_delete': {
      const { strokeId } = action;
      const idx = state.strokes.findIndex(s => s.id === strokeId);
      if (idx === -1) break;
      state.strokes.splice(idx, 1);
      await kvSet(kvKey, state, kvSetOpts);
      await trigger('stroke_delete', { strokeId });
      break;
    }

    // 선택 도구로 획 이동 — 삭제와 마찬가지로 소유자 상관없이 이동 가능 (지우개와 동일 정책).
    // 새로고침·재접속 시 되돌아가지 않도록 서버에 새 좌표를 영속화한다.
    case 'stroke_move': {
      const { strokeId, points } = action;
      if (!Array.isArray(points)) break;
      const s = state.strokes.find(s => s.id === strokeId);
      if (!s) break;
      const pts = points.slice(0, 5000).filter(p => isNum(p?.x) && isNum(p?.y)).map(p => ({ x: p.x, y: p.y }));
      if (!pts.length) break;
      s.points = pts;
      await kvSet(kvKey, state, kvSetOpts);
      await trigger('stroke_move', { strokeId, points: pts });
      break;
    }

    case 'note_add': {
      const { note } = action;
      if (!validId(note?.id) || state.notes.find(n => n.id === note.id)) break;
      if (state.notes.length >= MAX_NOTES) { rejected = 'note_limit'; break; }
      const n = {
        id:     note.id,
        x:      isNum(note.x) ? note.x : 0,
        y:      isNum(note.y) ? note.y : 0,
        w:      Math.min(MAX_NOTE_W, Math.max(MIN_NOTE_W, note.w || 160)),
        h:      Math.min(MAX_NOTE_H, Math.max(MIN_NOTE_H, note.h || 130)),
        color:  VALID_COLOR.test(note.color) ? note.color : '#fef08a',
        text:   String(note.text || '').slice(0, MAX_NOTE_TXT),
        fontSize: isNum(note.fontSize) ? Math.min(MAX_NOTE_FONT, Math.max(MIN_NOTE_FONT, note.fontSize)) : 13,
        userId,
      };
      if (validGroupId(note.groupId)) n.groupId = note.groupId; // 실행 취소로 복원할 때 그룹 유지
      state.notes.push(n);
      await kvSet(kvKey, state, kvSetOpts);
      await trigger('note_add', { note: n });
      break;
    }

    // 노트 이동/크기조절/삭제 — 획(select 도구)과 동일하게 소유자 상관없이 가능.
    // userId는 클라이언트가 자체 생성하는 값이라 신원 증명이 아니고, 새로고침 전
    // 세션에서 만든(옛 랜덤 userId) 노트는 지금 세션의 고정 clientId와 절대 일치하지
    // 않아 이 체크가 있으면 영구히 삭제/이동이 안 되는 노트가 생긴다.
    case 'note_move': {
      if (typeof action.x !== 'number' || typeof action.y !== 'number') break;
      const n = state.notes.find(n => n.id === action.noteId);
      if (!n) break;
      n.x = action.x; n.y = action.y;
      await kvSet(kvKey, state, kvSetOpts);
      await trigger('note_move', { noteId: action.noteId, x: n.x, y: n.y });
      break;
    }

    case 'note_resize': {
      const n = state.notes.find(n => n.id === action.noteId);
      if (!n) break;
      if (isNum(action.x)) n.x = action.x;
      if (isNum(action.y)) n.y = action.y;
      if (isNum(action.w)) n.w = Math.min(MAX_NOTE_W, Math.max(MIN_NOTE_W, action.w));
      if (isNum(action.h)) n.h = Math.min(MAX_NOTE_H, Math.max(MIN_NOTE_H, action.h));
      await kvSet(kvKey, state, kvSetOpts);
      await trigger('note_resize', { noteId: action.noteId, x: n.x, y: n.y, w: n.w, h: n.h });
      break;
    }

    case 'note_font_size': {
      const n = state.notes.find(n => n.id === action.noteId);
      if (!n || typeof action.fontSize !== 'number') break;
      n.fontSize = Math.min(MAX_NOTE_FONT, Math.max(MIN_NOTE_FONT, action.fontSize));
      await kvSet(kvKey, state, kvSetOpts);
      await trigger('note_font_size', { noteId: action.noteId, fontSize: n.fontSize });
      break;
    }

    case 'note_text': {
      // 텍스트 편집은 생성자 제한 없이 누구나 가능(협업 노트 취지) — server.js(로컬 개발 서버)와 동일하게 맞춤.
      // note_move/resize/delete와 달리 여기 userId 제한을 걸면, UI(contenteditable)는 편집을 허용해놓고
      // 서버가 조용히 저장·전파를 막아 "내가 쓴 글씨가 상대방에게 안 보이는" 버그가 된다.
      const n = state.notes.find(n => n.id === action.noteId);
      if (!n) break;
      n.text = String(action.text ?? '').slice(0, MAX_NOTE_TXT);
      await kvSet(kvKey, state, kvSetOpts);
      await trigger('note_text', { noteId: action.noteId, text: n.text });
      break;
    }

    case 'note_delete': {
      const idx = state.notes.findIndex(n => n.id === action.noteId);
      if (idx === -1) break;
      state.notes.splice(idx, 1);
      await kvSet(kvKey, state, kvSetOpts);
      await trigger('note_delete', { noteId: action.noteId });
      break;
    }

    case 'image_add': {
      const { image } = action;
      if (!validId(image?.id)) break;
      if (!state.images) state.images = [];
      if (state.images.find(i => i.id === image.id)) break;
      // 한도·크기 초과를 조용히 버리면 클라이언트는 이미 화면에 그려놓은 채 ok를 받아,
      // 새로고침이나 room_resync 때 그 이미지만 흔적 없이 사라졌다. 거절 사유를 돌려준다.
      if (state.images.length >= MAX_IMAGES) { rejected = 'image_limit'; break; }
      if (typeof image.src !== 'string' || image.src.length > MAX_IMG_SRC) { rejected = 'image_too_large'; break; }
      if (!VALID_IMG_SRC.test(image.src)) break;
      const img = {
        id:     image.id,
        src:    image.src,
        x:      isNum(image.x) ? image.x : 0,
        y:      isNum(image.y) ? image.y : 0,
        w:      Math.min(MAX_IMG_W, Math.max(MIN_IMG_W, image.w || 200)),
        h:      Math.min(MAX_IMG_H, Math.max(MIN_IMG_H, image.h || 200)),
        z:      isNum(image.z) ? image.z : 0,
        userId,
      };
      if (validGroupId(image.groupId)) img.groupId = image.groupId;
      if (image.bgRemoved === true) img.bgRemoved = true; // 실행 취소로 되살린 배경 제거 이미지
      state.images.push(img);
      await kvSet(kvKey, state, kvSetOpts);
      // src는 Pusher 10KB 한도를 초과하므로 메타데이터만 전송, 수신 측은 /api/room에서 fetch
      await trigger('image_add', { id: img.id, x: img.x, y: img.y, w: img.w, h: img.h, userId });
      break;
    }

    // 이미지/도형 이동·크기조절·삭제도 노트/획과 동일하게 소유자 무관 정책으로 통일.
    case 'image_move': {
      if (typeof action.x !== 'number' || typeof action.y !== 'number') break;
      if (!state.images) break;
      const img = state.images.find(i => i.id === action.imageId);
      if (!img) break;
      img.x = action.x; img.y = action.y;
      await kvSet(kvKey, state, kvSetOpts);
      await trigger('image_move', { imageId: action.imageId, x: img.x, y: img.y });
      break;
    }

    case 'image_resize': {
      if (!state.images) break;
      const img = state.images.find(i => i.id === action.imageId);
      if (!img) break;
      if (isNum(action.w)) img.w = Math.min(MAX_IMG_W, Math.max(MIN_IMG_W, action.w));
      if (isNum(action.h)) img.h = Math.min(MAX_IMG_H, Math.max(MIN_IMG_H, action.h));
      if (isNum(action.x)) img.x = action.x;
      if (isNum(action.y)) img.y = action.y;
      await kvSet(kvKey, state, kvSetOpts);
      await trigger('image_resize', { imageId: action.imageId, x: img.x, y: img.y, w: img.w, h: img.h });
      break;
    }

    case 'image_delete': {
      if (!state.images) break;
      const idx = state.images.findIndex(i => i.id === action.imageId);
      if (idx === -1) break;
      state.images.splice(idx, 1);
      await kvSet(kvKey, state, kvSetOpts);
      await trigger('image_delete', { imageId: action.imageId });
      break;
    }

    // AI 변환/배경제거로 기존 이미지의 픽셀 내용(src)만 교체 — 위치/크기는 그대로.
    case 'image_update': {
      if (!state.images) break;
      const { imageId, src, bgRemoved } = action;
      const img = state.images.find(i => i.id === imageId);
      if (!img) break;
      if (typeof src !== 'string' || !VALID_IMG_SRC.test(src)) break;
      // 너무 크면 조용히 버리지 말고 알려준다 — 예전엔 성공으로 응답해서, 배경 제거한 결과가
      // 저장되지 않은 채 새로고침하면 원본으로 돌아왔다
      if (src.length > MAX_IMG_SRC) { rejected = 'image_too_large'; break; }
      img.src = src;
      // 배경 제거 결과인지 표시해둬야, 새로고침/재동기화 후에도 클라이언트가
      // 투명 배경 이미지의 사각형 그림자를 계속 숨길 수 있다.
      if (typeof bgRemoved === 'boolean') img.bgRemoved = bgRemoved;
      await kvSet(kvKey, state, kvSetOpts);
      // src는 image_add와 같은 이유로 Pusher 10KB 한도를 넘으므로 id만 알리고,
      // 수신 측은 /api/room에서 새 src를 가져온다.
      await trigger('image_update', { imageId });
      break;
    }

    case 'image_reorder': {
      if (!state.images) break;
      const { imageId, z } = action;
      const img = state.images.find(i => i.id === imageId);
      if (!img || typeof z !== 'number' || !Number.isFinite(z)) break;
      img.z = Math.min(1_000_000, Math.max(-1_000_000, z));
      await kvSet(kvKey, state, kvSetOpts);
      await trigger('image_reorder', { imageId, z: img.z });
      break;
    }

    case 'shape_add': {
      const { shape } = action;
      if (!shape?.id) break;
      if (!state.shapes) state.shapes = [];
      if (state.shapes.find(s => s.id === shape.id)) break;
      // image_add와 같은 이유로, 한도 초과는 조용히 버리지 않고 사유를 알린다.
      if (state.shapes.length >= MAX_SHAPES) { rejected = 'shape_limit'; break; }
      if (!VALID_SHAPE_TYPE.has(shape.type)) break;
      const color = VALID_COLOR.test(shape.color) ? shape.color : '#0e0e0d';
      let s;
      if (shape.type === 'arrow') {
        const from = resolveBinding(state, shape.fromId, shape.fromSide);
        const to   = resolveBinding(state, shape.toId,   shape.toSide);
        s = {
          id:   shape.id, type: 'arrow',
          x1:   typeof shape.x1 === 'number' ? shape.x1 : 0,
          y1:   typeof shape.y1 === 'number' ? shape.y1 : 0,
          x2:   typeof shape.x2 === 'number' ? shape.x2 : 100,
          y2:   typeof shape.y2 === 'number' ? shape.y2 : 0,
          bend: Math.min(2000, Math.max(-2000, isNum(shape.bend) ? shape.bend : 0)),
          strokeWidth: Math.min(60, Math.max(1, shape.strokeWidth || 6)),
          color, userId,
          fromId: from.id, fromSide: from.side,
          toId:   to.id,   toSide:   to.side,
        };
      } else {
        s = {
          id:   shape.id, type: shape.type,
          x:    isNum(shape.x) ? shape.x : 0,
          y:    isNum(shape.y) ? shape.y : 0,
          w:    Math.min(MAX_SHAPE_W, Math.max(MIN_SHAPE_W, shape.w || 160)),
          h:    Math.min(MAX_SHAPE_H, Math.max(MIN_SHAPE_H, shape.h || 120)),
          color, userId,
        };
      }
      if (validGroupId(shape.groupId)) s.groupId = shape.groupId;
      state.shapes.push(s);
      await kvSet(kvKey, state, kvSetOpts);
      await trigger('shape_add', { shape: s });
      break;
    }

    case 'shape_move': {
      if (typeof action.x !== 'number' || typeof action.y !== 'number') break;
      if (!state.shapes) break;
      const s = state.shapes.find(s => s.id === action.shapeId);
      if (!s || s.type === 'arrow') break;
      s.x = action.x; s.y = action.y;
      await kvSet(kvKey, state, kvSetOpts);
      await trigger('shape_move', { shapeId: action.shapeId, x: s.x, y: s.y });
      break;
    }

    case 'shape_resize': {
      if (!state.shapes) break;
      const s = state.shapes.find(s => s.id === action.shapeId);
      if (!s || s.type === 'arrow') break;
      if (isNum(action.w)) s.w = Math.min(MAX_SHAPE_W, Math.max(MIN_SHAPE_W, action.w));
      if (isNum(action.h)) s.h = Math.min(MAX_SHAPE_H, Math.max(MIN_SHAPE_H, action.h));
      // 그룹 크기 조절은 위치도 함께 바뀐다 (개별 리사이즈 핸들은 x/y를 안 보낸다)
      if (isNum(action.x)) s.x = action.x;
      if (isNum(action.y)) s.y = action.y;
      await kvSet(kvKey, state, kvSetOpts);
      await trigger('shape_resize', { shapeId: action.shapeId, x: s.x, y: s.y, w: s.w, h: s.h });
      break;
    }

    case 'shape_arrow_update': {
      if (!state.shapes) break;
      const s = state.shapes.find(s => s.id === action.shapeId && s.type === 'arrow');
      if (!s) break;
      if (typeof action.x1 === 'number') s.x1 = action.x1;
      if (typeof action.y1 === 'number') s.y1 = action.y1;
      if (typeof action.x2 === 'number') s.x2 = action.x2;
      if (typeof action.y2 === 'number') s.y2 = action.y2;
      if (isNum(action.bend)) s.bend = Math.min(2000, Math.max(-2000, action.bend));
      // 화살표 끝을 노트에서 떼어내면 연결도 풀어야 한다 — 예전엔 연결 정보가 남아 있어서
      // 그 노트가 움직이거나 새로고침하면 화살표가 원래 자리로 되돌아갔다
      if ('fromId' in action) { const b = resolveBinding(state, action.fromId, action.fromSide); s.fromId = b.id; s.fromSide = b.side; }
      if ('toId' in action)   { const b = resolveBinding(state, action.toId, action.toSide);     s.toId = b.id;   s.toSide = b.side; }
      await kvSet(kvKey, state, kvSetOpts);
      await trigger('shape_arrow_update', { shapeId: action.shapeId, x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, bend: s.bend,
        fromId: s.fromId, fromSide: s.fromSide, toId: s.toId, toSide: s.toSide });
      break;
    }

    case 'shape_delete': {
      if (!state.shapes) break;
      const idx = state.shapes.findIndex(s => s.id === action.shapeId);
      if (idx === -1) break;
      state.shapes.splice(idx, 1);
      await kvSet(kvKey, state, kvSetOpts);
      await trigger('shape_delete', { shapeId: action.shapeId });
      break;
    }

    // 선택한 여러 항목의 위치·크기를 한 번에 저장 (선택 이동·그룹 크기 조절). 예전엔 항목마다
    // 요청을 따로 보내 서로 락을 다투다 일부가 조용히 유실됐다 — 한 번 읽고 한 번 쓴다.
    case 'items_update': {
      const { items } = action;
      if (!Array.isArray(items) || !items.length || items.length > MAX_GROUP_IDS) break;
      const applied = [];
      for (const u of items) {
        if (!u || !validId(u.id)) continue;
        const n = state.notes.find(x => x.id === u.id);
        if (n) {
          if (isNum(u.x)) n.x = u.x; if (isNum(u.y)) n.y = u.y;
          if (isNum(u.w)) n.w = Math.min(MAX_NOTE_W, Math.max(MIN_NOTE_W, u.w));
          if (isNum(u.h)) n.h = Math.min(MAX_NOTE_H, Math.max(MIN_NOTE_H, u.h));
          applied.push({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h });
          continue;
        }
        const img = state.images.find(x => x.id === u.id);
        if (img) {
          if (isNum(u.x)) img.x = u.x; if (isNum(u.y)) img.y = u.y;
          if (isNum(u.w)) img.w = Math.min(MAX_IMG_W, Math.max(MIN_IMG_W, u.w));
          if (isNum(u.h)) img.h = Math.min(MAX_IMG_H, Math.max(MIN_IMG_H, u.h));
          applied.push({ id: img.id, x: img.x, y: img.y, w: img.w, h: img.h });
          continue;
        }
        const sh = state.shapes.find(x => x.id === u.id);
        if (sh) {
          if (sh.type === 'arrow') {
            if (isNum(u.x1)) sh.x1 = u.x1; if (isNum(u.y1)) sh.y1 = u.y1;
            if (isNum(u.x2)) sh.x2 = u.x2; if (isNum(u.y2)) sh.y2 = u.y2;
            if (isNum(u.bend)) sh.bend = Math.min(2000, Math.max(-2000, u.bend));
            applied.push({ id: sh.id, x1: sh.x1, y1: sh.y1, x2: sh.x2, y2: sh.y2, bend: sh.bend });
          } else {
            if (isNum(u.x)) sh.x = u.x; if (isNum(u.y)) sh.y = u.y;
            if (isNum(u.w)) sh.w = Math.min(MAX_SHAPE_W, Math.max(MIN_SHAPE_W, u.w));
            if (isNum(u.h)) sh.h = Math.min(MAX_SHAPE_H, Math.max(MIN_SHAPE_H, u.h));
            applied.push({ id: sh.id, x: sh.x, y: sh.y, w: sh.w, h: sh.h });
          }
          continue;
        }
        const st = state.strokes.find(x => x.id === u.id);
        if (st && Array.isArray(u.points)) {
          const pts = u.points.slice(0, 5000).filter(p => isNum(p?.x) && isNum(p?.y)).map(p => ({ x: p.x, y: p.y }));
          if (pts.length) { st.points = pts; applied.push({ id: st.id, points: pts }); }
        }
      }
      if (!applied.length) break;
      await kvSet(kvKey, state, kvSetOpts);
      await trigger('items_update', { items: applied }); // 10KB를 넘으면 room_resync로 대체된다
      break;
    }

    // 선택 도구로 고른 항목들을 그룹으로 묶거나(groupId 문자열) 풀기(null).
    // 그룹에 속한 항목은 하나만 클릭해도 그룹 전체가 함께 선택된다.
    case 'group_set': {
      const { ids, groupId } = action;
      if (!Array.isArray(ids) || !ids.length || ids.length > MAX_GROUP_IDS) break;
      if (groupId !== null && (typeof groupId !== 'string' || !groupId || groupId.length > 40)) break;
      const idSet = new Set(ids.filter(id => typeof id === 'string'));
      const applied = [];
      for (const list of [state.notes, state.images, state.shapes, state.strokes]) {
        for (const item of list) {
          if (!idSet.has(item.id)) continue;
          if (groupId) item.groupId = groupId; else delete item.groupId;
          applied.push(item.id);
        }
      }
      if (!applied.length) break;
      await kvSet(kvKey, state, kvSetOpts);
      await trigger('group_set', { ids: applied, groupId });
      break;
    }

    // 캘린더에서 날짜별로 적는 To-Do 목록. date는 "YYYY-M-D" 형식 키 문자열 하나당
    // 항목 배열을 들고 있다(다른 컬렉션들처럼 room state 안에 함께 저장·동기화됨).
    case 'todo_add': {
      const { date, todo } = action;
      if (!VALID_DATE_KEY.test(date)) break;
      if (!todo?.id || typeof todo.text !== 'string') break;
      const text = todo.text.trim().slice(0, MAX_TODO_TEXT);
      if (!text) break;
      if (!state.todos[date]) state.todos[date] = [];
      if (state.todos[date].find(t => t.id === todo.id)) break;
      if (state.todos[date].length >= MAX_TODOS_PER_DATE) { rejected = 'todo_limit'; break; }
      const t = { id: todo.id, text, done: false, userId };
      state.todos[date].push(t);
      await kvSet(kvKey, state, kvSetOpts);
      await trigger('todo_add', { date, todo: t });
      break;
    }

    case 'todo_toggle': {
      const { date, todoId } = action;
      if (!VALID_DATE_KEY.test(date)) break;
      const list = state.todos[date];
      if (!list) break;
      const t = list.find(t => t.id === todoId);
      if (!t) break;
      // 원하는 값을 받아 그대로 설정 — 서버에서 뒤집기만 하면 두 사람이 동시에 체크했을 때
      // 서버는 두 번 뒤집혀 '안 함'이 되고 각 클라이언트 화면은 서로 다른 값으로 남았다
      t.done = typeof action.done === 'boolean' ? action.done : !t.done;
      await kvSet(kvKey, state, kvSetOpts);
      await trigger('todo_toggle', { date, todoId, done: t.done });
      break;
    }

    case 'todo_delete': {
      const { date, todoId } = action;
      if (!VALID_DATE_KEY.test(date)) break;
      const list = state.todos[date];
      if (!list) break;
      const idx = list.findIndex(t => t.id === todoId);
      if (idx === -1) break;
      list.splice(idx, 1);
      if (!list.length) delete state.todos[date];
      await kvSet(kvKey, state, kvSetOpts);
      await trigger('todo_delete', { date, todoId });
      break;
    }
  }

  res.json(rejected ? { ok: true, rejected } : { ok: true });
  } catch (e) {
    console.error('action', action.type, e);
    res.status(500).json({ error: 'server_error' });
  } finally {
    await releaseRoomLock(kv, lock);
  }
};
