'use strict';
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const fs   = require('fs');
const path = require('path');

// ── 검증 상수 ────────────────────────────────────────────────────
const MAX_STROKES        = 1000;
const MAX_POINTS_PER_MSG = 500;
const MAX_NOTE_TEXT      = 10_000;
const MIN_NOTE_W = 100, MAX_NOTE_W = 3_000;
const MIN_NOTE_H = 80,  MAX_NOTE_H = 3_000;
const VALID_COLOR = /^#[0-9a-fA-F]{6}$/;
const MAX_IMAGES  = 20;
const MIN_IMG_W = 20, MAX_IMG_W = 3_000;
const MIN_IMG_H = 20, MAX_IMG_H = 3_000;
const MAX_IMG_SRC = 2_000_000;

// ── 영속성 ──────────────────────────────────────────────────────────────
const DATA = path.join(__dirname, 'data.json');
let disk = {};
try { disk = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch {}

// 시작 시 기존 data.json의 지우개 스트로크 일괄 제거
for (const id of Object.keys(disk)) {
  disk[id] = bakeForSave(disk[id]);
}
// 빈 룸 제거
for (const id of Object.keys(disk)) {
  const s = disk[id];
  if (!s || (!s.strokes?.length && !s.notes?.length && !s.images?.length)) delete disk[id];
}

let saveTimer;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const out = {};
    // 활성 룸: 콘텐츠가 있는 것만 저장 (지우개 소성 적용)
    for (const [id, r] of rooms) {
      const baked = bakeForSave(r.state);
      if (baked.strokes.length || baked.notes.length || baked.images?.length) out[id] = baked;
    }
    // 메모리에 없는 룸은 기존 disk 데이터 보존 (단, 비어있으면 제외)
    for (const [id, s] of Object.entries(disk)) {
      if (!rooms.has(id) && (s.strokes?.length || s.notes?.length)) out[id] = s;
    }
    fs.writeFileSync(DATA, JSON.stringify(out));
    disk = { ...out };
  }, 2000);
}

// 지우개 스트로크를 소성하여 순수 펜 스트로크만 반환
function bakeForSave(state) {
  if (!state) return { strokes: [], notes: [], images: [] };
  const erasers = (state.strokes || []).filter(s => s.tool === 'eraser');
  if (!erasers.length) return { ...state, images: state.images || [] };

  let strokes = (state.strokes || []).filter(s => s.tool !== 'eraser');
  for (const eraser of erasers) {
    const r2 = (eraser.width / 2) ** 2;
    strokes = strokes.filter(pen =>
      !pen.points.some(p =>
        eraser.points.some(ep => (p.x - ep.x) ** 2 + (p.y - ep.y) ** 2 <= r2)
      )
    );
  }
  return { strokes, notes: state.notes || [], images: state.images || [] };
}

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2,6); }

// 실시간 지우개 적용: 닿은 점만 제거하고 스트로크를 분할
function applyErasure(state, eraserStroke) {
  const r2 = (eraserStroke.width / 2) ** 2;
  const ePts = eraserStroke.points;
  const deletedIds = [eraserStroke.id];
  const newStrokes = [];

  state.strokes = state.strokes.filter(s => {
    if (s.id === eraserStroke.id) return false;
    if (s.tool === 'eraser') return true;

    const hitMask = s.points.map(p =>
      ePts.some(ep => (p.x - ep.x) ** 2 + (p.y - ep.y) ** 2 <= r2)
    );
    if (!hitMask.some(Boolean)) return true; // 닿지 않음 — 유지

    // 닿은 점 제거 후 연속 구간을 새 스트로크로 분할
    deletedIds.push(s.id);
    let seg = [];
    for (let i = 0; i < s.points.length; i++) {
      if (!hitMask[i]) {
        seg.push(s.points[i]);
      } else {
        if (seg.length >= 1) newStrokes.push({ ...s, id: genId(), points: seg });
        seg = [];
      }
    }
    if (seg.length >= 1) newStrokes.push({ ...s, id: genId(), points: seg });
    return false;
  });

  state.strokes.push(...newStrokes);
  return { deletedIds, newStrokes };
}

// ── 방 관리 ─────────────────────────────────────────────────────────────
const rooms = new Map(); // roomId → { state, clients: Map<ws, user> }

function getRoom(id) {
  if (!rooms.has(id)) {
    rooms.set(id, {
      state:   disk[id] ?? { strokes: [], notes: [] },
      clients: new Map(),
    });
  }
  return rooms.get(id);
}

const COLORS = ['#8b5cf6','#0ea5e9','#ef4444','#22c55e','#f59e0b','#ec4899','#06b6d4','#f97316'];
let colorIdx = 0;

// ── HTTP 정적 서버 ───────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

const httpServer = http.createServer((req, res) => {
  const urlPath  = req.url.split('?')[0];
  const filePath = path.join(__dirname, urlPath === '/' ? 'index.html' : urlPath);

  if (!filePath.startsWith(__dirname)) { res.writeHead(403); return res.end(); }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const mime = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

// ── WebSocket ────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  const q      = new URL(req.url, 'http://x').searchParams;
  const roomId = (q.get('room') || 'default').slice(0, 32);
  const name   = (q.get('name') || '익명').slice(0, 20);
  const userId = Math.random().toString(36).slice(2, 10);
  const color  = COLORS[colorIdx++ % COLORS.length];

  const room = getRoom(roomId);
  const user = { id: userId, name, color };
  room.clients.set(ws, user);

  // 입장: 초기 상태 + 현재 접속자 목록 전송
  send(ws, {
    type:  'init',
    userId, color,
    state: room.state,
    users: [...room.clients.values()].filter(u => u.id !== userId),
  });
  bcast(room, ws, { type: 'user_join', ...user });

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const u = room.clients.get(ws); if (!u) return;
    handle(m, u, room, ws);
  });

  ws.on('close', () => {
    room.clients.delete(ws);
    bcast(room, null, { type: 'user_leave', userId });
    if (!room.clients.size) {
      // 마지막 사용자 퇴장 시 지우개 소성 후 저장
      const baked = bakeForSave(room.state);
      room.state.strokes = baked.strokes;
      scheduleSave();
      setTimeout(() => { if (!rooms.get(roomId)?.clients.size) rooms.delete(roomId); }, 60_000);
    }
  });

  ws.on('error', e => console.error('ws error:', e.message));
});

function handle(m, user, room, ws) {
  const uid = user.id;

  switch (m.type) {

    // ── 커서 ──────────────────────────────────────────────────────────────
    case 'cursor':
      if (typeof m.x !== 'number' || typeof m.y !== 'number') return;
      bcast(room, ws, { type: 'cursor', userId: uid, x: m.x, y: m.y });
      break;

    // ── 획 ────────────────────────────────────────────────────────────────
    case 'stroke_start': {
      if (typeof m.stroke?.id !== 'string' || !m.stroke.id) return;
      if (!['pen', 'eraser'].includes(m.stroke.tool)) return;
      if (typeof m.stroke.width !== 'number' || m.stroke.width <= 0 || m.stroke.width > 200) return;
      if (m.stroke.tool === 'pen' && !VALID_COLOR.test(m.stroke.color)) return;
      if (room.state.strokes.length >= MAX_STROKES) return;

      const s = {
        id:     m.stroke.id,
        tool:   m.stroke.tool,
        color:  m.stroke.color,
        width:  m.stroke.width,
        points: Array.isArray(m.stroke.points) ? m.stroke.points.slice(0, 10) : [],
        userId: uid,
      };
      room.state.strokes.push(s);
      bcast(room, ws, { type: 'stroke_start', stroke: s });
      break;
    }
    case 'stroke_add': {
      const rawPts = m.points ?? (m.point ? [m.point] : []);
      const pts = rawPts
        .slice(0, MAX_POINTS_PER_MSG)
        .filter(p => typeof p?.x === 'number' && typeof p?.y === 'number');
      if (!pts.length) return;
      const s = room.state.strokes.find(s => s.id === m.strokeId);
      if (s) s.points.push(...pts);
      bcast(room, ws, { type: 'stroke_add', strokeId: m.strokeId, points: pts });
      break;
    }
    case 'stroke_end': {
      const s = room.state.strokes.find(s => s.id === m.strokeId);
      if (s?.tool === 'eraser') {
        const { deletedIds, newStrokes } = applyErasure(room.state, s);
        scheduleSave();
        for (const id of deletedIds) {
          bcast(room, null, { type: 'stroke_delete', strokeId: id });
        }
        // 분할된 조각 스트로크를 모든 클라이언트에 전송
        for (const ns of newStrokes) {
          bcast(room, null, { type: 'stroke_start', stroke: ns });
          bcast(room, null, { type: 'stroke_end', strokeId: ns.id });
        }
      } else {
        scheduleSave();
        bcast(room, ws, { type: 'stroke_end', strokeId: m.strokeId });
      }
      break;
    }

    case 'stroke_undo': {
      for (let i = room.state.strokes.length - 1; i >= 0; i--) {
        if (room.state.strokes[i].userId === uid) {
          const [rm] = room.state.strokes.splice(i, 1);
          scheduleSave();
          bcast(room, ws, { type: 'stroke_undo', strokeId: rm.id });
          break;
        }
      }
      break;
    }

    // ── 포스트잇 ──────────────────────────────────────────────────────────
    case 'note_add': {
      if (typeof m.note?.id !== 'string' || !m.note.id) return;
      const n = {
        id:     m.note.id,
        x:      typeof m.note.x === 'number' ? m.note.x : 0,
        y:      typeof m.note.y === 'number' ? m.note.y : 0,
        w:      Math.min(MAX_NOTE_W, Math.max(MIN_NOTE_W, m.note.w || 160)),
        h:      Math.min(MAX_NOTE_H, Math.max(MIN_NOTE_H, m.note.h || 130)),
        color:  VALID_COLOR.test(m.note.color) ? m.note.color : '#fef08a',
        text:   String(m.note.text || '').slice(0, MAX_NOTE_TEXT),
        userId: uid,
      };
      room.state.notes.push(n);
      scheduleSave();
      bcast(room, ws, { type: 'note_add', note: n });
      break;
    }
    case 'note_move': {
      if (typeof m.x !== 'number' || typeof m.y !== 'number') return;
      const n = room.state.notes.find(n => n.id === m.noteId);
      if (!n) return;
      n.x = m.x; n.y = m.y;
      scheduleSave();
      bcast(room, ws, { type: 'note_move', noteId: m.noteId, x: m.x, y: m.y });
      break;
    }
    case 'note_resize': {
      const n = room.state.notes.find(n => n.id === m.noteId);
      if (n) {
        n.x = typeof m.x === 'number' ? m.x : n.x;
        n.w = Math.min(MAX_NOTE_W, Math.max(MIN_NOTE_W, m.w ?? n.w));
        n.h = Math.min(MAX_NOTE_H, Math.max(MIN_NOTE_H, m.h ?? n.h));
        scheduleSave();
        bcast(room, ws, { type: 'note_resize', noteId: m.noteId, x: n.x, w: n.w, h: n.h });
      }
      break;
    }
    case 'note_text': {
      const n = room.state.notes.find(n => n.id === m.noteId);
      if (n) {
        n.text = String(m.text ?? '').slice(0, MAX_NOTE_TEXT);
        scheduleSave();
        bcast(room, ws, { type: 'note_text', noteId: m.noteId, text: n.text });
      }
      break;
    }
    case 'note_delete': {
      // userId 없는 구버전 노트 포함, 본인 노트만 삭제 가능
      const idx = room.state.notes.findIndex(
        n => n.id === m.noteId && (!n.userId || n.userId === uid)
      );
      if (idx !== -1) {
        room.state.notes.splice(idx, 1);
        scheduleSave();
        bcast(room, ws, { type: 'note_delete', noteId: m.noteId });
      }
      break;
    }

    // ── 이미지 ──────────────────────────────────────────────────────────
    case 'image_add': {
      if (!m.image?.id) return;
      if (!room.state.images) room.state.images = [];
      if (room.state.images.find(i => i.id === m.image.id)) return;
      if (room.state.images.length >= MAX_IMAGES) return;
      if (typeof m.image.src !== 'string' || m.image.src.length > MAX_IMG_SRC) return;
      if (!m.image.src.startsWith('data:image/')) return;
      const img = {
        id:     m.image.id,
        src:    m.image.src,
        x:      typeof m.image.x === 'number' ? m.image.x : 0,
        y:      typeof m.image.y === 'number' ? m.image.y : 0,
        w:      Math.min(MAX_IMG_W, Math.max(MIN_IMG_W, m.image.w || 200)),
        h:      Math.min(MAX_IMG_H, Math.max(MIN_IMG_H, m.image.h || 200)),
        userId: uid,
      };
      room.state.images.push(img);
      scheduleSave();
      bcast(room, ws, { type: 'image_add', ...img });
      break;
    }

    case 'image_move': {
      if (typeof m.x !== 'number' || typeof m.y !== 'number') return;
      const img = (room.state.images || []).find(i => i.id === m.imageId && (!i.userId || i.userId === uid));
      if (!img) return;
      img.x = m.x; img.y = m.y;
      scheduleSave();
      bcast(room, ws, { type: 'image_move', imageId: m.imageId, x: img.x, y: img.y });
      break;
    }

    case 'image_resize': {
      const img = (room.state.images || []).find(i => i.id === m.imageId && (!i.userId || i.userId === uid));
      if (!img) return;
      img.w = Math.min(MAX_IMG_W, Math.max(MIN_IMG_W, m.w ?? img.w));
      img.h = Math.min(MAX_IMG_H, Math.max(MIN_IMG_H, m.h ?? img.h));
      if (typeof m.x === 'number') img.x = m.x;
      scheduleSave();
      bcast(room, ws, { type: 'image_resize', imageId: m.imageId, x: img.x, w: img.w, h: img.h });
      break;
    }

    case 'image_delete': {
      if (!room.state.images) return;
      const idx = room.state.images.findIndex(i => i.id === m.imageId && (!i.userId || i.userId === uid));
      if (idx === -1) return;
      room.state.images.splice(idx, 1);
      scheduleSave();
      bcast(room, ws, { type: 'image_delete', imageId: m.imageId });
      break;
    }
  }
}

// ── 유틸 ────────────────────────────────────────────────────────────────
function send(ws, m) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}
function bcast(room, skipWs, m) {
  const s = JSON.stringify(m);
  room.clients.forEach((_, ws) => {
    if (ws !== skipWs && ws.readyState === WebSocket.OPEN) ws.send(s);
  });
}

// ── 시작 ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`\n🎨  Freedom AI`);
  console.log(`    http://localhost:${PORT}\n`);
});
