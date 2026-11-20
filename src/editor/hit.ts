import type { Dim, ID, Item, Label, Level, Pt, Sel, Shape } from '../core/model';
import { add, dist, mul, perp, pointInPoly, projSeg, rotate, sub, unit } from '../core/geom';
import { openingFrames, type Room, type WallGeom } from '../core/topology';
import { itemCorners } from '../core/scene';
import { store } from '../core/store';

export function itemLocal(it: Item, p: Pt): Pt {
  const q = rotate(p, (-it.rot * Math.PI) / 180, { x: it.x, y: it.y });
  return { x: q.x - it.x, y: q.y - it.y };
}

export function labelBox(l: Label, annot: number): { w: number; h: number } {
  const h = l.size * annot;
  return { w: Math.max(h, l.text.length * h * 0.56), h: h * 1.3 };
}

export function dimLine(d: Dim): { q1: Pt; q2: Pt; n: Pt } {
  const p1 = { x: d.x1, y: d.y1 }, p2 = { x: d.x2, y: d.y2 };
  const n = perp(unit(sub(p2, p1)));
  return { q1: add(p1, mul(n, d.offset)), q2: add(p2, mul(n, d.offset)), n };
}

export function shapeDist(s: Shape, p: Pt): number {
  if (s.kind === 'circle' || s.kind === 'arc') return Math.abs(Math.hypot(p.x - s.pts[0], p.y - s.pts[1]) - (s.r || 0));
  if (s.kind === 'text') {
    const h = s.h || 0.2, w = (s.text || '').length * h * 0.56;
    const q = rotate(p, -(s.rot || 0), { x: s.pts[0], y: s.pts[1] });
    const x0 = s.pts[0] + (s.align === 'c' ? -w / 2 : s.align === 'r' ? -w : 0);
    const dx = Math.max(x0 - q.x, 0, q.x - (x0 + w)), dy = Math.max(s.pts[1] - h / 2 - q.y, 0, q.y - (s.pts[1] + h / 2));
    return Math.hypot(dx, dy);
  }
  let d = Infinity;
  const n = s.pts.length;
  for (let i = 0; i + 3 < n; i += 2) d = Math.min(d, projSeg(p, { x: s.pts[i], y: s.pts[i + 1] }, { x: s.pts[i + 2], y: s.pts[i + 3] }).d);
  if (s.closed && n >= 6) d = Math.min(d, projSeg(p, { x: s.pts[n - 2], y: s.pts[n - 1] }, { x: s.pts[0], y: s.pts[1] }).d);
  return d;
}

/** Devuelve lo que hay bajo el cursor, de lo más específico a lo más general. */
export function hitTest(level: Level, d: { rooms: Room[]; geoms: Map<ID, WallGeom> }, p: Pt, zoom: number, annot: number): Sel | null {
  const L = store.project.settings.layers;
  const px = (n: number) => n / zoom;
  if (L.walls) {
    let best: { id: ID; d: number } | null = null;
    for (const n of level.nodes) { const dd = dist(n, p); if (dd < px(9) && (!best || dd < best.d)) best = { id: n.id, d: dd }; }
    if (best) return { type: 'node', id: best.id };
  }
  if (L.walls && L.openings) {
    for (const f of openingFrames(level, d.geoms)) {
      const pr = projSeg(p, f.p0, f.p1);
      if (pr.d < f.thick / 2 + px(5)) return { type: 'opening', id: f.o.id };
    }
  }
  if (L.labels) for (let i = level.labels.length - 1; i >= 0; i--) {
    const l = level.labels[i], b = labelBox(l, annot);
    const q = rotate(p, (-l.rot * Math.PI) / 180, { x: l.x, y: l.y });
    if (Math.abs(q.x - l.x) < b.w / 2 + px(3) && Math.abs(q.y - l.y) < b.h / 2 + px(3)) return { type: 'label', id: l.id };
  }
  if (L.dims) for (const dm of level.dims) {
    const { q1, q2 } = dimLine(dm);
    if (projSeg(p, q1, q2).d < px(7)) return { type: 'dim', id: dm.id };
  }
  if (L.items) for (let i = level.items.length - 1; i >= 0; i--) {
    const it = level.items[i], q = itemLocal(it, p);
    if (Math.abs(q.x) <= it.w / 2 + px(2) && Math.abs(q.y) <= it.h / 2 + px(2)) return { type: 'item', id: it.id };
  }
  if (L.walls) {
    let best: { id: ID; d: number } | null = null;
    for (const g of d.geoms.values()) {
      const pr = projSeg(p, g.a, g.b);
      if (pr.d < g.wall.thickness / 2 + px(4) && (!best || pr.d < best.d)) best = { id: g.wall.id, d: pr.d };
    }
    if (best) return { type: 'wall', id: best.id };
  }
  if (L.shapes) {
    let best: { id: ID; d: number } | null = null;
    for (const s of level.shapes) { const dd = shapeDist(s, p); if (dd < px(6) && (!best || dd < best.d)) best = { id: s.id, d: dd }; }
    if (best) return { type: 'shape', id: best.id };
  }
  if (L.rooms) for (const r of d.rooms) if (pointInPoly(p, r.inner) && !r.holes.some(h => pointInPoly(p, h))) return { type: 'room', id: r.key };
  const bg = level.background;
  if (bg && L.background && !bg.locked && p.x >= bg.x && p.x <= bg.x + bg.w && p.y >= bg.y && p.y <= bg.y + bg.h) return { type: 'background', id: 'bg' };
  return null;
}

/** Entidades dentro de un rectángulo de selección. */
export function boxSelect(level: Level, geoms: Map<ID, WallGeom>, a: Pt, b: Pt): Sel[] {
  const L = store.project.settings.layers;
  const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x), minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
  const inside = (p: Pt) => p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY;
  const out: Sel[] = [];
  if (L.walls) for (const g of geoms.values()) if (inside(g.a) && inside(g.b)) out.push({ type: 'wall', id: g.wall.id });
  if (L.items) for (const it of level.items) if (itemCorners(it).every(inside)) out.push({ type: 'item', id: it.id });
  if (L.labels) for (const l of level.labels) if (inside(l)) out.push({ type: 'label', id: l.id });
  if (L.dims) for (const d of level.dims) if (inside({ x: d.x1, y: d.y1 }) && inside({ x: d.x2, y: d.y2 })) out.push({ type: 'dim', id: d.id });
  if (L.shapes) for (const s of level.shapes) {
    let ok = s.pts.length >= 2;
    if (s.kind === 'poly') { for (let i = 0; i + 1 < s.pts.length; i += 2) if (!inside({ x: s.pts[i], y: s.pts[i + 1] })) { ok = false; break; } }
    else ok = inside({ x: s.pts[0], y: s.pts[1] });
    if (ok) out.push({ type: 'shape', id: s.id });
  }
  return out;
}
