'use strict';

// server.js(로컬 WS 서버)와 api/action.js(프로덕션 서버리스 함수)가 공유하는
// 캔버스 상태 검증 상수·순수 함수. 두 곳에 각자 복사돼 있으면 한쪽만 고쳤을 때
// 로컬/프로덕션 동작이 갈라지므로, 여기 한 곳만 수정하면 양쪽에 반영되게 한다.

const MAX_STROKES  = 1000;
const MAX_NOTE_TEXT = 10_000;
const MIN_NOTE_W = 100, MAX_NOTE_W = 3_000;
const MIN_NOTE_H = 80,  MAX_NOTE_H = 3_000;
const VALID_COLOR = /^#[0-9a-fA-F]{6}$/;
const MAX_IMAGES  = 20;
const MIN_IMG_W = 20, MAX_IMG_W = 3_000;
const MIN_IMG_H = 20, MAX_IMG_H = 3_000;
const MAX_IMG_SRC = 2_000_000;
const VALID_IMG_SRC = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/]+=*$/;
const MAX_SHAPES  = 300;
const MIN_SHAPE_W = 20, MAX_SHAPE_W = 3_000;
const MIN_SHAPE_H = 20, MAX_SHAPE_H = 3_000;
const VALID_SHAPE_TYPE = new Set(['rect', 'ellipse', 'triangle', 'arrow']);
const VALID_SIDE = new Set(['top', 'right', 'bottom', 'left']);

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// 화살표를 노트 가장자리에 연결(binding)할 때, 대상 노트 id/방향이 유효한 경우에만 통과시킨다.
function resolveBinding(state, id, side) {
  if (typeof id !== 'string' || !VALID_SIDE.has(side)) return { id: null, side: null };
  if (!(state.notes || []).some(n => n.id === id)) return { id: null, side: null };
  return { id, side };
}

// 지우개 스트로크가 지나간 점만 제거하고, 남은 구간을 새 스트로크로 분할한다.
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

// 지우개 스트로크를 소성하여 순수 펜 스트로크만 반환 (디스크 저장용, server.js 전용)
function bakeForSave(state) {
  if (!state) return { strokes: [], notes: [], images: [], shapes: [] };
  const erasers = (state.strokes || []).filter(s => s.tool === 'eraser');
  if (!erasers.length) return { ...state, images: state.images || [], shapes: state.shapes || [] };

  let strokes = (state.strokes || []).filter(s => s.tool !== 'eraser');
  for (const eraser of erasers) {
    const r2 = (eraser.width / 2) ** 2;
    strokes = strokes.filter(pen =>
      !pen.points.some(p =>
        eraser.points.some(ep => (p.x - ep.x) ** 2 + (p.y - ep.y) ** 2 <= r2)
      )
    );
  }
  return { strokes, notes: state.notes || [], images: state.images || [], shapes: state.shapes || [] };
}

module.exports = {
  MAX_STROKES, MAX_NOTE_TEXT, MIN_NOTE_W, MAX_NOTE_W, MIN_NOTE_H, MAX_NOTE_H,
  VALID_COLOR, MAX_IMAGES, MIN_IMG_W, MAX_IMG_W, MIN_IMG_H, MAX_IMG_H,
  MAX_IMG_SRC, VALID_IMG_SRC, MAX_SHAPES, MIN_SHAPE_W, MAX_SHAPE_W, MIN_SHAPE_H, MAX_SHAPE_H,
  VALID_SHAPE_TYPE, VALID_SIDE,
  genId, resolveBinding, applyErasure, bakeForSave,
};
