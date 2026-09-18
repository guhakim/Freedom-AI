'use strict';
const Pusher = require('pusher');

async function getKv() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  try { return require('@vercel/kv').kv; } catch { return null; }
}
async function kvGet(key) {
  try {
    const kv = await getKv();
    if (!kv || !process.env.KV_REST_API_URL) return null;
    return await kv.get(key);
  } catch { return null; }
}
async function kvSet(key, val, opts) {
  try {
    const kv = await getKv();
    if (!kv || !process.env.KV_REST_API_URL) return;
    await kv.set(key, val, opts);
  } catch { /* ignore */ }
}

// 게스트가 만든 방은 계정에 귀속되지 않아 아무도 다시 찾아올 수 없으므로, 방치되면 KV에
// 영원히 남는다. 게스트 액션으로 쓸 때마다 TTL을 새로 걸어(마지막 활동 기준 24시간 후 자동
// 삭제) 실제 사용 중에는 안 지워지되 방치된 방은 정리되게 한다. (kv.set은 ex 옵션 없이 쓰면
// Redis 기본 동작상 기존 TTL을 지우므로, 로그인 사용자가 같은 방을 쓰면 TTL이 자연히 해제된다.)
const GUEST_ROOM_TTL_SECONDS = 60 * 60 * 24;

// 토큰→이메일 검증 결과를 짧게 캐싱한다. 비공개 방에서는 그리기 액션마다 checkAccess가 호출되는데,
// 매번 Google userinfo API를 왕복하면 획 하나 그릴 때마다 지연이 생긴다.
// (서버리스 인스턴스가 재사용될 때만 유효 — 완벽한 보장은 아니고, 어디까지나 흔한 "연속 액션" 구간을 빠르게 만드는 용도)
const verifyCache = new Map(); // token -> { email, exp }
const VERIFY_CACHE_TTL = 5 * 60 * 1000;

async function verifyToken(token) {
  const cached = verifyCache.get(token);
  if (cached && cached.exp > Date.now()) return cached.email;
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const info = await r.json();
    if (typeof info.email !== 'string') return null;
    const email = info.email.toLowerCase();
    verifyCache.set(token, { email, exp: Date.now() + VERIFY_CACHE_TTL });
    return email;
  } catch { return null; }
}

// 방이 비공개로 전환된 경우(팀 초대를 한 번이라도 발급한 방) 멤버인지 검증.
// 아직 비공개 전환 안 된(레거시 오픈) 방은 지금까지처럼 누구나 액션 가능.
async function checkAccess(kv, req, roomId, email) {
  if (!kv) return true;
  const members = await kv.get(`fa:room:${roomId}:members`);
  if (!members) return true;
  if (!email) return false;
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return false;
  const verifiedEmail = await verifyToken(token);
  if (!verifiedEmail || verifiedEmail !== email.toLowerCase()) return false;
  return members.map(m => String(m).toLowerCase()).includes(email.toLowerCase());
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

// 룸 단위 락: 동시 요청이 같은 룸 상태를 읽고-수정하고-쓰는 과정에서
// 서로를 덮어써 스트로크/포스트잇 등이 유실되는 것을 방지한다.
async function acquireRoomLock(kv, kvKey) {
  if (!kv) return false;
  const lockKey = `${kvKey}:lock`;
  for (let i = 0; i < 20; i++) {
    try {
      const ok = await kv.set(lockKey, '1', { nx: true, ex: 5 });
      if (ok) return lockKey;
    } catch { return false; } // 락 자체가 실패하면 락 없이 진행 (가용성 우선)
    await new Promise(r => setTimeout(r, 40 + Math.random() * 60));
  }
  return false; // 경합이 심해 확보 실패 — 락 없이 진행 (최선 노력)
}
async function releaseRoomLock(kv, lockKey) {
  if (!lockKey) return;
  try { await kv.del(lockKey); } catch { /* ignore */ }
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
  if (!roomId || !userId || !action?.type) return res.status(400).json({ error: 'invalid' });

  const pusher  = getPusher();
  const channel = `presence-room-${toChannelSafe(roomId)}`;
  const kvKey   = `fa:room:${roomId}`;
  const excl    = socketId ? { socket_id: socketId } : undefined;

  const kv = await getKv();
  if (!(await checkAccess(kv, req, roomId, email))) return res.status(403).json({ error: 'access_denied' });
  const lockKey = await acquireRoomLock(kv, kvKey);
  try {

  const existingState = await kvGet(kvKey);
  let state = existingState || { strokes: [], notes: [], images: [], shapes: [] };
  if (!state.strokes) state.strokes = [];
  if (!state.notes)   state.notes   = [];
  if (!state.images)  state.images  = [];
  if (!state.shapes)  state.shapes  = [];
  if (!state.todos)   state.todos   = {};

  // 이 요청으로 방이 처음 생기는 것이고 게스트가 만든 것이면 표시해 둔다. 이미 존재하던
  // 방(진짜 로그인 사용자의 프로젝트일 수 있음)에는 절대 새로 붙이지 않는다 — 그래야 게스트가
  // 우연히 같은 이름을 입력해도 기존 방에 만료가 걸리는 일이 없다.
  if (existingState === null && isGuest) state._guest = true;
  const kvSetOpts = state._guest ? { ex: GUEST_ROOM_TTL_SECONDS } : undefined;

  switch (action.type) {

    case 'erase_result': {
      const { deletedIds, newStrokes } = action;
      if (!Array.isArray(deletedIds) || !Array.isArray(newStrokes)) break;

      const ids = deletedIds.filter(id => typeof id === 'string');
      // 지우개로 잘린 조각들도 stroke_end와 동일한 기준(펜 도구, 유효한 색상/좌표)으로
      // 검증한다 — 이 검증이 없으면 조작된 요청으로 MAX_STROKES 제한을 우회하거나
      // 저장 상태에 임의 필드를 주입할 수 있었다.
      const valid = newStrokes
        .filter(s => s && typeof s.id === 'string' && s.tool === 'pen'
          && VALID_COLOR.test(s.color) && typeof s.width === 'number' && s.width > 0 && s.width <= 100
          && Array.isArray(s.points))
        .map(s => ({
          id: s.id, tool: 'pen', color: s.color, width: s.width, userId,
          points: s.points.slice(0, 5000).filter(p => typeof p?.x === 'number' && typeof p?.y === 'number'),
        }))
        .filter(s => s.points.length);

      state.strokes = state.strokes.filter(s => !ids.includes(s.id));
      const room = Math.max(0, MAX_STROKES - state.strokes.length);
      const toAdd = valid.slice(0, room);
      state.strokes.push(...toAdd);
      await kvSet(kvKey, state, kvSetOpts);
      for (const id of ids)
        await pusher.trigger(channel, 'stroke_delete', { strokeId: id }, excl);
      for (const ns of toAdd)
        await pusher.trigger(channel, 'stroke_end', { strokeId: ns.id, stroke: ns }, excl);
      break;
    }

    case 'stroke_end': {
      const { strokeId, stroke } = action;
      if (!stroke) break;

      if (!state.strokes.find(s => s.id === strokeId)
          && state.strokes.length < MAX_STROKES
          && stroke.tool === 'pen'
          && VALID_COLOR.test(stroke.color)) {
        state.strokes.push({ ...stroke, userId });
      }
      await kvSet(kvKey, state, kvSetOpts);
      await pusher.trigger(channel, 'stroke_end', { strokeId, stroke }, excl);
      break;
    }

    case 'stroke_undo': {
      const { strokeId } = action;
      const idx = state.strokes.findIndex(s => s.id === strokeId && s.userId === userId);
      if (idx !== -1) {
        state.strokes.splice(idx, 1);
        await kvSet(kvKey, state, kvSetOpts);
        await pusher.trigger(channel, 'stroke_undo', { strokeId }, excl);
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
      await pusher.trigger(channel, 'stroke_delete', { strokeId }, excl);
      break;
    }

    // 선택 도구로 획 이동 — 삭제와 마찬가지로 소유자 상관없이 이동 가능 (지우개와 동일 정책).
    // 새로고침·재접속 시 되돌아가지 않도록 서버에 새 좌표를 영속화한다.
    case 'stroke_move': {
      const { strokeId, points } = action;
      if (!Array.isArray(points)) break;
      const s = state.strokes.find(s => s.id === strokeId);
      if (!s) break;
      const pts = points.slice(0, 5000).filter(p => typeof p?.x === 'number' && typeof p?.y === 'number');
      if (!pts.length) break;
      s.points = pts;
      await kvSet(kvKey, state, kvSetOpts);
      await pusher.trigger(channel, 'stroke_move', { strokeId, points: pts }, excl);
      break;
    }

    case 'note_add': {
      const { note } = action;
      if (!note?.id || state.notes.find(n => n.id === note.id)) break;
      const n = {
        id:     note.id,
        x:      typeof note.x === 'number' ? note.x : 0,
        y:      typeof note.y === 'number' ? note.y : 0,
        w:      Math.min(MAX_NOTE_W, Math.max(MIN_NOTE_W, note.w || 160)),
        h:      Math.min(MAX_NOTE_H, Math.max(MIN_NOTE_H, note.h || 130)),
        color:  VALID_COLOR.test(note.color) ? note.color : '#fef08a',
        text:   String(note.text || '').slice(0, MAX_NOTE_TXT),
        fontSize: typeof note.fontSize === 'number' ? Math.min(MAX_NOTE_FONT, Math.max(MIN_NOTE_FONT, note.fontSize)) : 13,
        userId,
      };
      state.notes.push(n);
      await kvSet(kvKey, state, kvSetOpts);
      await pusher.trigger(channel, 'note_add', { note: n }, excl);
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
      await pusher.trigger(channel, 'note_move', { noteId: action.noteId, x: n.x, y: n.y }, excl);
      break;
    }

    case 'note_resize': {
      const n = state.notes.find(n => n.id === action.noteId);
      if (!n) break;
      if (typeof action.x === 'number') n.x = action.x;
      n.w = Math.min(MAX_NOTE_W, Math.max(MIN_NOTE_W, action.w ?? n.w));
      n.h = Math.min(MAX_NOTE_H, Math.max(MIN_NOTE_H, action.h ?? n.h));
      await kvSet(kvKey, state, kvSetOpts);
      await pusher.trigger(channel, 'note_resize', { noteId: action.noteId, x: n.x, w: n.w, h: n.h }, excl);
      break;
    }

    case 'note_font_size': {
      const n = state.notes.find(n => n.id === action.noteId);
      if (!n || typeof action.fontSize !== 'number') break;
      n.fontSize = Math.min(MAX_NOTE_FONT, Math.max(MIN_NOTE_FONT, action.fontSize));
      await kvSet(kvKey, state, kvSetOpts);
      await pusher.trigger(channel, 'note_font_size', { noteId: action.noteId, fontSize: n.fontSize }, excl);
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
      await pusher.trigger(channel, 'note_text', { noteId: action.noteId, text: n.text }, excl);
      break;
    }

    case 'note_delete': {
      const idx = state.notes.findIndex(n => n.id === action.noteId);
      if (idx === -1) break;
      state.notes.splice(idx, 1);
      await kvSet(kvKey, state, kvSetOpts);
      await pusher.trigger(channel, 'note_delete', { noteId: action.noteId }, excl);
      break;
    }

    case 'image_add': {
      const { image } = action;
      if (!image?.id) break;
      if (!state.images) state.images = [];
      if (state.images.find(i => i.id === image.id)) break;
      if (state.images.length >= MAX_IMAGES) break;
      if (typeof image.src !== 'string' || image.src.length > MAX_IMG_SRC) break;
      if (!VALID_IMG_SRC.test(image.src)) break;
      const img = {
        id:     image.id,
        src:    image.src,
        x:      typeof image.x === 'number' ? image.x : 0,
        y:      typeof image.y === 'number' ? image.y : 0,
        w:      Math.min(MAX_IMG_W, Math.max(MIN_IMG_W, image.w || 200)),
        h:      Math.min(MAX_IMG_H, Math.max(MIN_IMG_H, image.h || 200)),
        z:      typeof image.z === 'number' ? image.z : 0,
        userId,
      };
      state.images.push(img);
      await kvSet(kvKey, state, kvSetOpts);
      // src는 Pusher 10KB 한도를 초과하므로 메타데이터만 전송, 수신 측은 /api/room에서 fetch
      await pusher.trigger(channel, 'image_add', { id: img.id, x: img.x, y: img.y, w: img.w, h: img.h, userId }, excl);
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
      await pusher.trigger(channel, 'image_move', { imageId: action.imageId, x: img.x, y: img.y }, excl);
      break;
    }

    case 'image_resize': {
      if (!state.images) break;
      const img = state.images.find(i => i.id === action.imageId);
      if (!img) break;
      img.w = Math.min(MAX_IMG_W, Math.max(MIN_IMG_W, action.w ?? img.w));
      img.h = Math.min(MAX_IMG_H, Math.max(MIN_IMG_H, action.h ?? img.h));
      if (typeof action.x === 'number') img.x = action.x;
      await kvSet(kvKey, state, kvSetOpts);
      await pusher.trigger(channel, 'image_resize', { imageId: action.imageId, x: img.x, w: img.w, h: img.h }, excl);
      break;
    }

    case 'image_delete': {
      if (!state.images) break;
      const idx = state.images.findIndex(i => i.id === action.imageId);
      if (idx === -1) break;
      state.images.splice(idx, 1);
      await kvSet(kvKey, state, kvSetOpts);
      await pusher.trigger(channel, 'image_delete', { imageId: action.imageId }, excl);
      break;
    }

    // AI 변환/배경제거로 기존 이미지의 픽셀 내용(src)만 교체 — 위치/크기는 그대로.
    case 'image_update': {
      if (!state.images) break;
      const { imageId, src, bgRemoved } = action;
      const img = state.images.find(i => i.id === imageId);
      if (!img) break;
      if (typeof src !== 'string' || src.length > MAX_IMG_SRC || !VALID_IMG_SRC.test(src)) break;
      img.src = src;
      // 배경 제거 결과인지 표시해둬야, 새로고침/재동기화 후에도 클라이언트가
      // 투명 배경 이미지의 사각형 그림자를 계속 숨길 수 있다.
      if (typeof bgRemoved === 'boolean') img.bgRemoved = bgRemoved;
      await kvSet(kvKey, state, kvSetOpts);
      // src는 image_add와 같은 이유로 Pusher 10KB 한도를 넘으므로 id만 알리고,
      // 수신 측은 /api/room에서 새 src를 가져온다.
      await pusher.trigger(channel, 'image_update', { imageId }, excl);
      break;
    }

    case 'image_reorder': {
      if (!state.images) break;
      const { imageId, z } = action;
      const img = state.images.find(i => i.id === imageId);
      if (!img || typeof z !== 'number' || !Number.isFinite(z)) break;
      img.z = Math.min(1_000_000, Math.max(-1_000_000, z));
      await kvSet(kvKey, state, kvSetOpts);
      await pusher.trigger(channel, 'image_reorder', { imageId, z: img.z }, excl);
      break;
    }

    case 'shape_add': {
      const { shape } = action;
      if (!shape?.id) break;
      if (!state.shapes) state.shapes = [];
      if (state.shapes.find(s => s.id === shape.id)) break;
      if (state.shapes.length >= MAX_SHAPES) break;
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
          bend: Math.min(2000, Math.max(-2000, typeof shape.bend === 'number' ? shape.bend : 0)),
          strokeWidth: Math.min(60, Math.max(1, shape.strokeWidth || 6)),
          color, userId,
          fromId: from.id, fromSide: from.side,
          toId:   to.id,   toSide:   to.side,
        };
      } else {
        s = {
          id:   shape.id, type: shape.type,
          x:    typeof shape.x === 'number' ? shape.x : 0,
          y:    typeof shape.y === 'number' ? shape.y : 0,
          w:    Math.min(MAX_SHAPE_W, Math.max(MIN_SHAPE_W, shape.w || 160)),
          h:    Math.min(MAX_SHAPE_H, Math.max(MIN_SHAPE_H, shape.h || 120)),
          color, userId,
        };
      }
      state.shapes.push(s);
      await kvSet(kvKey, state, kvSetOpts);
      await pusher.trigger(channel, 'shape_add', { shape: s }, excl);
      break;
    }

    case 'shape_move': {
      if (typeof action.x !== 'number' || typeof action.y !== 'number') break;
      if (!state.shapes) break;
      const s = state.shapes.find(s => s.id === action.shapeId);
      if (!s || s.type === 'arrow') break;
      s.x = action.x; s.y = action.y;
      await kvSet(kvKey, state, kvSetOpts);
      await pusher.trigger(channel, 'shape_move', { shapeId: action.shapeId, x: s.x, y: s.y }, excl);
      break;
    }

    case 'shape_resize': {
      if (!state.shapes) break;
      const s = state.shapes.find(s => s.id === action.shapeId);
      if (!s || s.type === 'arrow') break;
      s.w = Math.min(MAX_SHAPE_W, Math.max(MIN_SHAPE_W, action.w ?? s.w));
      s.h = Math.min(MAX_SHAPE_H, Math.max(MIN_SHAPE_H, action.h ?? s.h));
      await kvSet(kvKey, state, kvSetOpts);
      await pusher.trigger(channel, 'shape_resize', { shapeId: action.shapeId, w: s.w, h: s.h }, excl);
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
      if (typeof action.bend === 'number') s.bend = Math.min(2000, Math.max(-2000, action.bend));
      await kvSet(kvKey, state, kvSetOpts);
      await pusher.trigger(channel, 'shape_arrow_update', { shapeId: action.shapeId, x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, bend: s.bend }, excl);
      break;
    }

    case 'shape_delete': {
      if (!state.shapes) break;
      const idx = state.shapes.findIndex(s => s.id === action.shapeId);
      if (idx === -1) break;
      state.shapes.splice(idx, 1);
      await kvSet(kvKey, state, kvSetOpts);
      await pusher.trigger(channel, 'shape_delete', { shapeId: action.shapeId }, excl);
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
      if (state.todos[date].length >= MAX_TODOS_PER_DATE) break;
      const t = { id: todo.id, text, done: false, userId };
      state.todos[date].push(t);
      await kvSet(kvKey, state, kvSetOpts);
      await pusher.trigger(channel, 'todo_add', { date, todo: t }, excl);
      break;
    }

    case 'todo_toggle': {
      const { date, todoId } = action;
      const list = state.todos[date];
      if (!list) break;
      const t = list.find(t => t.id === todoId);
      if (!t) break;
      t.done = !t.done;
      await kvSet(kvKey, state, kvSetOpts);
      await pusher.trigger(channel, 'todo_toggle', { date, todoId, done: t.done }, excl);
      break;
    }

    case 'todo_delete': {
      const { date, todoId } = action;
      const list = state.todos[date];
      if (!list) break;
      const idx = list.findIndex(t => t.id === todoId);
      if (idx === -1) break;
      list.splice(idx, 1);
      if (!list.length) delete state.todos[date];
      await kvSet(kvKey, state, kvSetOpts);
      await pusher.trigger(channel, 'todo_delete', { date, todoId }, excl);
      break;
    }
  }

  res.json({ ok: true });
  } finally {
    await releaseRoomLock(kv, lockKey);
  }
};
