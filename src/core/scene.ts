// Convierte un nivel del plano en una lista de primitivas de dibujo. La misma
// lista alimenta la pantalla, el PDF, el SVG, el PNG y el DXF, así todo lo que
// se ve es exactamente lo que se exporta.

import type { ID, Item, LayerKey, Level, Pt, Shape, Units } from './model';
import { add, dist, mid, mul, normAngle, perp, readableAngle, rotate, sub, unit } from './geom';
import { fmtArea, fmtLen } from './units';
import { computeRooms, openingFrames, wallGeoms, wallPieces, type OpeningFrame, type Room, type WallGeom } from './topology';
import { symbolDef, type Cmd } from './symbols';
import { roomColor, type Theme } from './themes';

export type Prim =
  | { k: 'poly'; pts: number[]; closed?: boolean; fill?: string | null; stroke?: string | null; lw?: number; dash?: boolean; layer: string; cad?: boolean }
  | { k: 'arc'; cx: number; cy: number; r: number; a0: number; a1: number; stroke: string; lw?: number; dash?: boolean; layer: string }
  | { k: 'circle'; cx: number; cy: number; r: number; fill?: string | null; stroke?: string | null; lw?: number; layer: string }
  | { k: 'text'; x: number; y: number; text: string; h: number; rot?: number; align?: 'c' | 'l' | 'r'; color: string; bold?: boolean; halo?: string | null; layer: string };

export interface SceneOpts {
  theme: Theme;
  /** metros de dibujo por cada milímetro de papel (escala/1000) */
  annot: number;
  units: Units;
  layers: Record<LayerKey, boolean>;
  showRoomDims: boolean; showAreas: boolean; showOverallDims: boolean;
  rooms?: Room[]; geoms?: Map<ID, WallGeom>;
}

/** Nombres de capa para CAD. */
export const CAD_LAYERS: Record<string, { name: string; color: number }> = {
  walls: { name: 'MUROS', color: 7 },
  doors: { name: 'PUERTAS', color: 3 },
  windows: { name: 'VENTANAS', color: 4 },
  items: { name: 'MOBILIARIO', color: 8 },
  dims: { name: 'COTAS', color: 1 },
  rooms: { name: 'RECINTOS', color: 5 },
  labels: { name: 'TEXTOS', color: 7 },
  shapes: { name: 'LINEAS', color: 6 },
};

const flat = (pts: Pt[]) => { const o: number[] = []; for (const p of pts) o.push(p.x, p.y); return o; };

export function itemCorners(it: Item): Pt[] {
  const a = (it.rot * Math.PI) / 180, c = { x: it.x, y: it.y };
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => rotate({ x: it.x + (sx * it.w) / 2, y: it.y + (sy * it.h) / 2 }, a, c));
}

function roundRect(x: number, y: number, w: number, h: number, r: number): number[] {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (r < 0.004) return [x, y, x + w, y, x + w, y + h, x, y + h];
  const o: number[] = [];
  const corner = (cx: number, cy: number, a0: number) => { for (let i = 0; i <= 4; i++) { const a = a0 + (i / 4) * (Math.PI / 2); o.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r); } };
  corner(x + w - r, y + r, -Math.PI / 2); corner(x + w - r, y + h - r, 0); corner(x + r, y + h - r, Math.PI / 2); corner(x + r, y + r, Math.PI);
  return o;
}

/** Primitivas de un símbolo de mobiliario ya ubicado y rotado. */
export function itemPrims(it: Item, theme: Theme, out: Prim[] = []): Prim[] {
  const def = symbolDef(it.type);
  const a = (it.rot * Math.PI) / 180, co = Math.cos(a), si = Math.sin(a);
  const tr = (pts: number[]) => {
    const o = new Array(pts.length);
    for (let i = 0; i < pts.length; i += 2) {
      const lx = pts[i] - it.w / 2, ly = pts[i + 1] - it.h / 2;
      o[i] = it.x + lx * co - ly * si; o[i + 1] = it.y + lx * si + ly * co;
    }
    return o;
  };
  const fillOf = (f?: 0 | 1 | 2) => (f === 1 ? theme.furnFill : f === 2 ? theme.furnAccent : null);
  for (const c of def.draw(it.w, it.h) as Cmd[]) {
    if (c.c === 'rect') out.push({ k: 'poly', pts: tr(roundRect(c.x, c.y, c.w, c.h, c.r || 0)), closed: true, fill: fillOf(c.fill), stroke: theme.furnStroke, lw: 0.18, layer: 'items' });
    else if (c.c === 'ell') {
      const pts: number[] = [];
      for (let i = 0; i < 28; i++) { const t = (i / 28) * Math.PI * 2; pts.push(c.cx + Math.cos(t) * c.rx, c.cy + Math.sin(t) * c.ry); }
      out.push({ k: 'poly', pts: tr(pts), closed: true, fill: fillOf(c.fill), stroke: theme.furnStroke, lw: 0.18, layer: 'items' });
    } else if (c.c === 'poly') out.push({ k: 'poly', pts: tr(c.pts), closed: c.closed, fill: fillOf(c.fill), stroke: theme.furnStroke, lw: 0.18, dash: c.dash, layer: 'items' });
    else if (c.c === 'arc') {
      const pts: number[] = [];
      for (let i = 0; i <= 12; i++) { const t = c.a0 + ((c.a1 - c.a0) * i) / 12; pts.push(c.cx + Math.cos(t) * c.r, c.cy + Math.sin(t) * c.r); }
      out.push({ k: 'poly', pts: tr(pts), stroke: theme.furnStroke, lw: 0.18, layer: 'items' });
    }
  }
  return out;
}

/** Línea de cota con líneas de referencia, marcas a 45° y texto. */
export function dimPrims(out: Prim[], p1: Pt, p2: Pt, offset: number, text: string, annot: number, theme: Theme, layer = 'dims') {
  const L = dist(p1, p2);
  if (L < 1e-6) return;
  const d = unit(sub(p2, p1)), n = perp(d), sg = offset >= 0 ? 1 : -1;
  const q1 = add(p1, mul(n, offset)), q2 = add(p2, mul(n, offset));
  const gap = 1.0 * annot, ext = 1.5 * annot, tick = 1.1 * annot;
  const col = theme.dim;
  if (Math.abs(offset) > gap * 1.5) {
    out.push({ k: 'poly', pts: flat([add(p1, mul(n, sg * gap)), add(q1, mul(n, sg * ext))]), stroke: col, lw: 0.13, layer });
    out.push({ k: 'poly', pts: flat([add(p2, mul(n, sg * gap)), add(q2, mul(n, sg * ext))]), stroke: col, lw: 0.13, layer });
  }
  out.push({ k: 'poly', pts: flat([sub(q1, mul(d, ext * 0.6)), add(q2, mul(d, ext * 0.6))]), stroke: col, lw: 0.13, layer });
  const td = unit(add(d, n));
  for (const q of [q1, q2]) out.push({ k: 'poly', pts: flat([sub(q, mul(td, tick)), add(q, mul(td, tick))]), stroke: col, lw: 0.35, layer });
  const ang = readableAngle(Math.atan2(d.y, d.x));
  const up = { x: Math.sin(ang), y: -Math.cos(ang) };
  const m = mid(q1, q2);
  out.push({ k: 'text', x: m.x + up.x * 1.9 * annot, y: m.y + up.y * 1.9 * annot, text, h: 2.6 * annot, rot: ang, align: 'c', color: theme.text, halo: theme.halo, layer });
}

function shapePrims(s: Shape, theme: Theme, out: Prim[]) {
  const col = theme.line;
  if (s.kind === 'poly') out.push({ k: 'poly', pts: s.pts, closed: s.closed, stroke: col, lw: 0.2, dash: s.dash, layer: 'shapes' });
  else if (s.kind === 'circle') out.push({ k: 'circle', cx: s.pts[0], cy: s.pts[1], r: s.r || 0, stroke: col, lw: 0.2, layer: 'shapes' });
  else if (s.kind === 'arc') out.push({ k: 'arc', cx: s.pts[0], cy: s.pts[1], r: s.r || 0, a0: s.a0 || 0, a1: s.a1 || 0, stroke: col, lw: 0.2, layer: 'shapes' });
  else if (s.kind === 'text' && s.text) out.push({ k: 'text', x: s.pts[0], y: s.pts[1], text: s.text, h: s.h || 0.2, rot: s.rot || 0, align: s.align || 'l', color: col, layer: 'shapes' });
}

function openingPrims(f: OpeningFrame, theme: Theme, out: Prim[]) {
  const { o, g } = f;
  const h = f.thick / 2, W = f.width, d = g.dir, n = g.nrm;
  const P = (x: number, y: number): Pt => ({ x: f.p0.x + d.x * x + n.x * y, y: f.p0.y + d.y * x + n.y * y });
  const sv = o.flipV ? -1 : 1;
  if (o.kind === 'window') {
    const layer = 'windows';
    out.push({ k: 'poly', pts: flat([P(0, -h), P(W, -h), P(W, h), P(0, h)]), closed: true, fill: theme.glass || theme.bg, stroke: theme.line, lw: 0.25, layer });
    const k = o.style === 'fixed' ? [0] : [-0.22, 0.22];
    for (const q of k) out.push({ k: 'poly', pts: flat([P(0, h * q * 2), P(W, h * q * 2)]), stroke: theme.line, lw: 0.13, layer });
    if (o.style === 'sliding') out.push({ k: 'poly', pts: flat([P(W / 2, -h), P(W / 2, h)]), stroke: theme.line, lw: 0.13, layer });
    return;
  }
  const layer = 'doors';
  if (o.kind === 'gap') {
    for (const s of [-1, 1]) out.push({ k: 'poly', pts: flat([P(0, s * h), P(W, s * h)]), stroke: theme.muted, lw: 0.13, dash: true, layer });
    return;
  }
  if (o.style === 'sliding') {
    const t = Math.min(0.05, h * 0.6);
    out.push({ k: 'poly', pts: flat([P(0, 0), P(W * 0.56, 0), P(W * 0.56, sv * t), P(0, sv * t)]), closed: true, fill: theme.bg, stroke: theme.line, lw: 0.25, layer });
    out.push({ k: 'poly', pts: flat([P(W * 0.44, 0), P(W, 0), P(W, -sv * t), P(W * 0.44, -sv * t)]), closed: true, fill: theme.bg, stroke: theme.line, lw: 0.25, layer });
    return;
  }
  const leaf = (hx: number, lw: number, dirX: number) => {
    const H = P(hx, sv * h), tip = P(hx, sv * (h + lw)), close = P(hx + dirX * lw, sv * h);
    out.push({ k: 'poly', pts: flat([H, tip]), stroke: theme.line, lw: 0.4, layer });
    const aTip = Math.atan2(tip.y - H.y, tip.x - H.x), aClose = Math.atan2(close.y - H.y, close.x - H.x);
    const ccw = Math.abs(normAngle(aClose - aTip) - Math.PI / 2) < 0.01;
    out.push({ k: 'arc', cx: H.x, cy: H.y, r: lw, a0: ccw ? aTip : aClose, a1: ccw ? aClose : aTip, stroke: theme.line, lw: 0.13, layer });
  };
  if (o.style === 'double') { leaf(0, W / 2, 1); leaf(W, W / 2, -1); }
  else if (o.flipH) leaf(W, W, -1);
  else leaf(0, W, 1);
}

export function buildScene(level: Level, o: SceneOpts): Prim[] {
  const out: Prim[] = [];
  const { theme, annot, units, layers } = o;
  const geoms = o.geoms || wallGeoms(level);
  const rooms = o.rooms || computeRooms(level);
  const frames = openingFrames(level, geoms);

  if (theme.roomFills && layers.rooms) {
    for (const r of rooms) out.push({ k: 'poly', pts: flat(r.poly), closed: true, fill: roomColor(r.meta?.type || 'other'), layer: 'rooms', cad: false });
    for (const r of rooms) for (const h of r.holes) out.push({ k: 'poly', pts: flat(h), closed: true, fill: theme.bg, layer: 'rooms', cad: false });
  }
  const hidden = level.hiddenLayers && level.hiddenLayers.length ? new Set(level.hiddenLayers) : null;
  if (layers.shapes) for (const s of level.shapes) if (!hidden || !hidden.has(s.layer || '0')) shapePrims(s, theme, out);
  if (layers.items) for (const it of level.items) itemPrims(it, theme, out);

  if (layers.walls) {
    const pieces = wallPieces(geoms, layers.openings ? frames : []);
    for (const p of pieces) for (const f of p.fills) out.push({ k: 'poly', pts: flat(f), closed: true, fill: theme.wallFill, stroke: theme.wallFill, lw: 0.1, layer: 'walls', cad: false });
    for (const p of pieces) for (const l of p.lines) out.push({ k: 'poly', pts: [l[0].x, l[0].y, l[1].x, l[1].y], stroke: theme.wallStroke, lw: 0.35, layer: 'walls' });
  }
  if (layers.openings && layers.walls) for (const f of frames) openingPrims(f, theme, out);

  if (layers.rooms) {
    for (const r of rooms) {
      const name = r.meta?.name || '';
      const hName = 3.2 * annot, hArea = 2.5 * annot;
      if (name) out.push({ k: 'text', x: r.center.x, y: r.center.y - (o.showAreas ? hArea * 0.65 : 0), text: name, h: hName, align: 'c', color: theme.text, bold: true, halo: theme.roomFills ? null : theme.halo, layer: 'rooms' });
      if (o.showAreas) out.push({ k: 'text', x: r.center.x, y: r.center.y + (name ? hName * 0.65 : 0), text: fmtArea(r.area, units), h: hArea, align: 'c', color: theme.muted, halo: theme.roomFills ? null : theme.halo, layer: 'rooms' });
    }
  }
  if (layers.dims && o.showRoomDims) {
    for (const r of rooms) for (const e of r.edges) {
      if (e.len < 0.45) continue;
      const d = unit(sub(e.b, e.a)), n = perp(d), ang = readableAngle(Math.atan2(d.y, d.x));
      const m = mid(e.a, e.b);
      out.push({ k: 'text', x: m.x + n.x * 2.4 * annot, y: m.y + n.y * 2.4 * annot, text: fmtLen(e.len, units), h: 2.2 * annot, rot: ang, align: 'c', color: theme.dim, halo: theme.roomFills ? roomColor(r.meta?.type || 'other') : theme.halo, layer: 'dims' });
    }
  }
  if (layers.dims && o.showOverallDims && geoms.size > 1) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const g of geoms.values()) for (const p of [g.aL, g.aR, g.bL, g.bR]) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
    const off = 9 * annot;
    if (maxX - minX > 0.5) dimPrims(out, { x: minX, y: minY }, { x: maxX, y: minY }, -off, fmtLen(maxX - minX, units), annot, theme);
    if (maxY - minY > 0.5) dimPrims(out, { x: minX, y: maxY }, { x: minX, y: minY }, -off, fmtLen(maxY - minY, units), annot, theme);
  }
  if (layers.dims) for (const dm of level.dims) {
    const p1 = { x: dm.x1, y: dm.y1 }, p2 = { x: dm.x2, y: dm.y2 };
    dimPrims(out, p1, p2, dm.offset, fmtLen(dist(p1, p2), units), annot, theme);
  }
  if (layers.labels) for (const l of level.labels) {
    out.push({ k: 'text', x: l.x, y: l.y, text: l.text, h: l.size * annot, rot: (l.rot * Math.PI) / 180, align: 'c', color: theme.text, layer: 'labels' });
  }
  return out;
}

/** Caja envolvente de una lista de primitivas (para encuadrar al exportar). */
export function primsBounds(prims: Prim[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const acc = (x: number, y: number) => { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; };
  for (const p of prims) {
    if (p.k === 'poly') for (let i = 0; i + 1 < p.pts.length; i += 2) acc(p.pts[i], p.pts[i + 1]);
    else if (p.k === 'arc' || p.k === 'circle') { acc(p.cx - p.r, p.cy - p.r); acc(p.cx + p.r, p.cy + p.r); }
    else { const w = p.text.length * p.h * 0.3; acc(p.x - w, p.y - p.h); acc(p.x + w, p.y + p.h); }
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY };
}
