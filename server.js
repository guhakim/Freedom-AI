'use strict';
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const fs   = require('fs');
const path = require('path');
const {
  MAX_STROKES, MAX_NOTE_TEXT, MIN_NOTE_W, MAX_NOTE_W, MIN_NOTE_H, MAX_NOTE_H,
  VALID_COLOR, MAX_IMAGES, MIN_IMG_W, MAX_IMG_W, MIN_IMG_H, MAX_IMG_H,
  MAX_IMG_SRC, VALID_IMG_SRC, MAX_SHAPES, MIN_SHAPE_W, MAX_SHAPE_W, MIN_SHAPE_H, MAX_SHAPE_H,
  VALID_SHAPE_TYPE, VALID_SIDE,
  genId, resolveBinding, applyErasure, bakeForSave,
} = require('./lib/canvasShared');

// ── 검증 상수 (WS 스트리밍 전용, 공유 모듈에는 없음) ──────────────────
const MAX_POINTS_PER_MSG = 500;

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
  if (!s || (!s.strokes?.length && !s.notes?.length && !s.images?.length && !s.shapes?.length)) delete disk[id];
}

let saveTimer;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const out = {};
    // 활성 룸: 콘텐츠가 있는 것만 저장 (지우개 소성 적용)
    for (const [id, r] of rooms) {
      const baked = bakeForSave(r.state);
      if (baked.strokes.length || baked.notes.length || baked.images?.length || baked.shapes?.length) out[id] = baked;
    }
    // 메모리에 없는 룸은 기존 disk 데이터 보존 (단, 비어있으면 제외)
    for (const [id, s] of Object.entries(disk)) {
      if (!rooms.has(id) && (s.strokes?.length || s.notes?.length)) out[id] = s;
    }
    fs.writeFileSync(DATA, JSON.stringify(out));
    disk = { ...out };
  }, 2000);
}

// ── 방 관리 ─────────────────────────────────────────────────────────────
const rooms = new Map(); // roomId → { state, clients: Map<ws, user> }

function getRoom(id) {
  if (!rooms.has(id)) {
    rooms.set(id, {
      state:   disk[id] ?? { strokes: [], notes: [], images: [], shapes: [] },
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

  const rel = path.relative(__dirname, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) { res.writeHead(403); return res.end(); }

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
      if (!VALID_IMG_SRC.test(m.image.src)) return;
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

    // ── 도형 ──────────────────────────────────────────────────────────────
    case 'shape_add': {
      if (!m.shape?.id || !VALID_SHAPE_TYPE.has(m.shape.type)) return;
      if (!room.state.shapes) room.state.shapes = [];
      if (room.state.shapes.find(s => s.id === m.shape.id)) return;
      if (room.state.shapes.length >= MAX_SHAPES) return;
      const color = VALID_COLOR.test(m.shape.color) ? m.shape.color : '#0e0e0d';
      let s;
      if (m.shape.type === 'arrow') {
        const from = resolveBinding(room.state, m.shape.fromId, m.shape.fromSide);
        const to   = resolveBinding(room.state, m.shape.toId,   m.shape.toSide);
        s = {
          id:   m.shape.id, type: 'arrow',
          x1:   typeof m.shape.x1 === 'number' ? m.shape.x1 : 0,
          y1:   typeof m.shape.y1 === 'number' ? m.shape.y1 : 0,
          x2:   typeof m.shape.x2 === 'number' ? m.shape.x2 : 100,
          y2:   typeof m.shape.y2 === 'number' ? m.shape.y2 : 0,
          bend: Math.min(2000, Math.max(-2000, typeof m.shape.bend === 'number' ? m.shape.bend : 0)),
          strokeWidth: Math.min(60, Math.max(1, m.shape.strokeWidth || 6)),
          color, userId: uid,
          fromId: from.id, fromSide: from.side,
          toId:   to.id,   toSide:   to.side,
        };
      } else {
        s = {
          id:   m.shape.id, type: m.shape.type,
          x:    typeof m.shape.x === 'number' ? m.shape.x : 0,
          y:    typeof m.shape.y === 'number' ? m.shape.y : 0,
          w:    Math.min(MAX_SHAPE_W, Math.max(MIN_SHAPE_W, m.shape.w || 160)),
          h:    Math.min(MAX_SHAPE_H, Math.max(MIN_SHAPE_H, m.shape.h || 120)),
          color, userId: uid,
        };
      }
      room.state.shapes.push(s);
      scheduleSave();
      bcast(room, ws, { type: 'shape_add', shape: s });
      break;
    }

    case 'shape_move': {
      if (typeof m.x !== 'number' || typeof m.y !== 'number') return;
      const s = (room.state.shapes || []).find(s => s.id === m.shapeId && (!s.userId || s.userId === uid));
      if (!s || s.type === 'arrow') return;
      s.x = m.x; s.y = m.y;
      scheduleSave();
      bcast(room, ws, { type: 'shape_move', shapeId: m.shapeId, x: s.x, y: s.y });
      break;
    }

    case 'shape_resize': {
      const s = (room.state.shapes || []).find(s => s.id === m.shapeId && (!s.userId || s.userId === uid));
      if (!s || s.type === 'arrow') return;
      s.w = Math.min(MAX_SHAPE_W, Math.max(MIN_SHAPE_W, m.w ?? s.w));
      s.h = Math.min(MAX_SHAPE_H, Math.max(MIN_SHAPE_H, m.h ?? s.h));
      scheduleSave();
      bcast(room, ws, { type: 'shape_resize', shapeId: m.shapeId, w: s.w, h: s.h });
      break;
    }

    case 'shape_arrow_update': {
      const s = (room.state.shapes || []).find(s => s.id === m.shapeId && s.type === 'arrow' && (!s.userId || s.userId === uid));
      if (!s) return;
      if (typeof m.x1 === 'number') s.x1 = m.x1;
      if (typeof m.y1 === 'number') s.y1 = m.y1;
      if (typeof m.x2 === 'number') s.x2 = m.x2;
      if (typeof m.y2 === 'number') s.y2 = m.y2;
      if (typeof m.bend === 'number') s.bend = Math.min(2000, Math.max(-2000, m.bend));
      scheduleSave();
      bcast(room, ws, { type: 'shape_arrow_update', shapeId: m.shapeId, x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, bend: s.bend });
      break;
    }

    case 'shape_delete': {
      if (!room.state.shapes) return;
      const idx = room.state.shapes.findIndex(s => s.id === m.shapeId && (!s.userId || s.userId === uid));
      if (idx === -1) return;
      room.state.shapes.splice(idx, 1);
      scheduleSave();
      bcast(room, ws, { type: 'shape_delete', shapeId: m.shapeId });
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
