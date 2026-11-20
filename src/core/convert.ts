// Convierte un dibujo de referencia (líneas importadas) en muros, puertas y
// ventanas editables. Lo que no se reconoce como muro puede conservarse como calco.

import type { ID, Level, Shape } from './model';
import { uid } from './model';
import { dot, perp, pointInPoly, sub, unit } from './geom';
import { detectWalls, type DArc, type DSeg, type Detection, type DetectOpts } from './detect';
import { addOpeningAt, nameRoomAt, OPENING_DEFAULTS } from './ops';
import { addWall, computeRooms, dissolveNode, nodeMap } from './topology';
import { roomTypeFromName } from './themes';

export const WALL_LAYER_RE = /mur|wall|pared|tabi|mauer|wand|parede|muro|a-wall/i;

interface Geo { segs: DSeg[]; segRef: [number, number][]; arcs: DArc[]; arcRef: number[] }

function geometry(shapes: Shape[]): Geo {
  const segs: DSeg[] = [], segRef: [number, number][] = [], arcs: DArc[] = [], arcRef: number[] = [];
  shapes.forEach((s, si) => {
    if (s.kind === 'poly') {
      const n = s.pts.length / 2;
      const count = s.closed && n >= 3 ? n : n - 1;
      for (let k = 0; k < count; k++) {
        const a = k * 2, b = ((k + 1) % n) * 2;
        segs.push({ x1: s.pts[a], y1: s.pts[a + 1], x2: s.pts[b], y2: s.pts[b + 1], layer: s.layer, dash: s.dash });
        segRef.push([si, k]);
      }
    } else if (s.kind === 'arc') { arcs.push({ x: s.pts[0], y: s.pts[1], r: s.r || 0, a0: s.a0 || 0, a1: s.a1 || 0, layer: s.layer }); arcRef.push(si); }
  });
  return { segs, segRef, arcs, arcRef };
}

/** Un DXF exportado por PlanoLibre: sus cotas y áreas se vuelven a generar solas. */
function isOwnExport(shapes: Shape[]): boolean {
  let muros = false, other = false;
  for (const s of shapes) { if (s.layer === 'MUROS') muros = true; else if (s.layer === 'COTAS' || s.layer === 'RECINTOS') other = true; }
  return muros && other;
}

export function layersOf(shapes: Shape[]): string[] {
  return [...new Set(shapes.map(s => s.layer || '0'))].sort((a, b) => a.localeCompare(b));
}

/** Capas donde se buscarán muros si el usuario no elige: las que se llaman "muros", o todas. */
export function defaultWallLayers(shapes: Shape[]): Set<string> | null {
  const named = layersOf(shapes).filter(l => WALL_LAYER_RE.test(l));
  return named.length ? new Set(named) : null;
}

export interface ConvertOpts extends DetectOpts {
  /** capas donde buscar muros; null = automático */
  layers?: Set<string> | null;
  height: number;
  /** conservar como calco lo que no sea muro */
  keepRest: boolean;
}
export interface ConvertResult { walls: number; doors: number; windows: number; gaps: number; named: number; rest: Shape[]; wallIds: ID[] }

function run(shapes: Shape[], o: Partial<ConvertOpts>): { geo: Geo; det: Detection } {
  const geo = geometry(shapes);
  const layers = o.layers === undefined || o.layers === null ? defaultWallLayers(shapes) : o.layers;
  const det = detectWalls(geo.segs, geo.arcs, { minT: o.minT, maxT: o.maxT, dropFree: o.dropFree, wallLayers: layers ? l => layers.has(l || '0') : undefined });
  return { geo, det };
}

/** Sólo detecta (para mostrar un adelanto o para ajustar el cursor al eje del calco). */
export function previewWalls(shapes: Shape[], o: Partial<ConvertOpts> = {}): Detection {
  return run(shapes, o).det;
}

/** Agrega al nivel los muros y vanos detectados en `shapes` y devuelve lo que sobra. */
export function convertShapes(level: Level, shapes: Shape[], o: ConvertOpts): ConvertResult {
  const { geo, det } = run(shapes, o);
  const res: ConvertResult = { walls: 0, doors: 0, windows: 0, gaps: 0, named: 0, rest: [], wallIds: [] };
  if (!det.walls.length) { res.rest = shapes; return res; }
  const nodesBefore = new Set(level.nodes.map(n => n.id));
  for (const w of det.walls) res.wallIds.push(...addWall(level, w.a, w.b, w.t, o.height));

  for (const op of det.openings) {
    const d = OPENING_DEFAULTS[op.kind];
    const made = addOpeningAt(level, op.c, op.kind, Math.round(op.width * 1000) / 1000, op.style);
    if (!made) continue;
    made.height = d.height; made.sill = d.sill;
    if (op.kind === 'door') res.doors++; else if (op.kind === 'window') res.windows++; else res.gaps++;
    if (op.hinge && op.swing) {
      const w = level.walls.find(x => x.id === made.wall)!, nm = nodeMap(level);
      const dir = unit(sub(nm.get(w.b)!, nm.get(w.a)!)), n = perp(dir);
      made.flipH = dot(sub(op.hinge, op.c), dir) > 0;
      made.flipV = dot(sub(op.swing, op.c), n) < 0;
    }
  }
  // los tramos alineados que quedaron separados sólo por un punto se funden en un muro
  for (const n of level.nodes.slice()) if (!nodesBefore.has(n.id)) dissolveNode(level, n.id);
  const alive = new Set(level.walls.map(w => w.id));
  res.wallIds = [...new Set(res.wallIds)].filter(id => alive.has(id));
  res.walls = level.walls.filter(w => !nodesBefore.has(w.a) || !nodesBefore.has(w.b)).length;

  // textos que nombran recintos ("Cocina", "Dormitorio 2"…) pasan a ser el nombre del recinto
  const own = isOwnExport(shapes);
  const rooms = computeRooms(level);
  const dropShape = new Set<number>();
  shapes.forEach((s, si) => {
    if (own && (s.layer === 'COTAS' || s.layer === 'RECINTOS') && s.kind !== 'text') dropShape.add(si);
    if (s.kind !== 'text' || !s.text) return;
    const txt = s.text.trim();
    if (own && s.layer === 'COTAS') { dropShape.add(si); return; }
    const isNumber = /^[\d.,'"\s]+(m²|m2|m|cm|mm)?$/i.test(txt);
    if (own && s.layer === 'RECINTOS' && isNumber) { dropShape.add(si); return; }
    if (isNumber || txt.length > 32) return;
    if (!(own && s.layer === 'RECINTOS') && roomTypeFromName(txt) === 'other') return;
    const p = { x: s.pts[0], y: s.pts[1] };
    const room = rooms.find(r => pointInPoly(p, r.poly));
    if (!room) return;
    if (!level.rooms.some(m => pointInPoly(m, room.poly))) { nameRoomAt(level, room.center, txt); res.named++; }
    dropShape.add(si);
  });

  if (!o.keepRest) return res;

  // lo que sobra: se quitan las caras de muro, lo usado en puertas y ventanas, y los restos dentro de un muro
  const nm = nodeMap(level);
  const bodies = level.walls.filter(w => alive.has(w.id) && (!nodesBefore.has(w.a) || !nodesBefore.has(w.b))).map(w => {
    const a = nm.get(w.a)!, b = nm.get(w.b)!, dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    return { ax: a.x, ay: a.y, ux: dx / len, uy: dy / len, len, h: w.thickness / 2 };
  });
  const inBody = (x: number, y: number) => bodies.some(b => {
    const s = (x - b.ax) * b.ux + (y - b.ay) * b.uy, l = Math.abs((x - b.ax) * -b.uy + (y - b.ay) * b.ux);
    return l <= b.h + 0.012 && s >= -b.h - 0.02 && s <= b.len + b.h + 0.02;
  });
  const dropSeg = new Map<number, Set<number>>();
  geo.segs.forEach((s, j) => {
    if (!det.usedSegs.has(j) && !(inBody(s.x1, s.y1) && inBody(s.x2, s.y2))) return;
    const [si, k] = geo.segRef[j];
    (dropSeg.get(si) || dropSeg.set(si, new Set()).get(si)!).add(k);
  });
  for (const j of det.usedArcs) dropShape.add(geo.arcRef[j]);
  shapes.forEach((s, si) => {
    if (dropShape.has(si)) return;
    const drop = dropSeg.get(si);
    if (s.kind !== 'poly' || !drop) { res.rest.push(s); return; }
    // la polilínea se corta en los tramos que no se usaron
    const n = s.pts.length / 2, count = s.closed && n >= 3 ? n : n - 1;
    let runPts: number[] = [];
    const flush = () => { if (runPts.length >= 4) res.rest.push({ ...s, id: uid('s'), pts: runPts, closed: false }); runPts = []; };
    for (let k = 0; k < count; k++) {
      if (drop.has(k)) { flush(); continue; }
      const a = k * 2, b = ((k + 1) % n) * 2;
      if (!runPts.length) runPts.push(s.pts[a], s.pts[a + 1]);
      runPts.push(s.pts[b], s.pts[b + 1]);
    }
    flush();
  });
  return res;
}
