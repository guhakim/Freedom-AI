'use strict';
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const fs   = require('fs');
const path = require('path');

// ── 영속성 ──────────────────────────────────────────────────────────────
const DATA = path.join(__dirname, 'data.json');
let disk = {};
try { disk = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch {}

let saveTimer;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const out = { ...disk };
    for (const [id, r] of rooms) out[id] = r.state;
    fs.writeFileSync(DATA, JSON.stringify(out));
    disk = { ...out };
  }, 2000);
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
      bcast(room, ws, { type: 'cursor', userId: uid, x: m.x, y: m.y });
      break;

    // ── 획 ────────────────────────────────────────────────────────────────
    case 'stroke_start': {
      if (!m.stroke?.id) return;
      const s = { ...m.stroke, userId: uid };
      room.state.strokes.push(s);
      bcast(room, ws, { type: 'stroke_start', stroke: s });
      break;
    }
    case 'stroke_add': {
      const pts = m.points ?? (m.point ? [m.point] : []);
      const s   = room.state.strokes.find(s => s.id === m.strokeId);
      if (s) s.points.push(...pts);
      bcast(room, ws, { type: 'stroke_add', strokeId: m.strokeId, points: pts });
      break;
    }
    case 'stroke_end':
      scheduleSave();
      bcast(room, ws, { type: 'stroke_end', strokeId: m.strokeId });
      break;

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
      if (!m.note?.id) return;
      const n = { ...m.note, userId: uid };
      room.state.notes.push(n);
      scheduleSave();
      bcast(room, ws, { type: 'note_add', note: n });
      break;
    }
    case 'note_move': {
      const n = room.state.notes.find(n => n.id === m.noteId);
      if (n) { n.x = m.x; n.y = m.y; }
      scheduleSave();
      bcast(room, ws, { type: 'note_move', noteId: m.noteId, x: m.x, y: m.y });
      break;
    }
    case 'note_resize': {
      const n = room.state.notes.find(n => n.id === m.noteId);
      if (n) { n.x = m.x; n.w = m.w; n.h = m.h; }
      scheduleSave();
      bcast(room, ws, { type: 'note_resize', noteId: m.noteId, x: m.x, w: m.w, h: m.h });
      break;
    }
    case 'note_text': {
      const n = room.state.notes.find(n => n.id === m.noteId);
      if (n) n.text = m.text;
      scheduleSave();
      bcast(room, ws, { type: 'note_text', noteId: m.noteId, text: m.text });
      break;
    }
    case 'note_delete':
      room.state.notes = room.state.notes.filter(n => n.id !== m.noteId);
      scheduleSave();
      bcast(room, ws, { type: 'note_delete', noteId: m.noteId });
      break;
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
