'use strict';
const Pusher = require('pusher');

async function getKv() {
  try { return require('@vercel/kv').kv; } catch { return null; }
}
async function kvGet(key) {
  try {
    const kv = await getKv();
    if (!kv || !process.env.KV_REST_API_URL) return null;
    return await kv.get(key);
  } catch { return null; }
}
async function kvSet(key, val) {
  try {
    const kv = await getKv();
    if (!kv || !process.env.KV_REST_API_URL) return;
    await kv.set(key, val);
  } catch { /* ignore */ }
}

const MAX_STROKES  = 1000;
const MAX_NOTE_TXT = 10_000;
const MIN_NOTE_W = 100, MAX_NOTE_W = 3_000;
const MIN_NOTE_H = 80,  MAX_NOTE_H = 3_000;
const VALID_COLOR  = /^#[0-9a-fA-F]{6}$/;

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).end();

  const { roomId, userId, socketId, action } = req.body || {};
  if (!roomId || !userId || !action?.type) return res.status(400).json({ error: 'invalid' });

  const pusher  = getPusher();
  const channel = `presence-room-${roomId}`;
  const kvKey   = `fa:room:${roomId}`;
  const excl    = socketId ? { socket_id: socketId } : undefined;

  let state = (await kvGet(kvKey)) || { strokes: [], notes: [] };

  switch (action.type) {

    case 'erase_result': {
      const { deletedIds = [], newStrokes = [] } = action;
      state.strokes = state.strokes.filter(s => !deletedIds.includes(s.id));
      state.strokes.push(...newStrokes.map(s => ({ ...s, userId })));
      await kvSet(kvKey, state);
      for (const id of deletedIds)
        await pusher.trigger(channel, 'stroke_delete', { strokeId: id }, excl);
      for (const ns of newStrokes)
        await pusher.trigger(channel, 'stroke_end', { strokeId: ns.id, stroke: ns }, excl);
      break;
    }

    case 'stroke_end': {
      const { strokeId, stroke } = action;
      if (!stroke) break;

      if (false) { // eraser now handled by erase_result
        break;
      } else {
        if (!state.strokes.find(s => s.id === strokeId)
            && state.strokes.length < MAX_STROKES
            && stroke.tool === 'pen'
            && VALID_COLOR.test(stroke.color)) {
          state.strokes.push({ ...stroke, userId });
        }
        await kvSet(kvKey, state);
        await pusher.trigger(channel, 'stroke_end', { strokeId, stroke }, excl);
      }
      break;
    }

    case 'stroke_undo': {
      const { strokeId } = action;
      const idx = state.strokes.findIndex(s => s.id === strokeId && s.userId === userId);
      if (idx !== -1) {
        state.strokes.splice(idx, 1);
        await kvSet(kvKey, state);
        await pusher.trigger(channel, 'stroke_undo', { strokeId }, excl);
      }
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
        userId,
      };
      state.notes.push(n);
      await kvSet(kvKey, state);
      await pusher.trigger(channel, 'note_add', { note: n }, excl);
      break;
    }

    case 'note_move': {
      if (typeof action.x !== 'number' || typeof action.y !== 'number') break;
      const n = state.notes.find(n => n.id === action.noteId);
      if (!n) break;
      n.x = action.x; n.y = action.y;
      await kvSet(kvKey, state);
      await pusher.trigger(channel, 'note_move', { noteId: action.noteId, x: n.x, y: n.y }, excl);
      break;
    }

    case 'note_resize': {
      const n = state.notes.find(n => n.id === action.noteId);
      if (!n) break;
      if (typeof action.x === 'number') n.x = action.x;
      n.w = Math.min(MAX_NOTE_W, Math.max(MIN_NOTE_W, action.w ?? n.w));
      n.h = Math.min(MAX_NOTE_H, Math.max(MIN_NOTE_H, action.h ?? n.h));
      await kvSet(kvKey, state);
      await pusher.trigger(channel, 'note_resize', { noteId: action.noteId, x: n.x, w: n.w, h: n.h }, excl);
      break;
    }

    case 'note_text': {
      const n = state.notes.find(n => n.id === action.noteId);
      if (!n) break;
      n.text = String(action.text ?? '').slice(0, MAX_NOTE_TXT);
      await kvSet(kvKey, state);
      await pusher.trigger(channel, 'note_text', { noteId: action.noteId, text: n.text }, excl);
      break;
    }

    case 'note_delete': {
      const idx = state.notes.findIndex(
        n => n.id === action.noteId && (!n.userId || n.userId === userId)
      );
      if (idx === -1) break;
      state.notes.splice(idx, 1);
      await kvSet(kvKey, state);
      await pusher.trigger(channel, 'note_delete', { noteId: action.noteId }, excl);
      break;
    }
  }

  res.json({ ok: true });
};
