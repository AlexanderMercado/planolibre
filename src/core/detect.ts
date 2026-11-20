// Detección de muros en un dibujo de líneas (DXF/DWG, PDF vectorial o una
// imagen vectorizada). La idea: un muro dibujado "a doble línea" son dos rectas
// paralelas, cercanas y que se traslapan. Se emparejan, se obtiene el eje y el
// grosor, se cierran las esquinas y se reconocen los vanos (puertas y ventanas).
//
// Es geometría pura: no depende del navegador ni del resto del modelo.

import type { Pt } from './model';

export interface DSeg { x1: number; y1: number; x2: number; y2: number; layer?: string; dash?: boolean }
export interface DArc { x: number; y: number; r: number; a0: number; a1: number; layer?: string }
export interface DetWall { a: Pt; b: Pt; t: number }
export interface DetOpening {
  c: Pt; width: number;
  kind: 'door' | 'window' | 'gap';
  style: 'single' | 'double' | 'sliding' | 'fixed';
  /** puertas: punto de la bisagra y un punto del lado hacia donde abre */
  hinge?: Pt; swing?: Pt;
}
export interface DetectOpts {
  /** grosor mínimo y máximo de muro que se acepta, en metros */
  minT?: number; maxT?: number;
  /** qué capas pueden contener caras de muro (por defecto, todas) */
  wallLayers?: (layer: string) => boolean;
  /** descarta tramos sueltos que no tocan ningún otro muro (útil en PDF e imágenes) */
  dropFree?: boolean;
}
export interface Detection { walls: DetWall[]; openings: DetOpening[]; usedSegs: Set<number>; usedArcs: Set<number> }

const NB = 360, BUCKET = Math.PI / NB; // baldes de 0,5° para agrupar rectas paralelas
const DOOR_RE = /puert|door|porta|tur|t[üu]r/i;

interface Ln { i: number; x1: number; y1: number; x2: number; y2: number; ux: number; uy: number; len: number; k: number; claims: number[] }
interface Strip { A: Ln; B: Ln; t: number; ux: number; uy: number; p0: Pt; p1: Pt; ov: number; a0: number; a1: number; b0: number; b1: number; sup: number }
interface Piece { p0: Pt; p1: Pt; t: number; h0: boolean; h1: boolean; x0: boolean; x1: boolean; faces: number[] }

const dirOf = (p: Piece) => { const dx = p.p1.x - p.p0.x, dy = p.p1.y - p.p0.y, l = Math.hypot(dx, dy) || 1; return { x: dx / l, y: dy / l, len: l }; };

export function detectWalls(segs: DSeg[], arcs: DArc[] = [], o: DetectOpts = {}): Detection {
  const minT = o.minT ?? 0.045, maxT = o.maxT ?? 0.45;
  const isWall = o.wallLayers || (() => true);
  const usedSegs = new Set<number>(), usedArcs = new Set<number>();

  // 1. rectas candidatas a ser cara de muro
  const buckets = new Map<number, Ln[]>();
  segs.forEach((s, i) => {
    if (s.dash || !isWall(s.layer || '')) return;
    const dx = s.x2 - s.x1, dy = s.y2 - s.y1, len = Math.hypot(dx, dy);
    if (!(len >= 0.08)) return;
    let th = Math.atan2(dy, dx);
    if (th < 0) th += Math.PI;
    const k = Math.floor(th / BUCKET) % NB;
    const l: Ln = { i, x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, ux: dx / len, uy: dy / len, len, k, claims: [] };
    (buckets.get(k) || buckets.set(k, []).get(k)!).push(l);
  });

  // 2. pares de rectas paralelas a distancia de muro
  const pair = (A0: Ln, B0: Ln): Strip | null => {
    const A = A0.len >= B0.len ? A0 : B0, B = A === A0 ? B0 : A0;
    const nx = -A.uy, ny = A.ux;
    const d1 = (B.x1 - A.x1) * nx + (B.y1 - A.y1) * ny, d2 = (B.x2 - A.x1) * nx + (B.y2 - A.y1) * ny;
    if (Math.abs(d1 - d2) > Math.max(0.008, B.len * 0.012)) return null;
    const d = (d1 + d2) / 2, t = Math.abs(d);
    if (t < minT || t > maxT) return null;
    const s1 = (B.x1 - A.x1) * A.ux + (B.y1 - A.y1) * A.uy, s2 = (B.x2 - A.x1) * A.ux + (B.y2 - A.y1) * A.uy;
    const o0 = Math.max(0, Math.min(s1, s2)), o1 = Math.min(A.len, Math.max(s1, s2)), ov = o1 - o0;
    if (ov < Math.max(0.1, 1.2 * t)) return null;
    const ox = A.x1 + (nx * d) / 2, oy = A.y1 + (ny * d) / 2;
    const bs = (s: number) => (A.x1 + A.ux * s - B.x1) * B.ux + (A.y1 + A.uy * s - B.y1) * B.uy;
    const q0 = bs(o0), q1 = bs(o1);
    return {
      A, B, t, ux: A.ux, uy: A.uy, ov, sup: 0,
      p0: { x: ox + A.ux * o0, y: oy + A.uy * o0 }, p1: { x: ox + A.ux * o1, y: oy + A.uy * o1 },
      a0: o0, a1: o1, b0: Math.min(q0, q1), b1: Math.max(q0, q1),
    };
  };
  const strips: Strip[] = [];
  for (const [k, Lk] of buckets) {
    const nextK = (k + 1) % NB;
    const next = nextK !== k ? buckets.get(nextK) || [] : [];
    const all = next.length ? Lk.concat(next) : Lk;
    const ang = (k + 0.5) * BUCKET, nx = -Math.sin(ang), ny = Math.cos(ang);
    const off = all.map(l => ((l.x1 + l.x2) / 2) * nx + ((l.y1 + l.y2) / 2) * ny);
    const order = all.map((_, j) => j).sort((p, q) => off[p] - off[q]);
    const nk = Lk.length;
    for (let a = 0; a < order.length; a++) {
      const ia = order[a];
      for (let b = a + 1; b < order.length; b++) {
        const ib = order[b];
        if (off[ib] - off[ia] > maxT + 0.25) break;
        if (ia >= nk && ib >= nk) continue; // ambos del balde siguiente: se emparejan allí
        const st = pair(all[ia], all[ib]);
        if (st) strips.push(st);
      }
    }
  }

  // 3. se prefieren los grosores más repetidos en el dibujo (los muros reales) y se evita
  //    que una misma recta sea cara de dos muros o que un muro quede dentro de otro
  const hist = new Map<number, number>();
  for (const s of strips) { const b = Math.round(s.t * 100); hist.set(b, (hist.get(b) || 0) + s.ov); }
  for (const s of strips) { const b = Math.round(s.t * 100); s.sup = (hist.get(b) || 0) + 0.5 * ((hist.get(b - 1) || 0) + (hist.get(b + 1) || 0)); }
  strips.sort((x, y) => y.sup - x.sup || y.ov - x.ov);
  const claimed = (l: Ln, a: number, b: number) => { let c = 0; for (let j = 0; j < l.claims.length; j += 2) c += Math.max(0, Math.min(b, l.claims[j + 1]) - Math.max(a, l.claims[j])); return c; };
  const accByK = new Map<number, Strip[]>();
  const nested = (s: Strip, r: Strip) => {
    const nx = -s.uy, ny = s.ux;
    const mx = (r.p0.x + r.p1.x) / 2 - s.p0.x, my = (r.p0.y + r.p1.y) / 2 - s.p0.y;
    if (Math.abs(mx * nx + my * ny) >= (s.t + r.t) / 2 - 0.01) return false;
    const a = (r.p0.x - s.p0.x) * s.ux + (r.p0.y - s.p0.y) * s.uy, b = (r.p1.x - s.p0.x) * s.ux + (r.p1.y - s.p0.y) * s.uy;
    return Math.min(s.ov, Math.max(a, b)) - Math.max(0, Math.min(a, b)) > 0.2 * Math.min(s.ov, r.ov);
  };
  let pieces: Piece[] = [];
  for (const s of strips) {
    if (claimed(s.A, s.a0, s.a1) > 0.2 * s.ov || claimed(s.B, s.b0, s.b1) > 0.2 * s.ov) continue;
    let clash = false;
    for (const dk of [-1, 0, 1]) {
      for (const r of accByK.get((s.A.k + dk + NB) % NB) || []) if (nested(s, r)) { clash = true; break; }
      if (clash) break;
    }
    if (clash) continue;
    s.A.claims.push(s.a0, s.a1); s.B.claims.push(s.b0, s.b1);
    (accByK.get(s.A.k) || accByK.set(s.A.k, []).get(s.A.k)!).push(s);
    pieces.push({ p0: s.p0, p1: s.p1, t: s.t, h0: false, h1: false, x0: false, x1: false, faces: [s.A.i, s.B.i] });
  }

  // 4. esquinas y encuentros: cada extremo se lleva al cruce con el eje del muro vecino
  const heal = () => {
  const orig = pieces.map(p => ({ p0: { ...p.p0 }, p1: { ...p.p1 }, d: dirOf(p) }));
  pieces.forEach((p, pi) => {
    const dp = orig[pi].d;
    for (const e of [0, 1]) {
      const E = e ? orig[pi].p1 : orig[pi].p0;
      let best: Pt | null = null, bd = Infinity;
      for (let qi = 0; qi < pieces.length; qi++) {
        if (qi === pi) continue;
        const q = pieces[qi], dq = orig[qi].d;
        const den = dp.x * dq.y - dp.y * dq.x, sin = Math.abs(den);
        if (sin < 0.2) continue;
        const cos = Math.abs(dp.x * dq.x + dp.y * dq.y);
        const Q0 = orig[qi].p0;
        const s = ((Q0.x - E.x) * dq.y - (Q0.y - E.y) * dq.x) / den;
        const delta = Math.abs(s);
        if (delta > (q.t / 2 + (p.t / 2) * cos) / sin + 0.03 || delta >= bd) continue;
        const X = { x: E.x + dp.x * s, y: E.y + dp.y * s };
        const sq = (X.x - Q0.x) * dq.x + (X.y - Q0.y) * dq.y, rq = (p.t / 2 + (q.t / 2) * cos) / sin + 0.03;
        if (sq < -rq || sq > dq.len + rq) continue;
        bd = delta; best = X;
      }
      if (best) { if (e) { p.p1 = best; p.h1 = true; } else { p.p0 = best; p.h0 = true; } }
    }
  });
  pieces = pieces.filter(p => dirOf(p).len > 0.05);
  };
  heal();

  // 5. vanos: dos tramos alineados con un hueco entre ellos
  const openings: DetOpening[] = [];
  const evidence = (E: Pt, ox: number, oy: number, g: number, t: number) => {
    const nx = -oy, ny = ox;
    const lines: number[] = []; let dashed = 0, inner = 0, doorLayer = false;
    segs.forEach((s, j) => {
      const s1 = (s.x1 - E.x) * ox + (s.y1 - E.y) * oy, s2 = (s.x2 - E.x) * ox + (s.y2 - E.y) * oy;
      const l1 = (s.x1 - E.x) * nx + (s.y1 - E.y) * ny, l2 = (s.x2 - E.x) * nx + (s.y2 - E.y) * ny;
      const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
      if (len < 0.35 * g || Math.abs(l1 - l2) > Math.max(0.02, 0.05 * len)) return;
      if (Math.min(s1, s2) < -0.06 || Math.max(s1, s2) > g + 0.06 || Math.max(Math.abs(l1), Math.abs(l2)) > t / 2 + 0.03) return;
      lines.push(j); if (s.dash) dashed++; if (DOOR_RE.test(s.layer || '')) doorLayer = true;
      if (Math.max(Math.abs(l1), Math.abs(l2)) < t / 2 - 0.008) inner++;
    });
    const singles: { j: number; near: 0 | 1 }[] = [], halves: { j: number; near: 0 | 1 }[] = [];
    arcs.forEach((a, j) => {
      const s = (a.x - E.x) * ox + (a.y - E.y) * oy, l = (a.x - E.x) * nx + (a.y - E.y) * ny;
      if (Math.abs(l) > t / 2 + 0.12) return;
      const near = Math.abs(s) <= 0.12 ? 0 : Math.abs(s - g) <= 0.12 ? 1 : -1;
      if (near < 0) return;
      const k = a.r / g;
      if (k >= 0.8 && k <= 1.15) singles.push({ j, near: near as 0 | 1 });
      else if (k >= 0.4 && k <= 0.6) halves.push({ j, near: near as 0 | 1 });
    });
    // hoja de puerta sin arco (típico al vectorizar una imagen): una línea perpendicular al muro,
    // del largo del vano, que nace en uno de sus bordes
    let leaf: { j: number; near: 0 | 1; tip: Pt } | null = null;
    if (!singles.length && !halves.length) segs.forEach((s, j) => {
      if (leaf) return;
      const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
      if (len < 0.75 * g || len > 1.15 * g || Math.abs((s.x2 - s.x1) * ox + (s.y2 - s.y1) * oy) > 0.15 * len) return;
      for (const [hx, hy, tx, ty] of [[s.x1, s.y1, s.x2, s.y2], [s.x2, s.y2, s.x1, s.y1]]) {
        const sh = (hx - E.x) * ox + (hy - E.y) * oy, lh = Math.abs((hx - E.x) * nx + (hy - E.y) * ny), lt = Math.abs((tx - E.x) * nx + (ty - E.y) * ny);
        if (lh > t / 2 + 0.1 || lt < t / 2 + 0.3 * g) continue;
        const near = Math.abs(sh) <= 0.12 ? 0 : Math.abs(sh - g) <= 0.12 ? 1 : -1;
        if (near >= 0) { leaf = { j, near: near as 0 | 1, tip: { x: tx, y: ty } }; return; }
      }
    });
    return { lines, dashed, inner, doorLayer, singles, halves, leaf: leaf as { j: number; near: 0 | 1; tip: Pt } | null };
  };
  /** ¿hay una rayita perpendicular al muro en el centro del vano? (ventana corredera) */
  const midTick = (c: Pt, ux: number, uy: number, t: number) => segs.some(s => {
    const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
    if (len < t * 0.6 || len > t * 1.3) return false;
    if (Math.abs((s.x2 - s.x1) * ux + (s.y2 - s.y1) * uy) > 0.02) return false;
    return Math.abs(((s.x1 + s.x2) / 2 - c.x) * ux + ((s.y1 + s.y2) / 2 - c.y) * uy) < 0.05 && Math.hypot((s.x1 + s.x2) / 2 - c.x, (s.y1 + s.y2) / 2 - c.y) < 0.06;
  });
  const windowStyle = (c: Pt, ux: number, uy: number, t: number, inner: number): DetOpening['style'] => (midTick(c, ux, uy, t) ? 'sliding' : inner >= 2 ? 'single' : 'fixed');
  const arcMid = (a: DArc): Pt => { let sw = a.a1 - a.a0; while (sw <= 0) sw += Math.PI * 2; const m = a.a0 + sw / 2; return { x: a.x + Math.cos(m) * a.r, y: a.y + Math.sin(m) * a.r }; };
  const useLeaf = (a: DArc) => segs.forEach((s, j) => {
    const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
    if (len < 0.85 * a.r || len > 1.1 * a.r) return;
    if (Math.hypot(s.x1 - a.x, s.y1 - a.y) < 0.08 || Math.hypot(s.x2 - a.x, s.y2 - a.y) < 0.08) usedSegs.add(j);
  });

  for (let guard = 0, merged = true; merged && guard < 5000; guard++) {
    merged = false;
    search: for (let pi = 0; pi < pieces.length; pi++) {
      const p = pieces[pi], dp = dirOf(p);
      for (const e of [0, 1]) {
        if (e ? p.h1 || p.x1 : p.h0 || p.x0) continue;
        const E = e ? p.p1 : p.p0, ox = e ? dp.x : -dp.x, oy = e ? dp.y : -dp.y;
        let bq = -1, bf = 0, bg = Infinity;
        for (let qi = 0; qi < pieces.length; qi++) {
          if (qi === pi) continue;
          const q = pieces[qi];
          if (Math.abs(q.t - p.t) > 0.035) continue;
          const dq = dirOf(q);
          for (const f of [0, 1]) {
            if (f ? q.h1 || q.x1 : q.h0 || q.x0) continue;
            const qox = f ? dq.x : -dq.x, qoy = f ? dq.y : -dq.y;
            if (ox * qox + oy * qoy > -0.98) continue;
            const F = f ? q.p1 : q.p0;
            const g = (F.x - E.x) * ox + (F.y - E.y) * oy, lat = Math.abs((F.x - E.x) * -oy + (F.y - E.y) * ox);
            if (lat > 0.03 || g < 0.35 || g > 3.2 || g >= bg) continue;
            bq = qi; bf = f; bg = g;
          }
        }
        if (bq < 0) continue;
        const q = pieces[bq], g = bg, t = Math.max(p.t, q.t);
        // tramos menores que quedaron dentro del hueco (p. ej. las líneas del vidrio) no son muros
        const inside = (P: Pt) => { const s = (P.x - E.x) * ox + (P.y - E.y) * oy, l = Math.abs((P.x - E.x) * -oy + (P.y - E.y) * ox); return s > -0.06 && s < g + 0.06 && l <= t / 2 + 0.03; };
        const ev = evidence(E, ox, oy, g, t);
        let op: DetOpening | null = null;
        const c = { x: E.x + (ox * g) / 2, y: E.y + (oy * g) / 2 };
        const F = { x: E.x + ox * g, y: E.y + oy * g };
        if (ev.singles.length) {
          const s = ev.singles[0], a = arcs[s.j];
          op = { c, width: g, kind: 'door', style: 'single', hinge: s.near ? F : E, swing: arcMid(a) };
          usedArcs.add(s.j); useLeaf(a);
        } else if (ev.halves.length) {
          const a = arcs[ev.halves[0].j];
          op = { c, width: g, kind: 'door', style: 'double', hinge: E, swing: arcMid(a) };
          for (const hf of ev.halves) { usedArcs.add(hf.j); useLeaf(arcs[hf.j]); }
        } else if (ev.leaf) {
          op = { c, width: g, kind: 'door', style: 'single', hinge: ev.leaf.near ? F : E, swing: ev.leaf.tip };
          usedSegs.add(ev.leaf.j);
        } else if (ev.lines.length && ev.dashed === ev.lines.length) op = { c, width: g, kind: 'gap', style: 'single' };
        else if (ev.doorLayer) op = { c, width: g, kind: 'door', style: 'sliding' };
        else if (ev.lines.length) op = { c, width: g, kind: 'window', style: windowStyle(c, ox, oy, t, ev.inner) };
        else if (g <= 2) op = { c, width: g, kind: 'gap', style: 'single' };
        if (!op) { if (e) p.x1 = true; else p.x0 = true; continue; }
        for (const j of ev.lines) usedSegs.add(j);
        openings.push(op);
        const pFar = e ? p.p0 : p.p1, qFar = bf ? q.p0 : q.p1;
        const np: Piece = {
          p0: pFar, p1: qFar, t: dp.len >= dirOf(q).len ? p.t : q.t,
          h0: e ? p.h0 : p.h1, h1: bf ? q.h0 : q.h1, x0: e ? p.x0 : p.x1, x1: bf ? q.x0 : q.x1,
          faces: p.faces.concat(q.faces),
        };
        pieces = pieces.filter((x, xi) => xi !== pi && xi !== bq && !(inside(x.p0) && inside(x.p1)));
        pieces.push(np);
        merged = true;
        break search;
      }
    }
  }

  // al unir tramos a través de un vano el eje puede moverse unos milímetros (sobre todo en
  // imágenes): se vuelven a llevar los extremos al cruce exacto para que los recintos cierren
  heal();
  if (o.dropFree) pieces = pieces.filter(p => p.h0 || p.h1);
  for (const p of pieces) for (const f of p.faces) usedSegs.add(f);

  // 6. ventanas dibujadas dentro del espesor de un muro cuyas caras no se interrumpen
  for (const p of pieces) {
    const d = dirOf(p), nx = -d.y, ny = d.x;
    const found: { a: number; b: number; offs: number[]; js: number[] }[] = [];
    segs.forEach((s, j) => {
      if (usedSegs.has(j) || s.dash) return;
      const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
      if (len < 0.3 || len > Math.min(5, d.len - 0.04)) return;
      const l1 = (s.x1 - p.p0.x) * nx + (s.y1 - p.p0.y) * ny, l2 = (s.x2 - p.p0.x) * nx + (s.y2 - p.p0.y) * ny;
      if (Math.abs(l1 - l2) > 0.01 || Math.max(Math.abs(l1), Math.abs(l2)) > p.t / 2 - 0.008) return;
      const s1 = (s.x1 - p.p0.x) * d.x + (s.y1 - p.p0.y) * d.y, s2 = (s.x2 - p.p0.x) * d.x + (s.y2 - p.p0.y) * d.y;
      const a = Math.min(s1, s2), b = Math.max(s1, s2);
      if (a < -0.03 || b > d.len + 0.03) return;
      const hit = found.find(w => Math.min(b, w.b) - Math.max(a, w.a) > 0.5 * Math.min(b - a, w.b - w.a));
      if (hit) { hit.a = Math.min(hit.a, a); hit.b = Math.max(hit.b, b); hit.js.push(j); if (!hit.offs.some(x => Math.abs(x - l1) < 0.008)) hit.offs.push(l1); }
      else found.push({ a, b, offs: [l1], js: [j] });
    });
    for (const w of found) {
      // las líneas de vidrio van centradas en el muro; un borde de mueble que lo roza, no
      const lo = Math.min(...w.offs), hi = Math.max(...w.offs);
      if (w.offs.length === 1 ? Math.abs(lo) > 0.012 : Math.abs(lo + hi) > 0.015) continue;
      const m = (w.a + w.b) / 2, c = { x: p.p0.x + d.x * m, y: p.p0.y + d.y * m };
      openings.push({ c, width: w.b - w.a, kind: 'window', style: windowStyle(c, d.x, d.y, p.t, w.offs.length) });
      for (const j of w.js) usedSegs.add(j);
    }
  }

  const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
  const walls: DetWall[] = pieces.map(p => ({ a: { x: r4(p.p0.x), y: r4(p.p0.y) }, b: { x: r4(p.p1.x), y: r4(p.p1.y) }, t: Math.max(0.05, Math.round(p.t * 200) / 200) }));
  return { walls, openings, usedSegs, usedArcs };
}
