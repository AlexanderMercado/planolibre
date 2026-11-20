// Lectura y escritura de DXF (el formato de intercambio abierto de AutoCAD).
// Se escribe DXF R12 (AC1009): es el más simple y lo abren AutoCAD, BricsCAD,
// LibreCAD, QCAD, DraftSight, Illustrator, etc.

import type { Prim } from '../core/scene';
import { CAD_LAYERS } from '../core/scene';
import { bulgePoints, cleanMText, ellipsePoints, splinePoints, type CadDoc, type CadEnt } from './cad';

// ───────────────────────────── Escritura ─────────────────────────────

const f = (n: number) => (Math.abs(n) < 1e-9 ? '0.0' : (Math.round(n * 1e6) / 1e6).toString());
const esc = (s: string) => s.replace(/[^\x20-\x7e]/g, ch => '\\U+' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'));

/**
 * @param unitFactor unidades de dibujo por metro (1 = metros, 100 = cm, 1000 = mm)
 */
export function writeDxf(prims: Prim[], unitFactor = 1): string {
  const o: (string | number)[] = [];
  const p = (...a: (string | number)[]) => { for (const x of a) o.push(x); };
  const X = (x: number) => f(x * unitFactor), Y = (y: number) => f(-y * unitFactor);
  const used = new Set<string>();
  const layerOf = (l: string) => { const n = (CAD_LAYERS[l]?.name || l || '0').toUpperCase().replace(/[^A-Z0-9_$-]/g, '_').slice(0, 31) || '0'; used.add(n); return n; };

  const ents: (string | number)[] = [];
  const e = (...a: (string | number)[]) => { for (const x of a) ents.push(x); };
  for (const pr of prims) {
    if (pr.k === 'poly') {
      if (pr.cad === false || !pr.stroke || pr.pts.length < 4) continue;
      const ly = layerOf(pr.layer), n = pr.pts.length / 2;
      if (n === 2 && !pr.closed) {
        e(0, 'LINE', 8, ly); if (pr.dash) e(6, 'DASHED');
        e(10, X(pr.pts[0]), 20, Y(pr.pts[1]), 30, '0.0', 11, X(pr.pts[2]), 21, Y(pr.pts[3]), 31, '0.0');
      } else {
        e(0, 'POLYLINE', 8, ly); if (pr.dash) e(6, 'DASHED');
        e(66, 1, 70, pr.closed ? 1 : 0, 10, '0.0', 20, '0.0', 30, '0.0');
        for (let i = 0; i < pr.pts.length; i += 2) e(0, 'VERTEX', 8, ly, 10, X(pr.pts[i]), 20, Y(pr.pts[i + 1]), 30, '0.0');
        e(0, 'SEQEND', 8, ly);
      }
    } else if (pr.k === 'arc') {
      const ly = layerOf(pr.layer);
      const s = ((-pr.a1 * 180) / Math.PI) % 360, en = ((-pr.a0 * 180) / Math.PI) % 360;
      e(0, 'ARC', 8, ly, 10, X(pr.cx), 20, Y(pr.cy), 30, '0.0', 40, f(pr.r * unitFactor), 50, f(s < 0 ? s + 360 : s), 51, f(en < 0 ? en + 360 : en));
    } else if (pr.k === 'circle') {
      if (!pr.stroke) continue;
      e(0, 'CIRCLE', 8, layerOf(pr.layer), 10, X(pr.cx), 20, Y(pr.cy), 30, '0.0', 40, f(pr.r * unitFactor));
    } else if (pr.k === 'text') {
      const ly = layerOf(pr.layer), h = pr.h * 0.72 * unitFactor;
      const rot = (-(pr.rot || 0) * 180) / Math.PI;
      const ha = pr.align === 'l' ? 0 : pr.align === 'r' ? 2 : 1;
      e(0, 'TEXT', 8, ly, 10, X(pr.x), 20, Y(pr.y), 30, '0.0', 40, f(h), 1, esc(pr.text), 50, f(rot), 72, ha, 73, 2, 11, X(pr.x), 21, Y(pr.y), 31, '0.0');
    }
  }

  p(0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1009', 9, '$INSBASE', 10, '0.0', 20, '0.0', 30, '0.0', 0, 'ENDSEC');
  p(0, 'SECTION', 2, 'TABLES');
  p(0, 'TABLE', 2, 'LTYPE', 70, 2);
  p(0, 'LTYPE', 2, 'CONTINUOUS', 70, 0, 3, 'Solid line', 72, 65, 73, 0, 40, '0.0');
  p(0, 'LTYPE', 2, 'DASHED', 70, 0, 3, 'Dashed __ __ __', 72, 65, 73, 2, 40, f(0.3 * unitFactor), 49, f(0.2 * unitFactor), 49, f(-0.1 * unitFactor));
  p(0, 'ENDTAB');
  const layers = [...used].sort();
  const colorOf = (name: string) => Object.values(CAD_LAYERS).find(l => l.name === name)?.color ?? 7;
  p(0, 'TABLE', 2, 'LAYER', 70, layers.length + 1);
  p(0, 'LAYER', 2, '0', 70, 0, 62, 7, 6, 'CONTINUOUS');
  for (const l of layers) if (l !== '0') p(0, 'LAYER', 2, l, 70, 0, 62, colorOf(l), 6, 'CONTINUOUS');
  p(0, 'ENDTAB');
  p(0, 'TABLE', 2, 'STYLE', 70, 1);
  p(0, 'STYLE', 2, 'STANDARD', 70, 0, 40, '0.0', 41, '1.0', 50, '0.0', 71, 0, 42, '0.2', 3, 'txt', 4, '');
  p(0, 'ENDTAB', 0, 'ENDSEC');
  p(0, 'SECTION', 2, 'ENTITIES');
  for (const x of ents) o.push(x);
  p(0, 'ENDSEC', 0, 'EOF');
  return o.join('\r\n') + '\r\n';
}

// ───────────────────────────── Lectura ─────────────────────────────

type Pair = [number, string];

function tokenize(text: string): Pair[] {
  const lines = text.split(/\r\n|\r|\n/);
  const out: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const c = parseInt(lines[i], 10);
    if (Number.isNaN(c)) { i--; continue; }
    out.push([c, lines[i + 1]]);
  }
  return out;
}

const D2R = Math.PI / 180;

/** Convierte un grupo de pares (una entidad) en CadEnt. */
function entity(type: string, g: Pair[], verts: Pair[][]): CadEnt | null {
  const get = (c: number, def = '') => { for (const q of g) if (q[0] === c) return q[1]; return def; };
  const num = (c: number, def = 0) => { const v = parseFloat(get(c, '')); return Number.isFinite(v) ? v : def; };
  if (num(67) === 1) return null; // espacio papel
  const layer = get(8, '0').trim() || '0';
  const lt = get(6, '').toUpperCase();
  const dash = /DASH|HIDDEN|OCULT|TRAZO|CENTER|DOT/.test(lt) || undefined;
  switch (type) {
    case 'LINE': return { k: 'poly', pts: [num(10), num(20), num(11), num(21)], layer, dash };
    case 'CIRCLE': return { k: 'circle', x: num(10), y: num(20), r: num(40), layer };
    case 'ARC': return { k: 'arc', x: num(10), y: num(20), r: num(40), a0: num(50) * D2R, a1: num(51) * D2R, layer };
    case 'LWPOLYLINE': {
      const vs: { x: number; y: number; b: number }[] = [];
      for (const q of g) {
        if (q[0] === 10) vs.push({ x: parseFloat(q[1]), y: 0, b: 0 });
        else if (q[0] === 20 && vs.length) vs[vs.length - 1].y = parseFloat(q[1]);
        else if (q[0] === 42 && vs.length) vs[vs.length - 1].b = parseFloat(q[1]);
      }
      return polyFrom(vs, (num(70) & 1) === 1, layer, dash);
    }
    case 'POLYLINE': {
      if (num(70) & 64) return null; // malla poligonal
      const vs = verts.map(v => {
        const n = (c: number) => { for (const q of v) if (q[0] === c) return parseFloat(q[1]); return 0; };
        return { x: n(10), y: n(20), b: n(42) };
      });
      return polyFrom(vs, (num(70) & 1) === 1, layer, dash);
    }
    case 'ELLIPSE': {
      const r = ellipsePoints(num(10), num(20), num(11), num(21), num(40, 1), num(41, 0), num(42, Math.PI * 2));
      return { k: 'poly', pts: r.pts, closed: r.closed, layer, dash };
    }
    case 'SPLINE': {
      const ctrl: number[] = [], fit: number[] = [], knots: number[] = [];
      for (const q of g) {
        if (q[0] === 10) ctrl.push(parseFloat(q[1]), 0); else if (q[0] === 20 && ctrl.length) ctrl[ctrl.length - 1] = parseFloat(q[1]);
        else if (q[0] === 11) fit.push(parseFloat(q[1]), 0); else if (q[0] === 21 && fit.length) fit[fit.length - 1] = parseFloat(q[1]);
        else if (q[0] === 40) knots.push(parseFloat(q[1]));
      }
      const pts = ctrl.length >= 4 ? splinePoints(ctrl, knots, num(71, 3)) : fit;
      return pts.length >= 4 ? { k: 'poly', pts, closed: (num(70) & 1) === 1, layer, dash } : null;
    }
    case 'TEXT': case 'ATTRIB': {
      // con alineación distinta de izquierda/base, el punto que manda es el segundo (11/21)
      const ha = num(72), va = num(73), aligned = (ha === 1 || ha === 2 || ha === 4 || va > 0) && get(11, '') !== '';
      return {
        k: 'text', x: aligned ? num(11) : num(10), y: aligned ? num(21) : num(20), h: num(40, 1), rot: num(50) * D2R, text: cleanMText(get(1)), layer,
        align: aligned ? (ha === 1 || ha === 4 ? 'c' : ha === 2 ? 'r' : 'l') : 'l', mid: aligned && (va === 2 || ha === 4),
      };
    }
    case 'MTEXT': {
      let txt = '';
      for (const q of g) if (q[0] === 3) txt += q[1];
      txt += get(1);
      const h = num(40, 1);
      let rot = num(50) * D2R;
      if (get(11, '') !== '') rot = Math.atan2(num(21), num(11));
      const att = num(71, 1);
      const col = (att - 1) % 3, row = Math.floor((att - 1) / 3);
      const clean = cleanMText(txt);
      const w = clean.length * h * 0.6;
      // se lleva el punto de anclaje al extremo inferior izquierdo aproximado
      const dx = col === 1 ? -w / 2 : col === 2 ? -w : 0, dy = row === 0 ? -h : row === 1 ? -h / 2 : 0;
      const c = Math.cos(rot), s = Math.sin(rot);
      return { k: 'text', x: num(10) + dx * c - dy * s, y: num(20) + dx * s + dy * c, h, rot, text: clean, layer };
    }
    case 'INSERT': return { k: 'insert', name: get(2), x: num(10), y: num(20), sx: num(41, 1), sy: num(42, 1), rot: num(50) * D2R, layer };
    case 'DIMENSION': { const name = get(2); return name ? { k: 'insert', name, x: 0, y: 0, sx: 1, sy: 1, rot: 0, layer } : null; }
    case 'SOLID': case 'TRACE': case '3DFACE': {
      const pts = [num(10), num(20), num(11), num(21), num(13), num(23), num(12), num(22)];
      return { k: 'poly', pts, closed: true, layer };
    }
    default: return null;
  }
}

function polyFrom(vs: { x: number; y: number; b: number }[], closed: boolean, layer: string, dash?: boolean): CadEnt | null {
  if (vs.length < 2) return null;
  const pts: number[] = [vs[0].x, vs[0].y];
  for (let i = 1; i < vs.length; i++) bulgePoints(vs[i - 1].x, vs[i - 1].y, vs[i].x, vs[i].y, vs[i - 1].b, pts);
  const last = vs[vs.length - 1];
  if (closed && Math.abs(last.b) > 1e-9) { bulgePoints(last.x, last.y, vs[0].x, vs[0].y, last.b, pts); pts.length -= 2; }
  return { k: 'poly', pts, closed, layer, dash };
}

export function parseDxf(text: string): CadDoc {
  const pairs = tokenize(text);
  const doc: CadDoc = { ents: [], blocks: new Map(), insUnits: null };
  if (!pairs.some(p => p[0] === 0 && p[1].trim() === 'SECTION')) throw new Error('El archivo no parece un DXF de texto válido.');
  let section = '';
  let block: { bx: number; by: number; ents: CadEnt[]; name: string } | null = null;
  let i = 0;
  const n = pairs.length;
  while (i < n) {
    const [c, vRaw] = pairs[i];
    const v = vRaw.trim();
    if (c !== 0) {
      if (section === 'HEADER' && c === 9 && v === '$INSUNITS' && i + 1 < n) doc.insUnits = parseInt(pairs[i + 1][1], 10) || null;
      i++; continue;
    }
    if (v === 'SECTION') { section = (pairs[i + 1]?.[1] || '').trim(); i += 2; continue; }
    if (v === 'ENDSEC') { section = ''; i++; continue; }
    if (v === 'EOF') break;
    // reunir los pares de esta entidad
    let j = i + 1;
    while (j < n && pairs[j][0] !== 0) j++;
    const g = pairs.slice(i + 1, j);
    if (section === 'BLOCKS' || section === 'ENTITIES') {
      if (v === 'BLOCK') {
        const get = (cc: number) => { for (const q of g) if (q[0] === cc) return q[1]; return ''; };
        block = { name: get(2).trim(), bx: parseFloat(get(10)) || 0, by: parseFloat(get(20)) || 0, ents: [] };
      } else if (v === 'ENDBLK') {
        if (block) doc.blocks.set(block.name, block);
        block = null;
      } else {
        const verts: Pair[][] = [];
        if (v === 'POLYLINE') {
          while (j < n && pairs[j][1].trim() === 'VERTEX') {
            let k = j + 1;
            while (k < n && pairs[k][0] !== 0) k++;
            verts.push(pairs.slice(j + 1, k));
            j = k;
          }
          if (j < n && pairs[j][1].trim() === 'SEQEND') { j++; while (j < n && pairs[j][0] !== 0) j++; }
        }
        const e = entity(v, g, verts);
        if (e) (block ? block.ents : doc.ents).push(e);
      }
    }
    i = j;
  }
  return doc;
}
