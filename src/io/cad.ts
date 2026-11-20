// Representación intermedia común para lo que se lee de DXF y DWG.
// Las coordenadas están en unidades del dibujo original, con Y hacia arriba
// y ángulos en radianes (sentido antihorario).

import type { Shape } from '../core/model';
import { uid } from '../core/model';

export type CadEnt =
  | { k: 'poly'; pts: number[]; closed?: boolean; layer: string; dash?: boolean }
  | { k: 'circle'; x: number; y: number; r: number; layer: string }
  | { k: 'arc'; x: number; y: number; r: number; a0: number; a1: number; layer: string }
  | { k: 'text'; x: number; y: number; h: number; rot: number; text: string; layer: string; align?: 'l' | 'c' | 'r'; mid?: boolean }
  | { k: 'insert'; name: string; x: number; y: number; sx: number; sy: number; rot: number; layer: string };

export interface CadDoc {
  ents: CadEnt[];
  blocks: Map<string, { bx: number; by: number; ents: CadEnt[] }>;
  /** código $INSUNITS de AutoCAD, si viene */
  insUnits: number | null;
}

export const INSUNITS_TO_M: Record<number, number> = { 1: 0.0254, 2: 0.3048, 4: 0.001, 5: 0.01, 6: 1, 8: 0.0000254, 10: 0.9144, 14: 0.1 };

/** Convierte un tramo con "bulge" (arco de polilínea) en puntos. */
export function bulgePoints(x1: number, y1: number, x2: number, y2: number, b: number, out: number[]) {
  if (Math.abs(b) < 1e-9) { out.push(x2, y2); return; }
  const theta = 4 * Math.atan(b);
  const cx = (x1 + x2) / 2 - ((y2 - y1) * (1 - b * b)) / (4 * b);
  const cy = (y1 + y2) / 2 + ((x2 - x1) * (1 - b * b)) / (4 * b);
  const r = Math.hypot(x1 - cx, y1 - cy), a1 = Math.atan2(y1 - cy, x1 - cx);
  const n = Math.max(2, Math.ceil(Math.abs(theta) / (Math.PI / 16)));
  for (let i = 1; i <= n; i++) { const a = a1 + (theta * i) / n; out.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r); }
  out[out.length - 2] = x2; out[out.length - 1] = y2;
}

export function arcPoints(x: number, y: number, r: number, a0: number, a1: number): number[] {
  let sweep = a1 - a0;
  while (sweep <= 0) sweep += Math.PI * 2;
  const n = Math.max(4, Math.ceil(sweep / (Math.PI / 18)));
  const pts: number[] = [];
  for (let i = 0; i <= n; i++) { const a = a0 + (sweep * i) / n; pts.push(x + Math.cos(a) * r, y + Math.sin(a) * r); }
  return pts;
}

export function ellipsePoints(cx: number, cy: number, mx: number, my: number, ratio: number, t0: number, t1: number): { pts: number[]; closed: boolean } {
  let sweep = t1 - t0;
  while (sweep <= 1e-9) sweep += Math.PI * 2;
  const closed = Math.abs(sweep - Math.PI * 2) < 1e-6;
  const n = 64, pts: number[] = [];
  const nx = -my * ratio, ny = mx * ratio;
  for (let i = 0; i < (closed ? n : n + 1); i++) { const t = t0 + (sweep * i) / n; pts.push(cx + Math.cos(t) * mx + Math.sin(t) * nx, cy + Math.cos(t) * my + Math.sin(t) * ny); }
  return { pts, closed };
}

/** Evalúa una B-spline (De Boor) y devuelve una polilínea. */
export function splinePoints(ctrl: number[], knots: number[], degree: number): number[] {
  const n = ctrl.length / 2;
  if (n < 2) return ctrl.slice();
  if (!knots || knots.length !== n + degree + 1 || degree < 1) return ctrl.slice();
  const t0 = knots[degree], t1 = knots[n];
  const steps = Math.min(400, Math.max(16, n * 8)), out: number[] = [];
  for (let s = 0; s <= steps; s++) {
    let t = t0 + ((t1 - t0) * s) / steps;
    if (s === steps) t = t1 - 1e-9;
    let k = degree;
    while (k < n - 1 && knots[k + 1] <= t) k++;
    const dx: number[] = [], dy: number[] = [];
    for (let j = 0; j <= degree; j++) { dx.push(ctrl[(k - degree + j) * 2]); dy.push(ctrl[(k - degree + j) * 2 + 1]); }
    for (let r = 1; r <= degree; r++) for (let j = degree; j >= r; j--) {
      const i = k - degree + j, den = knots[i + degree - r + 1] - knots[i];
      const a = den === 0 ? 0 : (t - knots[i]) / den;
      dx[j] = (1 - a) * dx[j - 1] + a * dx[j]; dy[j] = (1 - a) * dy[j - 1] + a * dy[j];
    }
    out.push(dx[degree], dy[degree]);
  }
  return out;
}

export function cleanMText(s: string): string {
  return s.replace(/\\P/g, ' ').replace(/\\[ACFHQTWfLlOoKk][^;\\]*;/g, '').replace(/\\S([^;]*);/g, '$1').replace(/\\[~]/g, ' ').replace(/[{}]/g, '')
    .replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/%%[cC]/g, 'Ø').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±').replace(/\\\\/g, '\\').trim();
}

type Mat = [number, number, number, number, number, number];
const IDENT: Mat = [1, 0, 0, 1, 0, 0];
const mulM = (m: Mat, n: Mat): Mat => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const isIdent = (m: Mat) => m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;

/** Expande los bloques (INSERT) y devuelve entidades simples, sin anidación. */
export function flatten(doc: CadDoc, limit = 250000): CadEnt[] {
  const out: CadEnt[] = [];
  let count = 0;
  const tp = (m: Mat, pts: number[]) => { const o = new Array(pts.length); for (let i = 0; i < pts.length; i += 2) { o[i] = m[0] * pts[i] + m[2] * pts[i + 1] + m[4]; o[i + 1] = m[1] * pts[i] + m[3] * pts[i + 1] + m[5]; } return o; };
  const walk = (ents: CadEnt[], m: Mat, depth: number, layer?: string) => {
    for (const e of ents) {
      if (count > limit) return;
      const ly = e.layer === '0' && layer ? layer : e.layer;
      if (e.k === 'insert') {
        const b = doc.blocks.get(e.name);
        if (!b || depth > 8) continue;
        const c = Math.cos(e.rot), s = Math.sin(e.rot);
        const local: Mat = [c * e.sx, s * e.sx, -s * e.sy, c * e.sy, e.x, e.y];
        const base: Mat = [1, 0, 0, 1, -b.bx, -b.by];
        walk(b.ents, mulM(m, mulM(local, base)), depth + 1, ly);
        continue;
      }
      count++;
      if (isIdent(m)) { out.push(ly === e.layer ? e : { ...e, layer: ly }); continue; }
      if (e.k === 'poly') out.push({ ...e, layer: ly, pts: tp(m, e.pts) });
      else if (e.k === 'circle') out.push({ k: 'poly', closed: true, layer: ly, pts: tp(m, arcPoints(e.x, e.y, e.r, 0, Math.PI * 2).slice(0, -2)) });
      else if (e.k === 'arc') out.push({ k: 'poly', layer: ly, pts: tp(m, arcPoints(e.x, e.y, e.r, e.a0, e.a1)) });
      else if (e.k === 'text') {
        const p = tp(m, [e.x, e.y]), sc = Math.hypot(m[0], m[1]);
        out.push({ ...e, layer: ly, x: p[0], y: p[1], h: e.h * sc, rot: e.rot + Math.atan2(m[1], m[0]) });
      }
    }
  };
  walk(doc.ents, IDENT, 0);
  return out;
}

export function cadBounds(ents: CadEnt[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const acc = (x: number, y: number) => { if (!Number.isFinite(x) || !Number.isFinite(y)) return; if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; };
  for (const e of ents) {
    if (e.k === 'poly') for (let i = 0; i + 1 < e.pts.length; i += 2) acc(e.pts[i], e.pts[i + 1]);
    else if (e.k === 'circle' || e.k === 'arc') { acc(e.x - e.r, e.y - e.r); acc(e.x + e.r, e.y + e.r); }
    else if (e.k === 'text') acc(e.x, e.y);
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY };
}

/** Si el archivo no declara unidades, se estima por el tamaño del dibujo. */
export function guessUnitFactor(doc: CadDoc, ents: CadEnt[]): number {
  if (doc.insUnits && INSUNITS_TO_M[doc.insUnits]) return INSUNITS_TO_M[doc.insUnits];
  const b = cadBounds(ents);
  if (!b) return 1;
  const size = Math.max(b.maxX - b.minX, b.maxY - b.minY);
  if (size > 2500) return 0.001;
  if (size > 250) return 0.01;
  return 1;
}

/**
 * Convierte entidades CAD a formas del plano: aplica el factor de unidad,
 * invierte el eje Y y deja el dibujo con su esquina superior izquierda en `at`.
 */
export function cadToShapes(ents: CadEnt[], factor: number, at: { x: number; y: number }): Shape[] {
  const b = cadBounds(ents);
  if (!b) return [];
  const group = uid('g');
  const X = (x: number) => (x - b.minX) * factor + at.x, Y = (y: number) => (b.maxY - y) * factor + at.y;
  const ok = (v: number) => Number.isFinite(v);
  const out: Shape[] = [];
  for (const e of ents) {
    if (e.k === 'poly') {
      if (e.pts.length < 4 || !e.pts.every(ok)) continue;
      const pts = new Array(e.pts.length);
      for (let i = 0; i < e.pts.length; i += 2) { pts[i] = X(e.pts[i]); pts[i + 1] = Y(e.pts[i + 1]); }
      out.push({ id: uid('s'), kind: 'poly', pts, closed: e.closed, layer: e.layer, dash: e.dash, group });
    } else if (e.k === 'circle') {
      if (!ok(e.x) || !ok(e.y) || !(e.r > 0)) continue;
      out.push({ id: uid('s'), kind: 'circle', pts: [X(e.x), Y(e.y)], r: e.r * factor, layer: e.layer, group });
    } else if (e.k === 'arc') {
      if (!ok(e.x) || !ok(e.y) || !(e.r > 0)) continue;
      out.push({ id: uid('s'), kind: 'arc', pts: [X(e.x), Y(e.y)], r: e.r * factor, a0: -e.a1, a1: -e.a0, layer: e.layer, group });
    } else if (e.k === 'text') {
      if (!ok(e.x) || !ok(e.y) || !e.text.trim() || !(e.h > 0)) continue;
      // el punto de inserción CAD es la línea base; nuestro texto se ancla al centro vertical
      const k = e.mid ? 0 : 0.5;
      const ux = -Math.sin(e.rot) * e.h * k, uy = Math.cos(e.rot) * e.h * k;
      out.push({ id: uid('s'), kind: 'text', pts: [X(e.x + ux), Y(e.y + uy)], text: e.text, h: e.h * factor * 1.35, rot: -e.rot, align: e.align, layer: e.layer, group });
    }
  }
  return out;
}
