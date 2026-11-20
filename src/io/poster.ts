// Impresión "en mosaico": un plano grande a escala real repartido en varias hojas
// (A4, Carta…) que luego se juntan. Cada hoja repite una franja de la vecina
// (traslape) y lleva un código (A1, A2, B1…) y marcas para alinearlas.

import type { Project } from '../core/model';
import type { Prim } from '../core/scene';
import { THEMES } from '../core/themes';
import { PAPERS, paintPrims, sceneFor, text } from './pdf';

export interface Rect { minX: number; minY: number; maxX: number; maxY: number }

export interface PosterOpts {
  paper: string; landscape: boolean;
  /** denominador de la escala (1:N); puede no ser entero cuando se ajusta a un número de hojas */
  scale: number;
  /** margen no imprimible de cada hoja, en mm */
  margin: number;
  /** franja que se repite entre hojas vecinas, en mm */
  overlap: number;
  /** zona del plano a imprimir, en metros; null = todo el dibujo */
  region: Rect | null;
  /** espacio en blanco antes del dibujo en la primera hoja, en mm (mueve el dibujo respecto de los cortes) */
  offsetX: number; offsetY: number;
  skipEmpty: boolean; marks: boolean; index: boolean;
  theme: 'tech' | 'color' | 'blue';
}

export interface PosterTile { col: number; row: number; label: string; empty: boolean }
export interface PosterLayout {
  /** tamaño de la hoja y de su zona imprimible, en mm */
  pw: number; ph: number; printW: number; printH: number;
  /** avance entre hojas (zona imprimible menos el traslape) */
  stepX: number; stepY: number;
  cols: number; rows: number;
  /** mm de papel por metro */
  k: number;
  /** zona del plano que se imprime, en metros */
  content: Rect;
  tiles: PosterTile[];
  /** hojas que realmente se imprimen */
  count: number;
}

export function paperSize(paper: string, landscape: boolean): [number, number] {
  const [a, b] = PAPERS[paper] || PAPERS.A4;
  return landscape ? [Math.max(a, b), Math.min(a, b)] : [Math.min(a, b), Math.max(a, b)];
}

/** Código de una hoja: la fila es una letra y la columna un número (B3 = segunda fila, tercera columna). */
export function tileLabel(row: number, col: number): string {
  let s = '', n = row;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s + (col + 1);
}

function primBox(p: Prim): Rect | null {
  if (p.k === 'poly') {
    if (p.pts.length < 2) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i + 1 < p.pts.length; i += 2) { const x = p.pts[i], y = p.pts[i + 1]; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    return { minX, minY, maxX, maxY };
  }
  if (p.k === 'arc' || p.k === 'circle') return { minX: p.cx - p.r, minY: p.cy - p.r, maxX: p.cx + p.r, maxY: p.cy + p.r };
  // texto: caja del rectángulo girado (ancho aproximado por número de letras)
  const w = Math.max(p.h, p.text.length * p.h * 0.58), rot = p.rot || 0, c = Math.abs(Math.cos(rot)), s = Math.abs(Math.sin(rot));
  const shift = p.align === 'l' ? w / 2 : p.align === 'r' ? -w / 2 : 0;
  const cx = p.x + Math.cos(rot) * shift, cy = p.y + Math.sin(rot) * shift;
  const ex = (c * w + s * p.h) / 2, ey = (s * w + c * p.h) / 2;
  return { minX: cx - ex, minY: cy - ey, maxX: cx + ex, maxY: cy + ey };
}

export function primsRect(prims: Prim[]): Rect | null {
  let r: Rect | null = null;
  for (const p of prims) {
    const b = primBox(p);
    if (!b || ![b.minX, b.minY, b.maxX, b.maxY].every(Number.isFinite)) continue;
    r = r ? { minX: Math.min(r.minX, b.minX), minY: Math.min(r.minY, b.minY), maxX: Math.max(r.maxX, b.maxX), maxY: Math.max(r.maxY, b.maxY) } : b;
  }
  return r;
}

/** Reparte el dibujo en hojas. No depende del navegador: se usa en la vista previa y al exportar. */
export function posterLayout(prims: Prim[], o: PosterOpts): PosterLayout {
  const [pw, ph] = paperSize(o.paper, o.landscape);
  const margin = Math.max(0, Math.min(o.margin, Math.min(pw, ph) / 2 - 10));
  const printW = pw - margin * 2, printH = ph - margin * 2;
  const overlap = Math.max(0, Math.min(o.overlap, Math.min(printW, printH) / 2));
  const stepX = printW - overlap, stepY = printH - overlap;
  const k = 1000 / Math.max(0.1, o.scale);
  const all = primsRect(prims) || { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  const content = o.region || all;
  const wc = (content.maxX - content.minX) * k, hc = (content.maxY - content.minY) * k;
  const ox = Math.max(0, o.offsetX), oy = Math.max(0, o.offsetY);
  const cols = Math.max(1, Math.ceil((ox + wc - overlap) / stepX - 1e-6)), rows = Math.max(1, Math.ceil((oy + hc - overlap) / stepY - 1e-6));
  const used = new Uint8Array(cols * rows);
  // una hoja está vacía si ninguna primitiva cae en su zona imprimible
  for (const p of prims) {
    const b = primBox(p);
    if (!b) continue;
    const x0 = Math.max(b.minX, content.minX), x1 = Math.min(b.maxX, content.maxX), y0 = Math.max(b.minY, content.minY), y1 = Math.min(b.maxY, content.maxY);
    if (x0 > x1 || y0 > y1) continue;
    const gx0 = (x0 - content.minX) * k + ox, gx1 = (x1 - content.minX) * k + ox, gy0 = (y0 - content.minY) * k + oy, gy1 = (y1 - content.minY) * k + oy;
    const c0 = Math.max(0, Math.floor((gx0 - printW) / stepX) + 1), c1 = Math.min(cols - 1, Math.floor(gx1 / stepX));
    const r0 = Math.max(0, Math.floor((gy0 - printH) / stepY) + 1), r1 = Math.min(rows - 1, Math.floor(gy1 / stepY));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) used[r * cols + c] = 1;
  }
  const tiles: PosterTile[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) tiles.push({ col: c, row: r, label: tileLabel(r, c), empty: !used[r * cols + c] });
  const count = tiles.filter(t => !(o.skipEmpty && t.empty)).length || 1;
  return { pw, ph, printW, printH, stepX, stepY, cols, rows, k, content, tiles, count };
}

/** Escala (1:N) con la que el dibujo entra justo en `cols` × `rows` hojas. */
export function fitPosterScale(content: Rect, o: PosterOpts, cols: number, rows: number): number {
  const [pw, ph] = paperSize(o.paper, o.landscape);
  const printW = pw - o.margin * 2, printH = ph - o.margin * 2;
  const availW = cols * (printW - o.overlap) + o.overlap, availH = rows * (printH - o.overlap) + o.overlap;
  const s = Math.max(((content.maxX - content.minX) * 1000) / Math.max(1, availW), ((content.maxY - content.minY) * 1000) / Math.max(1, availH));
  // se redondea hacia arriba a un decimal para que nunca se salga por redondeo
  return Math.max(1, Math.ceil(s * 10 - 1e-9) / 10);
}

/** Desplazamiento que deja el dibujo centrado en el conjunto de hojas. */
export function centerOffset(prims: Prim[], o: PosterOpts): { offsetX: number; offsetY: number } {
  const l = posterLayout(prims, { ...o, offsetX: 0, offsetY: 0 });
  const wc = (l.content.maxX - l.content.minX) * l.k, hc = (l.content.maxY - l.content.minY) * l.k;
  const overlap = l.printW - l.stepX;
  return { offsetX: Math.max(0, (l.cols * l.stepX + overlap - wc) / 2), offsetY: Math.max(0, (l.rows * l.stepY + overlap - hc) / 2) };
}

export const fmtScale = (s: number) => (Math.abs(s - Math.round(s)) < 0.05 ? String(Math.round(s)) : s.toFixed(1).replace('.', ','));

export async function exportPosterPdf(project: Project, o: PosterOpts): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const level = project.levels[project.activeLevel], theme = THEMES[o.theme];
  const prims = sceneFor(project, level, theme, o.scale);
  const L = posterLayout(prims, o);
  const { pw, ph, printW, printH, stepX, stepY, k, content } = L;
  const margin = (pw - printW) / 2, overlap = printW - stepX;
  const orient = o.landscape ? 'landscape' : 'portrait';
  const doc = new jsPDF({ orientation: orient, unit: 'mm', format: [pw, ph], compress: true });
  const ink = '#111418', muted = '#6b7280';
  const boxes = prims.map(primBox);
  const ox = Math.max(0, o.offsetX), oy = Math.max(0, o.offsetY);
  const pages = L.tiles.filter(t => !(o.skipEmpty && t.empty));
  const list = pages.length ? pages : [L.tiles[0]];
  const title = project.name || 'Plano';
  let first = true;
  const newPage = () => { if (!first) doc.addPage([pw, ph], orient); first = false; };

  // guía de armado: el dibujo completo con la cuadrícula de hojas
  if (o.index && list.length > 1) {
    newPage();
    const gw = L.cols * stepX + overlap, gh = L.rows * stepY + overlap; // tamaño del conjunto, en mm
    const top = 34, availW = pw - 30, availH = ph - top - 28;
    const f = Math.min(availW / gw, availH / gh);
    const x0 = (pw - gw * f) / 2, y0 = top + (availH - gh * f) / 2;
    text(doc, 'Guía de armado', 15, 16, 6, 0, 'l', ink, true);
    text(doc, `${title} · escala 1:${fmtScale(o.scale)} · ${list.length} hojas ${o.paper} · ${L.rows} fila${L.rows === 1 ? '' : 's'} × ${L.cols} columna${L.cols === 1 ? '' : 's'}`, 15, 23, 3, 0, 'l', muted, false);
    doc.saveGraphicsState();
    doc.rect(x0, y0, gw * f, gh * f, null as any); (doc as any).clip(); (doc as any).discardPath();
    const X = (x: number) => x0 + ((x - content.minX) * k + ox) * f, Y = (y: number) => y0 + ((y - content.minY) * k + oy) * f;
    paintPrims(doc, prims.filter(p => p.k !== 'text' || p.h * k * f >= 1.2), X, Y, k * f);
    doc.restoreGraphicsState();
    for (const t of L.tiles) {
      const skipped = o.skipEmpty && t.empty;
      const tx = x0 + t.col * stepX * f, ty = y0 + t.row * stepY * f;
      doc.setDrawColor(skipped ? '#c4c9d1' : '#1f6feb'); doc.setLineWidth(skipped ? 0.2 : 0.4); doc.setLineDashPattern(skipped ? [1.5, 1.2] : [], 0);
      doc.rect(tx, ty, printW * f, printH * f, 'S');
      text(doc, skipped ? `${t.label} (vacía)` : t.label, tx + 2.5, ty + 5, skipped ? 2.6 : 4, 0, 'l', skipped ? '#9aa1ac' : '#1f6feb', !skipped);
    }
    doc.setLineDashPattern([], 0);
    const notes = [
      'Imprime a tamaño real (100 %): desactiva "ajustar a la página" en el diálogo de impresión, o la escala cambiará.',
      `Cada hoja repite ${Math.round(overlap)} mm de la vecina. Recorta o dobla por las marcas y pega haciendo coincidir el dibujo.`,
      'El código de cada hoja va en su margen inferior; en los bordes se indica la hoja que va a cada lado.',
    ];
    notes.forEach((n, i) => text(doc, n, 15, ph - 20 + i * 5, 2.7, 0, 'l', muted, false));
  }

  list.forEach((t, idx) => {
    newPage();
    const gx0 = t.col * stepX, gy0 = t.row * stepY; // esquina de la zona imprimible, en mm del conjunto
    const X = (x: number) => margin + (x - content.minX) * k + ox - gx0, Y = (y: number) => margin + (y - content.minY) * k + oy - gy0;
    // zona del plano que cae en esta hoja, en metros
    const wx0 = content.minX + (gx0 - ox) / k, wy0 = content.minY + (gy0 - oy) / k, wx1 = wx0 + printW / k, wy1 = wy0 + printH / k;
    // el recorte es la zona imprimible, y además la sección elegida si la hay
    const cx0 = Math.max(margin, X(content.minX)), cy0 = Math.max(margin, Y(content.minY));
    const cx1 = Math.min(margin + printW, X(content.maxX)), cy1 = Math.min(margin + printH, Y(content.maxY));
    if (theme.bg.toLowerCase() !== '#ffffff') { doc.setFillColor(theme.bg); doc.rect(margin, margin, printW, printH, 'F'); }
    if (cx1 > cx0 && cy1 > cy0) {
      doc.saveGraphicsState();
      doc.rect(o.region ? cx0 : margin, o.region ? cy0 : margin, o.region ? cx1 - cx0 : printW, o.region ? cy1 - cy0 : printH, null as any); (doc as any).clip(); (doc as any).discardPath();
      const here = prims.filter((_, i) => { const b = boxes[i]; return !!b && b.maxX >= wx0 && b.minX <= wx1 && b.maxY >= wy0 && b.minY <= wy1; });
      paintPrims(doc, here, X, Y, k);
      doc.restoreGraphicsState();
    }
    if (!o.marks) return;
    doc.setDrawColor(muted); doc.setLineWidth(0.15); doc.setLineDashPattern([], 0);
    const m = Math.min(5, margin - 1);
    if (m > 1) {
      // marcas de corte en las cuatro esquinas de la zona imprimible
      for (const [x, y, sx, sy] of [[margin, margin, -1, -1], [margin + printW, margin, 1, -1], [margin, margin + printH, -1, 1], [margin + printW, margin + printH, 1, 1]]) {
        doc.line(x + sx * 1, y, x + sx * m, y); doc.line(x, y + sy * 1, x, y + sy * m);
      }
      // dónde empieza el dibujo de la hoja siguiente (fin de la parte propia de esta hoja)
      doc.setDrawColor('#1f6feb');
      if (t.col < L.cols - 1) for (const y of [margin, margin + printH]) doc.line(margin + stepX, y - (y === margin ? m : -1), margin + stepX, y - (y === margin ? 1 : -m));
      if (t.row < L.rows - 1) for (const x of [margin, margin + printW]) doc.line(x - (x === margin ? m : -1), margin + stepY, x - (x === margin ? 1 : -m), margin + stepY);
    }
    if (margin >= 6) {
      const info = `${title} · hoja ${t.label} (${idx + 1} de ${list.length}) · fila ${t.row + 1} de ${L.rows}, columna ${t.col + 1} de ${L.cols} · escala 1:${fmtScale(o.scale)} · imprimir al 100 %`;
      text(doc, info, margin + 6, ph - margin / 2, 2.2, 0, 'l', muted, false);
      const at = (c: number, r: number) => L.tiles.find(q => q.col === c && q.row === r && !(o.skipEmpty && q.empty));
      const up = at(t.col, t.row - 1), down = at(t.col, t.row + 1), left = at(t.col - 1, t.row), right = at(t.col + 1, t.row);
      if (up) text(doc, `^ ${up.label}`, pw / 2, margin / 2, 2.4, 0, 'c', '#1f6feb', true);
      if (down) text(doc, `v ${down.label}`, pw - margin - 6, ph - margin / 2, 2.4, 0, 'r', '#1f6feb', true);
      if (left) text(doc, `< ${left.label}`, margin / 2, ph / 2, 2.4, -Math.PI / 2, 'c', '#1f6feb', true);
      if (right) text(doc, `${right.label} >`, pw - margin / 2, ph / 2, 2.4, -Math.PI / 2, 'c', '#1f6feb', true);
    }
  });
  return doc.output('blob');
}
