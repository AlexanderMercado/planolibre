// Topología del plano: los muros comparten nodos, se parten automáticamente
// cuando se cruzan, y los recintos (habitaciones) se detectan como las caras
// del grafo plano que forman.

import type { ID, Level, Opening, PNode, Pt, RoomMeta, Wall } from './model';
import { uid } from './model';
import { add, cross, dist, labelPoint, lineLine, mul, perp, pointInPoly, polyArea, polyPerimeter, projSeg, segSeg, sub, unit } from './geom';

export const TOL = 0.004; // 4 mm

export function nodeMap(level: Level): Map<ID, PNode> {
  const m = new Map<ID, PNode>();
  for (const n of level.nodes) m.set(n.id, n);
  return m;
}

export function wallsAt(level: Level, nodeId: ID): Wall[] {
  return level.walls.filter(w => w.a === nodeId || w.b === nodeId);
}

export function findNodeNear(level: Level, p: Pt, tol = TOL, exclude?: ID): PNode | null {
  let best: PNode | null = null, bd = tol;
  for (const n of level.nodes) {
    if (n.id === exclude) continue;
    const d = dist(n, p);
    if (d <= bd) { bd = d; best = n; }
  }
  return best;
}

function ensureNode(level: Level, p: Pt): PNode {
  const found = findNodeNear(level, p);
  if (found) return found;
  const n: PNode = { id: uid('n'), x: p.x, y: p.y };
  level.nodes.push(n);
  return n;
}

/** Invierte el sentido de un muro conservando el aspecto de sus puertas y ventanas. */
export function reverseWall(level: Level, w: Wall) {
  const t = w.a; w.a = w.b; w.b = t;
  for (const o of level.openings) if (o.wall === w.id) { o.t = 1 - o.t; o.flipH = !o.flipH; o.flipV = !o.flipV; }
}

/** Parte un muro en un nodo existente que está sobre su eje. Devuelve la segunda mitad. */
function splitWallAtNode(level: Level, w: Wall, n: PNode, nodes: Map<ID, PNode>): Wall {
  const a = nodes.get(w.a)!, b = nodes.get(w.b)!;
  const total = dist(a, b) || 1;
  const ts = Math.min(0.999, Math.max(0.001, dist(a, n) / total));
  const w2: Wall = { ...w, id: uid('w'), a: n.id, b: w.b };
  w.b = n.id;
  for (const o of level.openings) {
    if (o.wall !== w.id) continue;
    if (o.t <= ts) o.t = o.t / ts;
    else { o.wall = w2.id; o.t = (o.t - ts) / (1 - ts); }
  }
  level.walls.push(w2);
  return w2;
}

/** Parte un muro en un punto (crea el nodo). Devuelve el nodo nuevo. */
export function splitWall(level: Level, wallId: ID, p: Pt): PNode | null {
  const w = level.walls.find(x => x.id === wallId);
  if (!w) return null;
  const nodes = nodeMap(level);
  const a = nodes.get(w.a)!, b = nodes.get(w.b)!;
  const pr = projSeg(p, a, b);
  if (pr.t * dist(a, b) < TOL || (1 - pr.t) * dist(a, b) < TOL) return null;
  const n: PNode = { id: uid('n'), x: pr.p.x, y: pr.p.y };
  level.nodes.push(n);
  nodes.set(n.id, n);
  splitWallAtNode(level, w, n, nodes);
  return n;
}

function shares(w: Wall, v: Wall) { return w.a === v.a || w.a === v.b || w.b === v.a || w.b === v.b; }

/**
 * Integra muros en el grafo: los parte donde cruzan a otros o donde pasan por
 * encima de un nodo, y parte los muros ajenos donde un extremo cae sobre ellos.
 */
export function integrateWalls(level: Level, wallIds: ID[]) {
  const queue = [...wallIds];
  let guard = 0;
  outer: while (queue.length && guard++ < 4000) {
    const id = queue.pop()!;
    const W = level.walls.find(w => w.id === id);
    if (!W) continue;
    const nodes = nodeMap(level);
    const A = nodes.get(W.a), B = nodes.get(W.b);
    if (!A || !B) continue;
    const L = dist(A, B);
    if (L < TOL) continue;
    // 1) nodos que quedaron sobre el cuerpo del muro
    for (const n of level.nodes) {
      if (n.id === W.a || n.id === W.b) continue;
      const pr = projSeg(n, A, B);
      if (pr.d < TOL && pr.t * L > TOL && (1 - pr.t) * L > TOL) {
        const w2 = splitWallAtNode(level, W, n, nodes);
        queue.push(W.id, w2.id);
        continue outer;
      }
    }
    for (const V of level.walls) {
      if (V === W) continue;
      const Va = nodes.get(V.a), Vb = nodes.get(V.b);
      if (!Va || !Vb) continue;
      const VL = dist(Va, Vb);
      if (VL < TOL) continue;
      // 2) un extremo de W cae sobre el cuerpo de V
      for (const end of [A, B]) {
        if (end.id === V.a || end.id === V.b) continue;
        const pr = projSeg(end, Va, Vb);
        if (pr.d < TOL && pr.t * VL > TOL && (1 - pr.t) * VL > TOL) {
          splitWallAtNode(level, V, end, nodes);
          queue.push(W.id);
          continue outer;
        }
      }
      // 3) cruce en X
      if (shares(W, V)) continue;
      const r = segSeg(A, B, Va, Vb);
      if (r && r.s * L > TOL && (1 - r.s) * L > TOL && r.u * VL > TOL && (1 - r.u) * VL > TOL) {
        const n: PNode = { id: uid('n'), x: r.p.x, y: r.p.y };
        level.nodes.push(n); nodes.set(n.id, n);
        splitWallAtNode(level, V, n, nodes);
        const w2 = splitWallAtNode(level, W, n, nodes);
        queue.push(W.id, w2.id);
        continue outer;
      }
    }
  }
  cleanup(level);
}

/** Agrega un muro entre dos puntos, uniéndolo a lo que ya existe. Devuelve los ids creados. */
export function addWall(level: Level, p1: Pt, p2: Pt, thickness: number, height: number): ID[] {
  if (dist(p1, p2) < TOL) return [];
  const before = new Set(level.walls.map(w => w.id));
  const a = ensureNode(level, p1), b = ensureNode(level, p2);
  if (a === b) return [];
  const w: Wall = { id: uid('w'), a: a.id, b: b.id, thickness, height };
  level.walls.push(w);
  integrateWalls(level, [w.id]);
  // sólo los tramos que quedaron sobre el trazo nuevo (no las mitades de muros ajenos que se partieron)
  const nodes = nodeMap(level);
  const onSeg = (id: ID) => { const n = nodes.get(id); return !!n && projSeg(n, p1, p2).d < TOL * 2; };
  return level.walls.filter(x => !before.has(x.id) && onSeg(x.a) && onSeg(x.b)).map(x => x.id);
}

/** Fusiona un nodo dentro de otro. */
export function mergeNodes(level: Level, fromId: ID, toId: ID) {
  if (fromId === toId) return;
  for (const w of level.walls) { if (w.a === fromId) w.a = toId; if (w.b === fromId) w.b = toId; }
  level.nodes = level.nodes.filter(n => n.id !== fromId);
}

/** Después de mover nodos: fusiona los que coinciden y vuelve a integrar sus muros. */
export function settleNodes(level: Level, nodeIds: ID[]) {
  const moved = new Set(nodeIds);
  for (const id of nodeIds) {
    const n = level.nodes.find(x => x.id === id);
    if (!n) continue;
    const other = level.nodes.find(o => o.id !== id && !moved.has(o.id) && dist(o, n) < TOL)
      || level.nodes.find(o => o.id !== id && dist(o, n) < TOL);
    if (other) { mergeNodes(level, id, other.id); moved.add(other.id); }
  }
  cleanup(level);
  const ids = level.walls.filter(w => moved.has(w.a) || moved.has(w.b)).map(w => w.id);
  integrateWalls(level, ids);
}

/** Elimina restos: muros degenerados o duplicados, nodos sueltos, aberturas huérfanas. */
export function cleanup(level: Level) {
  const nodes = nodeMap(level);
  const seen = new Map<string, Wall>();
  const keep: Wall[] = [];
  for (const w of level.walls) {
    const a = nodes.get(w.a), b = nodes.get(w.b);
    if (!a || !b || w.a === w.b || dist(a, b) < TOL) continue;
    const key = w.a < w.b ? w.a + '|' + w.b : w.b + '|' + w.a;
    const dup = seen.get(key);
    if (dup) {
      // las aberturas del duplicado pasan al muro que se conserva
      for (const o of level.openings) if (o.wall === w.id) { o.wall = dup.id; if (dup.a !== w.a) { o.t = 1 - o.t; o.flipH = !o.flipH; o.flipV = !o.flipV; } }
      continue;
    }
    seen.set(key, w); keep.push(w);
  }
  level.walls = keep;
  const used = new Set<ID>();
  for (const w of keep) { used.add(w.a); used.add(w.b); }
  level.nodes = level.nodes.filter(n => used.has(n.id));
  const wallIds = new Set(keep.map(w => w.id));
  level.openings = level.openings.filter(o => wallIds.has(o.wall));
  for (const o of level.openings) o.t = Math.max(0, Math.min(1, o.t));
}

/** Si un nodo une sólo dos muros alineados del mismo grosor, los funde en uno. */
export function dissolveNode(level: Level, nodeId: ID): boolean {
  const ws = wallsAt(level, nodeId);
  if (ws.length !== 2) return false;
  const [w1, w2] = ws;
  if (Math.abs(w1.thickness - w2.thickness) > 1e-6) return false;
  const nodes = nodeMap(level);
  if (w1.b !== nodeId) reverseWall(level, w1);
  if (w2.a !== nodeId) reverseWall(level, w2);
  const a = nodes.get(w1.a)!, n = nodes.get(nodeId)!, b = nodes.get(w2.b)!;
  if (w1.a === w2.b) return false;
  const d1 = unit(sub(n, a)), d2 = unit(sub(b, n));
  if (Math.abs(cross(d1, d2)) > 0.01 || d1.x * d2.x + d1.y * d2.y < 0) return false;
  const L1 = dist(a, n), L2 = dist(n, b), L = L1 + L2;
  for (const o of level.openings) {
    if (o.wall === w1.id) o.t = (o.t * L1) / L;
    else if (o.wall === w2.id) { o.wall = w1.id; o.t = (L1 + o.t * L2) / L; }
  }
  w1.b = w2.b;
  level.walls = level.walls.filter(w => w !== w2);
  level.nodes = level.nodes.filter(x => x.id !== nodeId);
  return true;
}

export function removeWalls(level: Level, ids: ID[]) {
  const set = new Set(ids);
  const ends = new Set<ID>();
  for (const w of level.walls) if (set.has(w.id)) { ends.add(w.a); ends.add(w.b); }
  level.walls = level.walls.filter(w => !set.has(w.id));
  cleanup(level);
  for (const id of ends) dissolveNode(level, id);
}

/** Elimina un nodo: si une dos muros los reemplaza por uno directo; si no, borra sus muros. */
export function removeNode(level: Level, nodeId: ID) {
  const ws = wallsAt(level, nodeId);
  if (ws.length === 2) {
    const [w1, w2] = ws;
    const o1 = w1.a === nodeId ? w1.b : w1.a, o2 = w2.a === nodeId ? w2.b : w2.a;
    if (o1 !== o2) {
      if (w1.b !== nodeId) reverseWall(level, w1);
      w1.b = o2;
      level.walls = level.walls.filter(w => w !== w2);
      level.openings = level.openings.filter(o => o.wall !== w2.id);
      cleanup(level);
      integrateWalls(level, [w1.id]);
      return;
    }
  }
  removeWalls(level, ws.map(w => w.id));
}

// ───────────────────────── Geometría de muros con grosor ─────────────────────────

export interface WallGeom {
  wall: Wall; a: Pt; b: Pt; len: number; dir: Pt; nrm: Pt;
  aL: Pt; aR: Pt; bL: Pt; bR: Pt; capA: boolean; capB: boolean;
}

/** Calcula las esquinas de cada muro resolviendo los encuentros en inglete. */
export function wallGeoms(level: Level): Map<ID, WallGeom> {
  const nodes = nodeMap(level);
  const out = new Map<ID, WallGeom>();
  type Inc = { g: WallGeom; isA: boolean; ang: number; d: Pt; n: Pt; h: number; plus?: Pt; minus?: Pt };
  const byNode = new Map<ID, Inc[]>();
  for (const w of level.walls) {
    const a = nodes.get(w.a), b = nodes.get(w.b);
    if (!a || !b) continue;
    const L = dist(a, b);
    if (L < 1e-6) continue;
    const d = unit(sub(b, a)), n = perp(d), h = w.thickness / 2;
    const g: WallGeom = {
      wall: w, a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, len: L, dir: d, nrm: n,
      aL: add(a, mul(n, h)), aR: sub(a, mul(n, h)), bL: add(b, mul(n, h)), bR: sub(b, mul(n, h)), capA: false, capB: false,
    };
    out.set(w.id, g);
    const ia: Inc = { g, isA: true, ang: Math.atan2(d.y, d.x), d, n, h };
    const dn = mul(d, -1);
    const ib: Inc = { g, isA: false, ang: Math.atan2(dn.y, dn.x), d: dn, n: perp(dn), h };
    (byNode.get(w.a) || byNode.set(w.a, []).get(w.a)!).push(ia);
    (byNode.get(w.b) || byNode.set(w.b, []).get(w.b)!).push(ib);
  }
  for (const [id, list] of byNode) {
    const c = nodes.get(id)!;
    if (list.length === 1) {
      const i = list[0];
      if (i.isA) i.g.capA = true; else i.g.capB = true;
      continue;
    }
    list.sort((p, q) => p.ang - q.ang);
    for (let k = 0; k < list.length; k++) {
      const i = list[k], j = list[(k + 1) % list.length];
      const Pi = add(c, mul(i.n, i.h)), Pj = sub(c, mul(j.n, j.h));
      const cr = cross(i.d, j.d);
      let C: Pt | null = null;
      if (Math.abs(cr) > 0.03) {
        C = lineLine(Pi, i.d, Pj, j.d);
        if (C && dist(C, c) > 5 * Math.max(i.h, j.h) + 0.01) C = null;
      }
      i.plus = C || Pi; j.minus = C || Pj;
    }
    for (const i of list) {
      if (i.isA) { i.g.aL = i.plus!; i.g.aR = i.minus!; }
      else { i.g.bR = i.plus!; i.g.bL = i.minus!; }
    }
  }
  return out;
}

export interface OpeningFrame { o: Opening; g: WallGeom; s0: number; s1: number; p0: Pt; p1: Pt; c: Pt; width: number; thick: number }

/** Posición real de cada abertura sobre su muro (recortada al largo disponible). */
export function openingFrames(level: Level, geoms: Map<ID, WallGeom>): OpeningFrame[] {
  const out: OpeningFrame[] = [];
  for (const o of level.openings) {
    const g = geoms.get(o.wall);
    if (!g) continue;
    const margin = Math.min(0.03, g.len * 0.05);
    const w = Math.min(o.width, g.len - margin * 2);
    if (w <= 0.05) continue;
    let s0 = o.t * g.len - w / 2;
    s0 = Math.max(margin, Math.min(g.len - margin - w, s0));
    const s1 = s0 + w;
    out.push({ o, g, s0, s1, p0: add(g.a, mul(g.dir, s0)), p1: add(g.a, mul(g.dir, s1)), c: add(g.a, mul(g.dir, (s0 + s1) / 2)), width: w, thick: g.wall.thickness });
  }
  return out;
}

export interface WallPieces { g: WallGeom; fills: Pt[][]; lines: [Pt, Pt][] }

/** Polígonos de relleno y líneas de contorno de cada muro, con los vanos ya descontados. */
export function wallPieces(geoms: Map<ID, WallGeom>, frames: OpeningFrame[]): WallPieces[] {
  const byWall = new Map<ID, OpeningFrame[]>();
  for (const f of frames) (byWall.get(f.g.wall.id) || byWall.set(f.g.wall.id, []).get(f.g.wall.id)!).push(f);
  const res: WallPieces[] = [];
  for (const g of geoms.values()) {
    const fs = (byWall.get(g.wall.id) || []).slice().sort((p, q) => p.s0 - q.s0);
    const h = g.wall.thickness / 2;
    const fills: Pt[][] = [], lines: [Pt, Pt][] = [];
    let sL = g.aL, sR = g.aR, first = true, last = -1;
    for (const f of fs) {
      if (f.s0 < last) continue; // aberturas superpuestas: se ignora la segunda
      const c0 = add(g.a, mul(g.dir, f.s0)), c1 = add(g.a, mul(g.dir, f.s1));
      const eL = add(c0, mul(g.nrm, h)), eR = sub(c0, mul(g.nrm, h));
      fills.push(first ? [sL, eL, eR, sR, g.a] : [sL, eL, eR, sR]);
      lines.push([sL, eL], [sR, eR], [eL, eR]);
      sL = add(c1, mul(g.nrm, h)); sR = sub(c1, mul(g.nrm, h));
      lines.push([sL, sR]);
      first = false; last = f.s1;
    }
    fills.push(first ? [sL, g.bL, g.b, g.bR, sR, g.a] : [sL, g.bL, g.b, g.bR, sR]);
    lines.push([sL, g.bL], [sR, g.bR]);
    if (g.capA) lines.push([g.aL, g.aR]);
    if (g.capB) lines.push([g.bL, g.bR]);
    res.push({ g, fills, lines });
  }
  return res;
}

// ───────────────────────────── Detección de recintos ─────────────────────────────

export interface RoomEdge { a: Pt; b: Pt; len: number }
export interface Room {
  key: string;
  /** polígono por los ejes de los muros */
  poly: Pt[];
  nodeIds: ID[];
  wallIds: ID[];
  /** polígono interior (cara interna de los muros) */
  inner: Pt[];
  holes: Pt[][];
  /** superficie útil interior en m² */
  area: number;
  perimeter: number;
  center: Pt;
  /** lados interiores con tramos alineados ya fusionados */
  edges: RoomEdge[];
  meta?: RoomMeta;
}

/** Desplaza cada lado de un polígono según el medio grosor de su muro (positivo = hacia adentro). */
function offsetPoly(poly: Pt[], halves: number[]): Pt[] {
  const n = poly.length;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const prev = (i - 1 + n) % n;
    const p0 = poly[prev], p1 = poly[i], p2 = poly[(i + 1) % n];
    const d1 = unit(sub(p1, p0)), d2 = unit(sub(p2, p1));
    const n1 = perp(d1), n2 = perp(d2);
    const A = add(p1, mul(n1, halves[prev])), B = add(p1, mul(n2, halves[i]));
    let C: Pt | null = null;
    if (Math.abs(cross(d1, d2)) > 0.02) C = lineLine(A, d1, B, d2);
    if (C && dist(C, p1) > 6 * Math.max(halves[prev], halves[i], 0.02)) C = null;
    out.push(C || B);
  }
  return out;
}

function mergeCollinear(poly: Pt[]): Pt[] {
  const n = poly.length;
  if (n < 4) return poly.slice();
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = poly[(i - 1 + n) % n], p1 = poly[i], p2 = poly[(i + 1) % n];
    const d1 = unit(sub(p1, p0)), d2 = unit(sub(p2, p1));
    if (dist(p0, p1) < 1e-4) continue;
    if (Math.abs(cross(d1, d2)) < 0.01 && d1.x * d2.x + d1.y * d2.y > 0) continue;
    out.push(p1);
  }
  return out.length >= 3 ? out : poly.slice();
}

export function computeRooms(level: Level): Room[] {
  const nodes = nodeMap(level);
  type Edge = { to: ID; wall: Wall; ang: number };
  const adj = new Map<ID, Edge[]>();
  const push = (from: ID, to: ID, wall: Wall) => {
    const a = nodes.get(from)!, b = nodes.get(to)!;
    (adj.get(from) || adj.set(from, []).get(from)!).push({ to, wall, ang: Math.atan2(b.y - a.y, b.x - a.x) });
  };
  for (const w of level.walls) {
    if (!nodes.has(w.a) || !nodes.has(w.b) || w.a === w.b) continue;
    push(w.a, w.b, w); push(w.b, w.a, w);
  }
  // podar muros sin salida: no encierran nada
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, list] of adj) {
      if (list.length === 1) {
        const other = list[0].to;
        adj.delete(id);
        const ol = adj.get(other);
        if (ol) adj.set(other, ol.filter(e => e.to !== id));
        changed = true;
      } else if (list.length === 0) { adj.delete(id); changed = true; }
    }
  }
  for (const list of adj.values()) list.sort((p, q) => p.ang - q.ang);

  type Face = { ids: ID[]; walls: Wall[]; poly: Pt[]; area: number };
  const faces: Face[] = [];
  const visited = new Set<string>();
  for (const [u0, list] of adj) {
    for (const e0 of list) {
      if (visited.has(u0 + '>' + e0.to)) continue;
      const ids: ID[] = [], walls: Wall[] = [];
      let u = u0, e = e0, guard = 0;
      while (guard++ < 10000) {
        visited.add(u + '>' + e.to);
        ids.push(u); walls.push(e.wall);
        const v = e.to, vl = adj.get(v)!;
        const idx = vl.findIndex(x => x.to === u);
        const next = vl[(idx - 1 + vl.length) % vl.length];
        u = v; e = next;
        if (u === u0 && e === e0) break;
      }
      const poly = ids.map(id => { const n = nodes.get(id)!; return { x: n.x, y: n.y }; });
      faces.push({ ids, walls, poly, area: polyArea(poly) });
    }
  }
  const inner = faces.filter(f => f.area > 1e-4);
  const outer = faces.filter(f => f.area < -1e-4);
  const rooms: Room[] = inner.map(f => ({
    key: f.ids.slice().sort().join('.'), poly: f.poly, nodeIds: f.ids, wallIds: f.walls.map(w => w.id),
    inner: offsetPoly(f.poly, f.walls.map(w => w.thickness / 2)), holes: [], area: 0, perimeter: 0, center: f.poly[0], edges: [],
  }));
  // islas: el contorno exterior de un grupo de muros que está dentro de otro recinto
  for (const o of outer) {
    const idset = new Set(o.ids);
    let host: Room | null = null, hostArea = Infinity;
    for (let i = 0; i < rooms.length; i++) {
      const r = rooms[i];
      if (r.nodeIds.some(id => idset.has(id))) continue;
      if (!pointInPoly(o.poly[0], r.poly)) continue;
      const a = inner[i].area;
      if (a < hostArea) { hostArea = a; host = r; }
    }
    if (host) host.holes.push(offsetPoly(o.poly, o.walls.map(w => w.thickness / 2)));
  }
  for (const r of rooms) {
    let area = Math.max(0, polyArea(r.inner));
    for (const h of r.holes) area -= Math.abs(polyArea(h));
    r.area = Math.max(0, area);
    const merged = mergeCollinear(r.inner);
    r.perimeter = polyPerimeter(merged);
    r.edges = merged.map((p, i) => { const q = merged[(i + 1) % merged.length]; return { a: p, b: q, len: dist(p, q) }; });
    r.center = labelPoint(r.inner, r.holes);
  }
  // asociar nombres guardados (cada nombre sigue al recinto que contiene su punto)
  const taken = new Set<Room>();
  for (const m of level.rooms) {
    const r = rooms.find(x => !taken.has(x) && pointInPoly(m, x.poly) && !x.holes.some(h => pointInPoly(m, h)));
    if (r) { r.meta = m; taken.add(r); }
  }
  return rooms;
}

/** Mantiene el punto de anclaje de cada nombre dentro de su recinto. */
export function syncRoomMetas(rooms: Room[]) {
  for (const r of rooms) if (r.meta) { r.meta.x = r.center.x; r.meta.y = r.center.y; }
}

export function levelBounds(level: Level, geoms?: Map<ID, WallGeom>): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const acc = (x: number, y: number) => { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; };
  const gs = geoms || wallGeoms(level);
  for (const g of gs.values()) for (const p of [g.aL, g.aR, g.bL, g.bR]) acc(p.x, p.y);
  for (const it of level.items) { const r = Math.hypot(it.w, it.h) / 2; acc(it.x - r, it.y - r); acc(it.x + r, it.y + r); }
  for (const s of level.shapes) {
    if (s.kind === 'circle' || s.kind === 'arc') { const r = s.r || 0; acc(s.pts[0] - r, s.pts[1] - r); acc(s.pts[0] + r, s.pts[1] + r); }
    else for (let i = 0; i + 1 < s.pts.length; i += 2) acc(s.pts[i], s.pts[i + 1]);
  }
  for (const l of level.labels) acc(l.x, l.y);
  for (const d of level.dims) { acc(d.x1, d.y1); acc(d.x2, d.y2); }
  if (level.background) { const b = level.background; acc(b.x, b.y); acc(b.x + b.w, b.y + b.h); }
  if (minX === Infinity) return null;
  return { minX, minY, maxX, maxY };
}
