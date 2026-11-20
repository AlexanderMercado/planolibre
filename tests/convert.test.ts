import { describe, expect, it } from 'vitest';
import { newLevel } from '../src/core/model';
import { sampleProject } from '../src/core/sample';
import { buildScene } from '../src/core/scene';
import { THEMES } from '../src/core/themes';
import { computeRooms } from '../src/core/topology';
import { convertShapes, previewWalls } from '../src/core/convert';
import { detectWalls, type DSeg } from '../src/core/detect';
import { parseDxf, writeDxf } from '../src/io/dxf';
import { cadToShapes, flatten } from '../src/io/cad';
import pruebaDxf from './fixtures/prueba.dxf?raw';
import { SOLID, vectorizeMask } from '../src/io/vectorize';

const rect = (x0: number, y0: number, x1: number, y1: number, layer = 'A'): DSeg[] => [
  { x1: x0, y1: y0, x2: x1, y2: y0, layer }, { x1: x1, y1: y0, x2: x1, y2: y1, layer },
  { x1: x1, y1: y1, x2: x0, y2: y1, layer }, { x1: x0, y1: y1, x2: x0, y2: y0, layer },
];

describe('detección de muros en líneas', () => {
  it('convierte el DXF de una habitación (doble línea) en 4 muros con su eje y grosor', () => {
    const doc = parseDxf(pruebaDxf);
    const shapes = cadToShapes(flatten(doc), 1, { x: 0, y: 0 });
    const lv = newLevel();
    const r = convertShapes(lv, shapes, { height: 2.4, keepRest: true });
    expect(r.walls).toBe(4);
    expect(lv.nodes.length).toBe(4);
    for (const w of lv.walls) expect(w.thickness).toBeCloseTo(0.15, 6);
    const rooms = computeRooms(lv);
    expect(rooms.length).toBe(1);
    // el archivo trae escrito "22,31 m²" y cotas interiores 4,60 × 4,85
    expect(rooms[0].area).toBeCloseTo(22.31, 2);
    // las cotas y el área del archivo se regeneran solas: no quedan duplicadas como calco
    expect(r.rest.length).toBe(0);
  });

  it('cierra esquinas, encuentros en T y muros de distinto grosor', () => {
    // casa de 6 × 4 (exterior, muros de 20 cm) con un tabique de 10 cm en x = 3
    const segs: DSeg[] = [
      ...rect(0, 0, 6, 4),                       // cara exterior
      ...rect(0.2, 0.2, 2.95, 3.8),              // cara interior, recinto izquierdo
      ...rect(3.05, 0.2, 5.8, 3.8),              // cara interior, recinto derecho
    ];
    const d = detectWalls(segs);
    const thick = d.walls.filter(w => Math.abs(w.t - 0.2) < 1e-6), thin = d.walls.filter(w => Math.abs(w.t - 0.1) < 1e-6);
    expect(thin.length).toBe(1);
    expect(thick.length + thin.length).toBe(d.walls.length);
    const lv = newLevel();
    const shapes = segs.map((s, i) => ({ id: 's' + i, kind: 'poly' as const, pts: [s.x1, s.y1, s.x2, s.y2], layer: 'A' }));
    convertShapes(lv, shapes, { height: 2.4, keepRest: false });
    const rooms = computeRooms(lv);
    expect(rooms.length).toBe(2);
    expect(rooms[0].area + rooms[1].area).toBeCloseTo(2 * 2.75 * 3.6, 2);
    // el tabique llega hasta el eje de los muros exteriores
    const xs = lv.nodes.filter(n => Math.abs(n.x - 3) < 1e-6).map(n => n.y).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(0.1, 4);
    expect(xs[1]).toBeCloseTo(3.9, 4);
  });

  it('reconoce una puerta por su arco y hacia qué lado abre', () => {
    // muro horizontal de 15 cm entre x = 0 y 4, con un vano de 0,80 entre 1,5 y 2,3
    const segs: DSeg[] = [...rect(0, 0, 1.5, 0.15), ...rect(2.3, 0, 4, 0.15), { x1: 1.5, y1: 0.15, x2: 1.5, y2: 0.95 }];
    const d = detectWalls(segs, [{ x: 1.5, y: 0.15, r: 0.8, a0: 0, a1: Math.PI / 2 }]);
    expect(d.walls.length).toBe(1);
    const ends = [d.walls[0].a.x, d.walls[0].b.x].sort((p, q) => p - q);
    expect(ends[0]).toBeCloseTo(0, 3); expect(ends[1]).toBeCloseTo(4, 3);
    expect(d.openings.length).toBe(1);
    const o = d.openings[0];
    expect(o.kind).toBe('door'); expect(o.width).toBeCloseTo(0.8, 3);
    expect(o.hinge!.x).toBeCloseTo(1.5, 3);
    expect(o.swing!.y).toBeGreaterThan(0.15);
    expect(d.usedArcs.size).toBe(1);
  });

  it('no confunde con muros las líneas de otras capas cuando se eligen las capas de muro', () => {
    const segs: DSeg[] = [...rect(0, 0, 4, 3, 'MUROS'), ...rect(0.15, 0.15, 3.85, 2.85, 'MUROS'), ...rect(1, 1, 3, 1.3, 'MUEBLES')];
    expect(detectWalls(segs).walls.length).toBe(5);
    expect(detectWalls(segs, [], { wallLayers: l => l === 'MUROS' }).walls.length).toBe(4);
  });

  it('reconstruye el plano de ejemplo completo desde su propio DXF', () => {
    const p = sampleProject(), src = p.levels[0];
    const prims = buildScene(src, { theme: THEMES.tech, annot: 0.1, units: 'm', layers: p.settings.layers, showRoomDims: true, showAreas: true, showOverallDims: true });
    const shapes = cadToShapes(flatten(parseDxf(writeDxf(prims, 1))), 1, { x: 0, y: 0 });
    expect(previewWalls(shapes).walls.length).toBeGreaterThan(5);
    const lv = newLevel();
    const r = convertShapes(lv, shapes, { height: 2.4, keepRest: true });
    const a = computeRooms(src), b = computeRooms(lv);
    expect(b.length).toBe(a.length);
    const total = (rs: typeof a) => rs.reduce((s, x) => s + x.area, 0);
    expect(total(b)).toBeCloseTo(total(a), 1);
    const count = (k: string) => src.openings.filter(o => o.kind === k).length;
    expect(r.doors).toBe(count('door'));
    expect(r.windows).toBe(count('window'));
    expect(r.gaps).toBe(count('gap'));
    expect(r.named).toBe(a.filter(x => x.meta).length);
    // de las capas de muros, puertas, ventanas, cotas y recintos no debe sobrar nada
    expect(r.rest.filter(s => ['MUROS', 'COTAS', 'RECINTOS', 'PUERTAS', 'VENTANAS'].includes(s.layer)).length).toBe(0);
  });

  it('reconoce muros en una imagen: muros rellenos con una ventana y una puerta', () => {
    // imagen de 600 × 400 px a 50 px por metro: casa de 10 × 6 m con muros de 20 cm (10 px)
    const W = 600, H = 400, ppm = 50, dark = new Uint8Array(W * H);
    const box = (x0: number, y0: number, x1: number, y1: number, v = 1) => { for (let y = y0; y < y1; y++) dark.fill(v, y * W + x0, y * W + x1); };
    box(50, 50, 550, 60); box(50, 340, 550, 350); box(50, 50, 60, 350); box(540, 50, 550, 350); // perímetro
    box(295, 50, 305, 350);                                                                     // tabique central
    box(150, 50, 220, 60, 0);                                                                   // ventana: hueco en el muro superior…
    box(150, 52, 220, 53); box(150, 57, 220, 58);                                               // …con dos líneas de vidrio
    box(295, 200, 305, 245, 0);                                                                 // puerta en el tabique…
    box(305, 200, 350, 202);                                                                    // …con su hoja abierta
    const px = vectorizeMask(dark, W, H, { minLen: 18, minThick: 4, maxThick: 25 });
    const segs: DSeg[] = px.map(s => ({ x1: s.x1 / ppm, y1: s.y1 / ppm, x2: s.x2 / ppm, y2: s.y2 / ppm, layer: s.layer }));
    const d = detectWalls(segs, [], { wallLayers: l => l === SOLID, dropFree: true });
    expect(d.walls.length).toBe(5);
    for (const w of d.walls) expect(w.t).toBeCloseTo(0.2, 6);
    expect(d.openings.map(o => o.kind).sort()).toEqual(['door', 'window']);
    expect(d.openings.find(o => o.kind === 'window')!.width).toBeCloseTo(1.4, 1);
    expect(d.openings.find(o => o.kind === 'door')!.width).toBeCloseTo(0.9, 1);
    const lv = newLevel();
    const shapes = segs.map((s, i) => ({ id: 's' + i, kind: 'poly' as const, pts: [s.x1, s.y1, s.x2, s.y2], layer: s.layer || '0' }));
    const r = convertShapes(lv, shapes, { height: 2.4, keepRest: false, layers: new Set([SOLID]), dropFree: true });
    expect(r.doors).toBe(1); expect(r.windows).toBe(1);
    const rooms = computeRooms(lv);
    expect(rooms.length).toBe(2);
    // interior: 2 recintos de 4,7 × 5,6 m
    expect(rooms[0].area + rooms[1].area).toBeCloseTo(2 * 4.7 * 5.6, 0);
  });
});
