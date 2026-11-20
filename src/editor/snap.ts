// Ajuste automático del cursor: a puntos existentes, a muros, a la alineación
// con otros puntos, a ángulos rectos y a la cuadrícula. Es lo que permite
// dibujar derecho y exacto sin escribir coordenadas.

import type { ID, Pt } from '../core/model';
import { dist, projSeg } from '../core/geom';
import { store } from '../core/store';
import { previewWalls } from '../core/convert';

// Ejes de los muros que se reconocen en el calco (dibujo importado). Al calcar, el
// cursor se va a esos ejes y no a las caras, para que el muro nuevo coincida con el dibujado.
let axisCache: { key: string; pts: { x: number; y: number; t: number }[] } | null = null;
function refAxes(): { x: number; y: number; t: number }[] {
  const lv = store.level;
  if (!lv.shapes.length || lv.shapes.length > 60000) return [];
  let sum = 0;
  for (const s of lv.shapes) sum += s.pts[0] + s.pts[1] * 3;
  const key = `${lv.id}:${lv.shapes.length}:${sum.toFixed(3)}`;
  if (!axisCache || axisCache.key !== key) {
    const pts: { x: number; y: number; t: number }[] = [];
    try { for (const w of previewWalls(lv.shapes).walls) pts.push({ x: w.a.x, y: w.a.y, t: w.t }, { x: w.b.x, y: w.b.y, t: w.t }); } catch { /* sin ejes */ }
    axisCache = { key, pts };
  }
  return axisCache.pts;
}

export interface Snap {
  p: Pt;
  kind: 'node' | 'vertex' | 'refaxis' | 'wall' | 'axis' | 'angle' | 'grid' | 'free';
  nodeId?: ID; wallId?: ID;
  /** grosor del muro del calco al que se ajustó (kind 'refaxis') */
  t?: number;
  guides: { a: Pt; b: Pt }[];
}

export interface SnapOpts {
  from?: Pt;
  excludeNodes?: Set<ID>;
  /** Shift: fuerza ángulos de 45° */
  ortho?: boolean;
  /** Alt: sin ajuste */
  free?: boolean;
  /** incluir las esquinas de las caras de los muros (para acotar y medir) */
  corners?: boolean;
  /** incluir los vértices de líneas libres y dibujos importados (para calcar) */
  verts?: boolean;
  noWalls?: boolean;
  /** ajustar al eje de los muros reconocidos en el calco (para dibujar muros encima) */
  axes?: boolean;
}

export function snapPoint(raw: Pt, zoom: number, o: SnapOpts = {}): Snap {
  const lv = store.level, st = store.project.settings;
  if (o.free) return { p: raw, kind: 'free', guides: [] };
  const px = (n: number) => n / zoom;
  const ex = o.excludeNodes;

  if (st.snapObjects) {
    let best: { p: Pt; d: number; id?: ID } | null = null;
    for (const n of lv.nodes) {
      if (ex && ex.has(n.id)) continue;
      const d = dist(n, raw);
      if (d < px(11) && (!best || d < best.d)) best = { p: { x: n.x, y: n.y }, d, id: n.id };
    }
    // al acotar o medir mandan las caras de los muros (lo que se mide con huincha), no sus ejes
    if (best && !o.corners) return { p: best.p, kind: 'node', nodeId: best.id, guides: [] };
    if (o.axes && st.layers.shapes) {
      let ba: { x: number; y: number; t: number; d: number } | null = null;
      for (const a of refAxes()) {
        const d = Math.hypot(a.x - raw.x, a.y - raw.y);
        // el radio cubre las esquinas de las caras: apuntar a la cara lleva al eje
        if (d < Math.max(px(11), a.t * 0.8) && (!ba || d < ba.d)) ba = { ...a, d };
      }
      if (ba) { const hit = ba as { x: number; y: number; t: number }; return { p: { x: hit.x, y: hit.y }, kind: 'refaxis', t: hit.t, guides: [] }; }
    }
    if (o.corners || o.verts) {
      let bv: { p: Pt; d: number } | null = null;
      const test = (x: number, y: number) => { const d = Math.hypot(x - raw.x, y - raw.y); if (d < px(9) && (!bv || d < bv.d)) bv = { p: { x, y }, d }; };
      if (o.corners) for (const g of store.derived().geoms.values()) for (const c of [g.aL, g.aR, g.bL, g.bR]) test(c.x, c.y);
      if (st.layers.shapes) for (const s of lv.shapes) {
        if (s.kind !== 'poly') { test(s.pts[0], s.pts[1]); continue; }
        for (let i = 0; i + 1 < s.pts.length; i += 2) test(s.pts[i], s.pts[i + 1]);
      }
      if (bv) return { p: (bv as { p: Pt }).p, kind: 'vertex', guides: [] };
      if (best) return { p: best.p, kind: 'node', nodeId: best.id, guides: [] };
    }
    if (!o.noWalls) {
      let bw: { p: Pt; d: number; id: ID } | null = null;
      const nodes = new Map(lv.nodes.map(n => [n.id, n]));
      for (const w of lv.walls) {
        if (ex && (ex.has(w.a) || ex.has(w.b))) continue;
        const a = nodes.get(w.a), b = nodes.get(w.b);
        if (!a || !b) continue;
        const pr = projSeg(raw, a, b);
        if (pr.d < px(9) && (!bw || pr.d < bw.d)) bw = { p: pr.p, d: pr.d, id: w.id };
      }
      if (bw) {
        const hit = bw as { p: Pt; d: number; id: ID };
        const w = lv.walls.find(x => x.id === hit.id)!, a = nodes.get(w.a)!, b = nodes.get(w.b)!;
        const L = dist(a, b);
        // si se viene dibujando en ángulo recto, se usa el cruce exacto del trazo con el muro
        if (o.from && (st.snapAngle || o.ortho) && L > 1e-6) {
          const ang = Math.atan2(raw.y - o.from.y, raw.x - o.from.x), q = Math.PI / 4, k = Math.round(ang / q);
          if (o.ortho || Math.abs(ang - k * q) < (k % 2 === 0 ? 0.11 : 0.05)) {
            const dir = { x: Math.cos(k * q), y: Math.sin(k * q) }, wd = { x: b.x - a.x, y: b.y - a.y };
            const den = dir.x * wd.y - dir.y * wd.x;
            if (Math.abs(den) > 1e-9) {
              const t = ((a.x - o.from.x) * wd.y - (a.y - o.from.y) * wd.x) / den;
              const u = ((a.x - o.from.x) * dir.y - (a.y - o.from.y) * dir.x) / den;
              const ip = { x: o.from.x + dir.x * t, y: o.from.y + dir.y * t };
              if (t > 0 && u >= 0 && u <= 1 && dist(ip, raw) < px(16)) return { p: ip, kind: 'wall', wallId: hit.id, guides: [] };
            }
          }
        }
        // a lo largo del muro, la posición se redondea a la cuadrícula medida desde su inicio
        if (st.snapGrid && L > st.gridStep * 2) {
          const sPos = Math.round(dist(a, hit.p) / st.gridStep) * st.gridStep;
          if (sPos > 1e-6 && sPos < L - 1e-6) return { p: { x: a.x + ((b.x - a.x) * sPos) / L, y: a.y + ((b.y - a.y) * sPos) / L }, kind: 'wall', wallId: hit.id, guides: [] };
        }
        return { p: hit.p, kind: 'wall', wallId: hit.id, guides: [] };
      }
    }
  }

  const step = st.gridStep;
  const grid = (v: number) => (st.snapGrid ? Math.round(v / step) * step : v);
  const guides: { a: Pt; b: Pt }[] = [];
  const alignX = (x: number): { v: number; n: Pt } | null => {
    if (!st.snapObjects) return null;
    let b: { v: number; n: Pt; d: number } | null = null;
    for (const n of lv.nodes) { if (ex && ex.has(n.id)) continue; const d = Math.abs(n.x - x); if (d < px(7) && (!b || d < b.d)) b = { v: n.x, n, d }; }
    return b;
  };
  const alignY = (y: number): { v: number; n: Pt } | null => {
    if (!st.snapObjects) return null;
    let b: { v: number; n: Pt; d: number } | null = null;
    for (const n of lv.nodes) { if (ex && ex.has(n.id)) continue; const d = Math.abs(n.y - y); if (d < px(7) && (!b || d < b.d)) b = { v: n.y, n, d }; }
    return b;
  };

  if (o.from && (st.snapAngle || o.ortho)) {
    const dx = raw.x - o.from.x, dy = raw.y - o.from.y;
    const L = Math.hypot(dx, dy);
    if (L > 1e-6) {
      const ang = Math.atan2(dy, dx), q = Math.PI / 4;
      const k = Math.round(ang / q);
      const diff = Math.abs(ang - k * q);
      const isAxis = k % 2 === 0;
      if (o.ortho || diff < (isAxis ? 0.11 : 0.05)) {
        const a = k * q, ux = Math.cos(a), uy = Math.sin(a);
        let len = dx * ux + dy * uy;
        let aligned = false;
        if (isAxis) {
          const horizontal = Math.abs(ux) > 0.5;
          const al = horizontal ? alignX(o.from.x + ux * len) : alignY(o.from.y + uy * len);
          if (al) {
            len = horizontal ? (al.v - o.from.x) * Math.sign(ux) : (al.v - o.from.y) * Math.sign(uy);
            const p = { x: o.from.x + ux * len, y: o.from.y + uy * len };
            guides.push({ a: { x: al.n.x, y: al.n.y }, b: p });
            aligned = true;
          }
        }
        if (!aligned) len = grid(len);
        return { p: { x: o.from.x + ux * len, y: o.from.y + uy * len }, kind: aligned ? 'axis' : 'angle', guides };
      }
    }
  }

  const p = { x: grid(raw.x), y: grid(raw.y) };
  let kind: Snap['kind'] = st.snapGrid ? 'grid' : 'free';
  const ax = alignX(raw.x), ay = alignY(raw.y);
  if (ax) { p.x = ax.v; kind = 'axis'; }
  if (ay) { p.y = ay.v; kind = 'axis'; }
  if (ax) guides.push({ a: { x: ax.n.x, y: ax.n.y }, b: { x: p.x, y: p.y } });
  if (ay) guides.push({ a: { x: ay.n.x, y: ay.n.y }, b: { x: p.x, y: p.y } });
  return { p, kind, guides };
}
