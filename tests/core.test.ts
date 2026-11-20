import { describe, expect, it } from 'vitest';
import { newLevel } from '../src/core/model';
import { addWall, computeRooms, integrateWalls, removeWalls, settleNodes, wallGeoms, openingFrames, wallPieces } from '../src/core/topology';
import { sampleProject } from '../src/core/sample';
import { fmtLen, parseLen, fmtArea } from '../src/core/units';
import { buildScene } from '../src/core/scene';
import { THEMES } from '../src/core/themes';

const rect = (lv = newLevel(), x = 0, y = 0, w = 4, h = 3, t = 0.2) => {
  addWall(lv, { x, y }, { x: x + w, y }, t, 2.4);
  addWall(lv, { x: x + w, y }, { x: x + w, y: y + h }, t, 2.4);
  addWall(lv, { x: x + w, y: y + h }, { x, y: y + h }, t, 2.4);
  addWall(lv, { x, y: y + h }, { x, y }, t, 2.4);
  return lv;
};

describe('recintos', () => {
  it('detecta un rectángulo y descuenta el grosor de los muros', () => {
    const lv = rect();
    expect(lv.nodes.length).toBe(4);
    expect(lv.walls.length).toBe(4);
    const rooms = computeRooms(lv);
    expect(rooms.length).toBe(1);
    expect(rooms[0].area).toBeCloseTo(3.8 * 2.8, 6);
    expect(rooms[0].perimeter).toBeCloseTo(2 * (3.8 + 2.8), 6);
    expect(rooms[0].edges.length).toBe(4);
  });

  it('un muro que cruza divide el recinto en dos', () => {
    const lv = rect();
    addWall(lv, { x: 2, y: -1 }, { x: 2, y: 4 }, 0.1, 2.4);
    const rooms = computeRooms(lv);
    expect(rooms.length).toBe(2);
    // 3.8 de ancho menos 0.1 del tabique, repartido en dos
    expect(rooms[0].area + rooms[1].area).toBeCloseTo((3.8 - 0.1) * 2.8, 6);
    // el muro superior e inferior quedaron partidos
    expect(lv.walls.length).toBe(4 + 2 + 3);
  });

  it('un tabique en T parte el muro donde llega y fusiona los lados alineados', () => {
    const lv = rect();
    addWall(lv, { x: 0, y: 1.5 }, { x: 4, y: 1.5 }, 0.1, 2.4);
    const rooms = computeRooms(lv);
    expect(rooms.length).toBe(2);
    for (const r of rooms) expect(r.edges.length).toBe(4);
  });

  it('una isla interior se descuenta del recinto que la contiene', () => {
    const lv = rect(newLevel(), 0, 0, 10, 10, 0.2);
    rect(lv, 4, 4, 2, 2, 0.2);
    const rooms = computeRooms(lv).sort((a, b) => b.area - a.area);
    expect(rooms.length).toBe(2);
    expect(rooms[1].area).toBeCloseTo(1.8 * 1.8, 6);
    expect(rooms[0].area).toBeCloseTo(9.8 * 9.8 - 2.2 * 2.2, 6);
  });

  it('borrar un tabique vuelve a unir el muro partido', () => {
    const lv = rect();
    const ids = addWall(lv, { x: 2, y: 0 }, { x: 2, y: 3 }, 0.1, 2.4);
    expect(lv.walls.length).toBe(7);
    removeWalls(lv, ids);
    expect(lv.walls.length).toBe(4);
    expect(lv.nodes.length).toBe(4);
    expect(computeRooms(lv).length).toBe(1);
  });

  it('arrastrar un nodo sobre otro los fusiona', () => {
    const lv = newLevel();
    addWall(lv, { x: 0, y: 0 }, { x: 4, y: 0 }, 0.2, 2.4);
    addWall(lv, { x: 4, y: 0 }, { x: 4, y: 3 }, 0.2, 2.4);
    addWall(lv, { x: 4, y: 3 }, { x: 0.5, y: 3 }, 0.2, 2.4);
    addWall(lv, { x: 0.5, y: 3 }, { x: 0.2, y: 0.4 }, 0.2, 2.4);
    expect(computeRooms(lv).length).toBe(0);
    const loose = lv.nodes.find(n => n.x === 0.2)!;
    loose.x = 0; loose.y = 0;
    settleNodes(lv, [loose.id]);
    expect(lv.nodes.length).toBe(4);
    expect(computeRooms(lv).length).toBe(1);
  });

  it('el ejemplo tiene 6 recintos con las áreas esperadas', () => {
    const p = sampleProject();
    const rooms = computeRooms(p.levels[0]);
    expect(rooms.length).toBe(6);
    const by = (n: string) => rooms.find(r => r.meta?.name === n)!;
    expect(by('Living comedor').area).toBeCloseTo(4.85 * 3.85, 4);
    expect(by('Dormitorio principal').area).toBeCloseTo(3.85 * 3.85, 4);
    expect(by('Pasillo').area).toBeCloseTo(5.85 * 1.1, 4);
    expect(rooms.every(r => !!r.meta)).toBe(true);
  });
});

describe('muros y aberturas', () => {
  it('las esquinas en inglete coinciden entre muros vecinos', () => {
    const lv = rect();
    const g = [...wallGeoms(lv).values()];
    // esquina exterior del rectángulo: (-0.1,-0.1)
    const pts = g.flatMap(x => [x.aL, x.aR, x.bL, x.bR]);
    expect(pts.some(p => Math.abs(p.x + 0.1) < 1e-9 && Math.abs(p.y + 0.1) < 1e-9)).toBe(true);
    expect(pts.some(p => Math.abs(p.x - 4.1) < 1e-9 && Math.abs(p.y - 3.1) < 1e-9)).toBe(true);
    expect(g.every(x => !x.capA && !x.capB)).toBe(true);
  });

  it('las aberturas cortan el muro en tramos', () => {
    const p = sampleProject();
    const lv = p.levels[0];
    const geoms = wallGeoms(lv);
    const frames = openingFrames(lv, geoms);
    expect(frames.length).toBe(lv.openings.length);
    const pieces = wallPieces(geoms, frames);
    const fills = pieces.reduce((s, x) => s + x.fills.length, 0);
    expect(fills).toBe(lv.walls.length + lv.openings.length);
  });

  it('integrar no deja muros duplicados ni nodos sueltos', () => {
    const lv = rect();
    addWall(lv, { x: 0, y: 0 }, { x: 4, y: 0 }, 0.2, 2.4); // repetido
    addWall(lv, { x: 1, y: 0 }, { x: 3, y: 0 }, 0.2, 2.4); // encima de otro
    integrateWalls(lv, lv.walls.map(w => w.id));
    const keys = new Set(lv.walls.map(w => [w.a, w.b].sort().join('|')));
    expect(keys.size).toBe(lv.walls.length);
    expect(computeRooms(lv).length).toBe(1);
  });
});

describe('unidades', () => {
  it('formatea y lee longitudes', () => {
    expect(fmtLen(3.5, 'm')).toBe('3,50');
    expect(fmtLen(3.5, 'cm', true)).toBe('350 cm');
    expect(fmtLen(3.5, 'mm')).toBe('3500');
    expect(fmtLen(3.81, 'ft')).toBe(`12' 6"`);
    expect(fmtArea(12.345, 'm')).toBe('12,35 m²');
    expect(parseLen('3,5', 'm')).toBeCloseTo(3.5);
    expect(parseLen('350', 'cm')).toBeCloseTo(3.5);
    expect(parseLen('350cm', 'm')).toBeCloseTo(3.5);
    expect(parseLen(`12' 6"`, 'ft')).toBeCloseTo(3.81);
    expect(parseLen('abc', 'm')).toBeNull();
  });
});

describe('escena', () => {
  it('genera primitivas para todas las capas', () => {
    const p = sampleProject();
    const prims = buildScene(p.levels[0], { theme: THEMES.color, annot: 0.1, units: 'm', layers: p.settings.layers, showRoomDims: true, showAreas: true, showOverallDims: true });
    const layers = new Set(prims.map(x => x.layer));
    for (const l of ['walls', 'doors', 'windows', 'items', 'rooms', 'dims']) expect(layers.has(l)).toBe(true);
    expect(prims.some(x => x.k === 'text' && x.text === 'Living comedor')).toBe(true);
    expect(prims.every(x => x.k !== 'poly' || x.pts.every(Number.isFinite))).toBe(true);
  });
});
