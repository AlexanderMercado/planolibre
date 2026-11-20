import { describe, expect, it } from 'vitest';
import { sampleProject } from '../src/core/sample';
import { buildScene } from '../src/core/scene';
import { THEMES } from '../src/core/themes';
import { parseDxf, writeDxf } from '../src/io/dxf';
import { cadBounds, cadToShapes, flatten, guessUnitFactor } from '../src/io/cad';
import { exportPdf, resolveScale } from '../src/io/pdf';
import { normalizeProject } from '../src/core/model';
import { centerOffset, exportPosterPdf, fitPosterScale, posterLayout, tileLabel, type PosterOpts } from '../src/io/poster';
import { sceneFor } from '../src/io/pdf';

const scene = (annot = 0.1) => {
  const p = sampleProject();
  return buildScene(p.levels[0], { theme: THEMES.tech, annot, units: 'm', layers: p.settings.layers, showRoomDims: true, showAreas: true, showOverallDims: true });
};

describe('DXF', () => {
  it('escribe un DXF R12 que se vuelve a leer con la misma geometría', () => {
    const prims = scene();
    const dxf = writeDxf(prims, 1);
    expect(dxf.startsWith('0\r\nSECTION')).toBe(true);
    expect(dxf.trimEnd().endsWith('EOF')).toBe(true);
    for (const l of ['MUROS', 'PUERTAS', 'VENTANAS', 'MOBILIARIO', 'COTAS', 'RECINTOS']) expect(dxf).toContain(`\r\n2\r\n${l}\r\n`);
    const doc = parseDxf(dxf);
    const ents = flatten(doc);
    const expected = prims.filter(p => (p.k === 'poly' ? p.cad !== false && !!p.stroke && p.pts.length >= 4 : p.k === 'circle' ? !!p.stroke : true)).length;
    expect(ents.length).toBe(expected);
    // el plano mide 9,2 × 7,2 m entre caras exteriores (más las cotas generales)
    const walls = ents.filter(e => e.layer === 'MUROS');
    const b = cadBounds(walls)!;
    expect(b.maxX - b.minX).toBeCloseTo(9.2, 5);
    expect(b.maxY - b.minY).toBeCloseTo(7.2, 5);
    expect(ents.some(e => e.k === 'arc')).toBe(true);
    expect(ents.some(e => e.k === 'text' && e.text === 'Dormitorio principal')).toBe(true);
    expect(ents.some(e => e.k === 'text' && e.text === 'Baño')).toBe(true); // acentos y ñ vía \U+
  });

  it('respeta la unidad elegida al exportar y la estima al importar', () => {
    const doc = parseDxf(writeDxf(scene(), 1000));
    const ents = flatten(doc);
    expect(guessUnitFactor(doc, ents)).toBe(0.001);
    const shapes = cadToShapes(ents.filter(e => e.layer === 'MUROS'), 0.001, { x: 0, y: 0 });
    const xs = shapes.flatMap(s => s.pts.filter((_, i) => i % 2 === 0));
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(9.2, 4);
  });

  it('lee LWPOLYLINE con arcos, bloques (INSERT) y unidades declaradas', () => {
    const dxf = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC',
      '0', 'SECTION', '2', 'BLOCKS', '0', 'BLOCK', '2', 'SILLA', '10', '0', '20', '0',
      '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '500', '21', '0', '0', 'CIRCLE', '8', 'MOB', '10', '250', '20', '250', '40', '100', '0', 'ENDBLK', '0', 'ENDSEC',
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'LWPOLYLINE', '8', 'MUROS', '90', '3', '70', '1', '10', '0', '20', '0', '42', '1', '10', '1000', '20', '0', '10', '1000', '20', '1000',
      '0', 'INSERT', '8', 'MOBILIARIO', '2', 'SILLA', '10', '2000', '20', '0', '41', '2', '42', '2', '50', '90',
      '0', 'TEXT', '8', 'T', '10', '5', '20', '5', '40', '100', '1', 'Ba\\U+00F1o',
      '0', 'ENDSEC', '0', 'EOF'].join('\n');
    const doc = parseDxf(dxf);
    expect(doc.insUnits).toBe(4);
    const ents = flatten(doc);
    expect(ents.length).toBe(4);
    const poly = ents.find(e => e.layer === 'MUROS')!;
    expect(poly.k).toBe('poly');
    // el tramo con bulge=1 es un semicírculo de radio 500 que baja hasta y=-500
    expect(cadBounds([poly])!.minY).toBeCloseTo(-500, 3);
    // la línea del bloque, escalada x2 y girada 90°, va de (2000,0) a (2000,1000) y hereda la capa del INSERT
    const line = ents.find(e => e.k === 'poly' && e.layer === 'MOBILIARIO')! as { pts: number[] };
    expect(line.pts[0]).toBeCloseTo(2000); expect(line.pts[1]).toBeCloseTo(0);
    expect(line.pts[2]).toBeCloseTo(2000); expect(line.pts[3]).toBeCloseTo(1000);
    expect(ents.some(e => e.k === 'text' && e.text === 'Baño')).toBe(true);
    expect(guessUnitFactor(doc, ents)).toBe(0.001);
  });
});

describe('PDF', () => {
  it('genera un PDF válido a escala, con cajetín y cuadro de superficies', async () => {
    const p = sampleProject();
    const opts = { paper: 'A4', landscape: true, scale: 'fit' as const, titleBlock: true, allLevels: false, includeBackground: false, schedule: true, theme: 'tech' as const };
    // 9,2 m a 1:50 = 184 mm: cabe en A4 horizontal; a 1:25 no
    expect(resolveScale(p, p.levels[0], opts)).toBe(50);
    expect(resolveScale(p, p.levels[0], { ...opts, paper: 'A3' })).toBe(50);
    expect(resolveScale(p, p.levels[0], { ...opts, paper: 'A1' })).toBe(20);
    const blob = await exportPdf(p, opts);
    const buf = new Uint8Array(await blob.arrayBuffer());
    expect(new TextDecoder().decode(buf.slice(0, 5))).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(5000);
    const txt = new TextDecoder('latin1').decode(buf);
    expect((txt.match(/\/Type \/Page\b/g) || []).length).toBe(2);
  });
});

describe('proyecto', () => {
  it('se guarda y se vuelve a abrir sin pérdidas', () => {
    const p = sampleProject();
    const back = normalizeProject(JSON.parse(JSON.stringify(p)));
    expect(back.levels[0].walls.length).toBe(p.levels[0].walls.length);
    expect(back.levels[0].openings.length).toBe(12);
    expect(back.settings.layers.walls).toBe(true);
    expect(() => normalizeProject({ foo: 1 })).toThrow();
  });
});

describe('PDF en varias hojas', () => {
  const base: PosterOpts = { paper: 'A4', landscape: true, scale: 25, margin: 10, overlap: 10, region: null, offsetX: 0, offsetY: 0, skipEmpty: false, marks: true, index: true, theme: 'tech' };
  const p = sampleProject();
  const prims = (scale: number) => sceneFor(p, p.levels[0], THEMES.tech, scale);

  it('reparte el plano en hojas que lo cubren entero, con traslape', () => {
    const L = posterLayout(prims(25), base);
    // A4 horizontal con 10 mm de margen: 277 × 190 útiles; cada hoja avanza 267 × 180
    expect(L.printW).toBeCloseTo(277, 6); expect(L.stepX).toBeCloseTo(267, 6); expect(L.stepY).toBeCloseTo(180, 6);
    const wc = (L.content.maxX - L.content.minX) * L.k, hc = (L.content.maxY - L.content.minY) * L.k;
    expect(L.cols * L.stepX + 10).toBeGreaterThanOrEqual(wc);
    expect((L.cols - 1) * L.stepX + 10).toBeLessThan(wc);
    expect(L.rows * L.stepY + 10).toBeGreaterThanOrEqual(hc);
    expect(L.tiles.length).toBe(L.cols * L.rows);
    expect(L.cols).toBeGreaterThan(1);
    expect(tileLabel(0, 0)).toBe('A1'); expect(tileLabel(1, 2)).toBe('B3'); expect(tileLabel(26, 0)).toBe('AA1');
  });

  it('ajusta la escala para que entre en el número de hojas pedido y lo centra', () => {
    let o = { ...base };
    for (let i = 0; i < 4; i++) { const L = posterLayout(prims(o.scale), o); if (i && L.cols <= 3 && L.rows <= 2) break; o = { ...o, scale: fitPosterScale(L.content, o, 3, 2) }; }
    const L = posterLayout(prims(o.scale), o);
    expect(L.cols).toBeLessThanOrEqual(3); expect(L.rows).toBeLessThanOrEqual(2);
    expect(L.cols === 3 || L.rows === 2).toBe(true);
    const c = centerOffset(prims(o.scale), o);
    const wc = (L.content.maxX - L.content.minX) * L.k;
    // centrado: el espacio sobrante queda igual a ambos lados
    expect(c.offsetX * 2 + wc).toBeCloseTo(L.cols * L.stepX + 10, 3);
  });

  it('una sección usa menos hojas, y las hojas vacías se pueden omitir', () => {
    const all = posterLayout(prims(25), base);
    const part = posterLayout(prims(25), { ...base, region: { minX: 0, minY: 0, maxX: 4.2, maxY: 4 } });
    expect(part.cols * part.rows).toBeLessThan(all.cols * all.rows);
    // con mucho espacio en blanco antes del dibujo, la primera hoja queda vacía
    const moved = posterLayout(prims(25), { ...base, offsetX: 400, offsetY: 0, skipEmpty: true });
    expect(moved.tiles[0].empty).toBe(true);
    expect(moved.count).toBeLessThan(moved.tiles.length);
  });

  it('genera un PDF con una página por hoja más la guía de armado', async () => {
    const L = posterLayout(prims(25), base);
    const blob = await exportPosterPdf(p, base);
    const txt = new TextDecoder('latin1').decode(await blob.arrayBuffer());
    expect(txt.startsWith('%PDF')).toBe(true);
    const pages = (txt.match(/\/Type\s*\/Page[^s]/g) || []).length;
    expect(pages).toBe(L.count + 1);
  });
});

