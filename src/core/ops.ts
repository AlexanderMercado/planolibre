// Operaciones de alto nivel sobre un nivel: agregar aberturas, mobiliario y nombres.

import type { Item, Level, Opening, OpeningKind, OpeningStyle, Pt } from './model';
import { uid } from './model';
import { projSeg } from './geom';
import { nodeMap } from './topology';
import { roomTypeFromName } from './themes';
import { symbolDef } from './symbols';

export const OPENING_DEFAULTS: Record<OpeningKind, { width: number; height: number; sill: number; style: OpeningStyle }> = {
  door: { width: 0.8, height: 2.05, sill: 0, style: 'single' },
  window: { width: 1.2, height: 1.2, sill: 0.9, style: 'sliding' },
  gap: { width: 1.0, height: 2.05, sill: 0, style: 'single' },
};

/** Muro más cercano a un punto (por su eje). */
export function nearestWall(level: Level, p: Pt, maxDist = 0.3): { id: string; t: number; d: number; proj: Pt } | null {
  const nodes = nodeMap(level);
  let best: { id: string; t: number; d: number; proj: Pt } | null = null;
  for (const w of level.walls) {
    const a = nodes.get(w.a), b = nodes.get(w.b);
    if (!a || !b) continue;
    const pr = projSeg(p, a, b);
    if (pr.d <= maxDist && (!best || pr.d < best.d)) best = { id: w.id, t: pr.t, d: pr.d, proj: pr.p };
  }
  return best;
}

export function addOpeningAt(level: Level, p: Pt, kind: OpeningKind, width?: number, style?: OpeningStyle, flipH = false, flipV = false): Opening | null {
  const best = nearestWall(level, p);
  if (!best) return null;
  const d = OPENING_DEFAULTS[kind];
  const o: Opening = { id: uid('o'), wall: best.id, t: best.t, width: width ?? d.width, kind, style: style ?? d.style, flipH, flipV, height: d.height, sill: d.sill };
  level.openings.push(o);
  return o;
}

export function addItem(level: Level, type: string, x: number, y: number, rot = 0, w?: number, h?: number): Item {
  const d = symbolDef(type);
  const it: Item = { id: uid('i'), type, x, y, w: w ?? d.w, h: h ?? d.h, rot };
  level.items.push(it);
  return it;
}

export function nameRoomAt(level: Level, p: Pt, name: string) {
  level.rooms.push({ id: uid('r'), x: p.x, y: p.y, name, type: roomTypeFromName(name) });
}
