import type { Pt } from './model';

export const EPS = 1e-7;

export const pt = (x: number, y: number): Pt => ({ x, y });
export const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Pt, k: number): Pt => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Pt, b: Pt) => a.x * b.x + a.y * b.y;
export const cross = (a: Pt, b: Pt) => a.x * b.y - a.y * b.x;
export const len = (a: Pt) => Math.hypot(a.x, a.y);
export const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const mid = (a: Pt, b: Pt): Pt => lerp(a, b, 0.5);
export function unit(a: Pt): Pt { const l = len(a); return l < EPS ? { x: 1, y: 0 } : { x: a.x / l, y: a.y / l }; }
/** Normal "izquierda" algebraica: (-dy, dx). */
export const perp = (a: Pt): Pt => ({ x: -a.y, y: a.x });
export function rotate(p: Pt, ang: number, c: Pt = { x: 0, y: 0 }): Pt {
  const s = Math.sin(ang), co = Math.cos(ang), dx = p.x - c.x, dy = p.y - c.y;
  return { x: c.x + dx * co - dy * s, y: c.y + dx * s + dy * co };
}

/** Intersección de dos rectas infinitas p1 + s·d1 y p2 + u·d2. */
export function lineLine(p1: Pt, d1: Pt, p2: Pt, d2: Pt): Pt | null {
  const c = cross(d1, d2);
  if (Math.abs(c) < 1e-9) return null;
  const s = cross(sub(p2, p1), d2) / c;
  return { x: p1.x + d1.x * s, y: p1.y + d1.y * s };
}

/** Intersección de dos segmentos; devuelve parámetros s (en ab) y u (en cd). */
export function segSeg(a: Pt, b: Pt, c: Pt, d: Pt): { p: Pt; s: number; u: number } | null {
  const r = sub(b, a), q = sub(d, c);
  const den = cross(r, q);
  if (Math.abs(den) < 1e-12) return null;
  const s = cross(sub(c, a), q) / den;
  const u = cross(sub(c, a), r) / den;
  if (s < 0 || s > 1 || u < 0 || u > 1) return null;
  return { p: { x: a.x + r.x * s, y: a.y + r.y * s }, s, u };
}

/** Proyección de p sobre el segmento ab (t limitado a 0..1). */
export function projSeg(p: Pt, a: Pt, b: Pt): { p: Pt; t: number; d: number } {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  let t = l2 < EPS ? 0 : dot(sub(p, a), ab) / l2;
  t = Math.max(0, Math.min(1, t));
  const q = { x: a.x + ab.x * t, y: a.y + ab.y * t };
  return { p: q, t, d: dist(p, q) };
}

/** Área con signo (fórmula del cordón). */
export function polyArea(pts: Pt[]): number {
  let s = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

export function polyPerimeter(pts: Pt[]): number {
  let s = 0;
  for (let i = 0, n = pts.length; i < n; i++) s += dist(pts[i], pts[(i + 1) % n]);
  return s;
}

export function polyCentroid(pts: Pt[]): Pt {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    const f = p.x * q.y - q.x * p.y;
    a += f; cx += (p.x + q.x) * f; cy += (p.y + q.y) * f;
  }
  if (Math.abs(a) < EPS) {
    const n = pts.length || 1;
    return { x: pts.reduce((s, p) => s + p.x, 0) / n, y: pts.reduce((s, p) => s + p.y, 0) / n };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

export function pointInPoly(p: Pt, pts: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function distToPoly(p: Pt, pts: Pt[]): number {
  let d = Infinity;
  for (let i = 0, n = pts.length; i < n; i++) d = Math.min(d, projSeg(p, pts[i], pts[(i + 1) % n]).d);
  return d;
}

export function bbox(pts: Pt[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; }
  return { minX, minY, maxX, maxY };
}

/** Un buen punto para poner la etiqueta de un polígono (dentro y lejos de los bordes). */
export function labelPoint(pts: Pt[], holes: Pt[][] = []): Pt {
  const c = polyCentroid(pts);
  const score = (p: Pt) => {
    if (!pointInPoly(p, pts)) return -1;
    let d = distToPoly(p, pts);
    for (const h of holes) { if (pointInPoly(p, h)) return -1; d = Math.min(d, distToPoly(p, h)); }
    return d;
  };
  const b = bbox(pts);
  let best = c, bestD = score(c);
  const N = 14;
  let gridBest = -1, gridPt = c;
  for (let i = 1; i < N; i++) for (let j = 1; j < N; j++) {
    const p = { x: b.minX + ((b.maxX - b.minX) * i) / N, y: b.minY + ((b.maxY - b.minY) * j) / N };
    const d = score(p);
    if (d > gridBest) { gridBest = d; gridPt = p; }
  }
  // Se prefiere el centroide salvo que quede fuera o muy pegado a un borde.
  if (bestD < gridBest * 0.6) { best = gridPt; bestD = gridBest; }
  return best;
}

/** Ángulo "legible" para texto: siempre entre -90° y 90°. */
export function readableAngle(a: number): number {
  while (a > Math.PI / 2 + 1e-6) a -= Math.PI;
  while (a <= -Math.PI / 2 + 1e-6) a += Math.PI;
  return a;
}

export function normAngle(a: number): number {
  a = a % (Math.PI * 2);
  return a < 0 ? a + Math.PI * 2 : a;
}
