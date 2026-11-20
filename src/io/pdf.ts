// Exportación a PDF vectorial, a escala real, con margen, cajetín y barra de escala.

import type { Level, Project } from '../core/model';
import { buildScene, primsBounds, type Prim } from '../core/scene';
import { THEMES, type Theme } from '../core/themes';
import { computeRooms } from '../core/topology';
import { fmtArea, fmtLen, UNIT_NAMES } from '../core/units';

export const PAPERS: Record<string, [number, number]> = {
  A4: [210, 297], A3: [297, 420], A2: [420, 594], A1: [594, 841], A0: [841, 1189], Carta: [215.9, 279.4], Oficio: [215.9, 330.2],
};
export const SCALES = [10, 20, 25, 50, 75, 100, 125, 150, 200, 250, 300, 400, 500, 750, 1000, 2000, 5000];

export interface PdfOpts {
  paper: string; landscape: boolean;
  /** denominador de la escala, o 'fit' para elegir la mayor escala estándar que quepa */
  scale: number | 'fit';
  titleBlock: boolean; allLevels: boolean; includeBackground: boolean; schedule: boolean;
  theme: 'tech' | 'color' | 'blue';
}

const MARGIN = 10, TITLE_H = 20;

export function sceneFor(project: Project, level: Level, theme: Theme, scale: number): Prim[] {
  const st = project.settings;
  return buildScene(level, {
    theme, annot: scale / 1000, units: project.units, layers: st.layers,
    showRoomDims: st.showRoomDims, showAreas: st.showAreas, showOverallDims: st.showOverallDims,
  });
}

/** Devuelve la escala que se usará realmente para un nivel (resuelve 'fit'). */
export function resolveScale(project: Project, level: Level, o: PdfOpts): number {
  if (o.scale !== 'fit') return o.scale;
  const [pw, ph] = pageSize(o);
  const aw = pw - MARGIN * 2 - 6, ah = ph - MARGIN * 2 - (o.titleBlock ? TITLE_H : 0) - 6;
  for (const s of SCALES) {
    const b = primsBounds(sceneFor(project, level, THEMES[o.theme], s));
    if (!b) return 100;
    if (((b.maxX - b.minX) * 1000) / s <= aw && ((b.maxY - b.minY) * 1000) / s <= ah) return s;
  }
  return SCALES[SCALES.length - 1];
}

function pageSize(o: PdfOpts): [number, number] {
  const [a, b] = PAPERS[o.paper] || PAPERS.A4;
  return o.landscape ? [Math.max(a, b), Math.min(a, b)] : [Math.min(a, b), Math.max(a, b)];
}

export async function exportPdf(project: Project, o: PdfOpts): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const [pw, ph] = pageSize(o);
  const doc = new jsPDF({ orientation: o.landscape ? 'landscape' : 'portrait', unit: 'mm', format: [pw, ph], compress: true });
  const theme = THEMES[o.theme];
  const levels = o.allLevels ? project.levels : [project.levels[project.activeLevel]];
  const ink = o.theme === 'blue' ? '#ffffff' : '#111418';

  levels.forEach((level, pageIdx) => {
    if (pageIdx > 0) doc.addPage([pw, ph], o.landscape ? 'landscape' : 'portrait');
    const scale = resolveScale(project, level, o);
    const prims = sceneFor(project, level, theme, scale);
    const k = 1000 / scale; // mm de papel por metro
    const areaX = MARGIN, areaY = MARGIN, areaW = pw - MARGIN * 2, areaH = ph - MARGIN * 2 - (o.titleBlock ? TITLE_H : 0);
    const b = primsBounds(prims) || { minX: 0, minY: 0, maxX: 1, maxY: 1 };
    const ox = areaX + areaW / 2 - ((b.minX + b.maxX) / 2) * k, oy = areaY + areaH / 2 - ((b.minY + b.maxY) / 2) * k;
    const X = (x: number) => x * k + ox, Y = (y: number) => y * k + oy;

    if (theme.bg.toLowerCase() !== '#ffffff') { doc.setFillColor(theme.bg); doc.rect(0, 0, pw, ph, 'F'); }

    const bg = level.background;
    if (o.includeBackground && bg && project.assets[bg.asset]) {
      try {
        const src = project.assets[bg.asset];
        const GState = (doc as any).GState;
        if (GState) doc.setGState(new GState({ opacity: bg.opacity }));
        doc.addImage(src, /^data:image\/jpe?g/i.test(src) ? 'JPEG' : 'PNG', X(bg.x), Y(bg.y), bg.w * k, bg.h * k);
        if (GState) doc.setGState(new GState({ opacity: 1 }));
      } catch { /* imagen no compatible: se omite */ }
    }

    // recorte al área de dibujo para que nada invada el cajetín
    doc.saveGraphicsState();
    doc.rect(areaX, areaY, areaW, areaH, null as any); (doc as any).clip(); (doc as any).discardPath();
    paintPrims(doc, prims, X, Y, k);
    doc.restoreGraphicsState();

    // marco
    doc.setDrawColor(ink); doc.setLineWidth(0.5); doc.setLineDashPattern([], 0);
    doc.rect(MARGIN, MARGIN, pw - MARGIN * 2, ph - MARGIN * 2, 'S');
    if (o.titleBlock) titleBlock(doc, project, level, scale, pw, ph, ink, o.theme === 'blue' ? '#cfe1f5' : '#5b6472');
  });

  if (o.schedule) schedulePage(doc, project, levels, pw, ph, o);
  return doc.output('blob');
}

/** Dibuja primitivas en la página actual. X e Y convierten metros a milímetros de papel. */
export function paintPrims(doc: any, prims: Prim[], X: (x: number) => number, Y: (y: number) => number, k: number) {
  for (const p of prims) {
    if (p.k === 'poly') {
      if (p.pts.length < 4) continue;
      doc.moveTo(X(p.pts[0]), Y(p.pts[1]));
      for (let i = 2; i < p.pts.length; i += 2) doc.lineTo(X(p.pts[i]), Y(p.pts[i + 1]));
      if (p.closed) doc.close();
      paint(doc, p.fill, p.stroke, p.lw, p.dash);
    } else if (p.k === 'arc') {
      let sweep = p.a1 - p.a0;
      while (sweep <= 0) sweep += Math.PI * 2;
      const n = Math.max(6, Math.ceil(sweep / (Math.PI / 24)));
      for (let i = 0; i <= n; i++) {
        const a = p.a0 + (sweep * i) / n, x = X(p.cx + Math.cos(a) * p.r), y = Y(p.cy + Math.sin(a) * p.r);
        i ? doc.lineTo(x, y) : doc.moveTo(x, y);
      }
      paint(doc, null, p.stroke, p.lw, p.dash);
    } else if (p.k === 'circle') {
      setStroke(doc, p.stroke, p.lw);
      if (p.fill) doc.setFillColor(p.fill);
      doc.circle(X(p.cx), Y(p.cy), p.r * k, p.fill && p.stroke ? 'FD' : p.fill ? 'F' : 'S');
    } else {
      text(doc, p.text, X(p.x), Y(p.y), p.h * k, p.rot || 0, p.align || 'c', p.color, !!p.bold);
    }
  }
}

function setStroke(doc: any, stroke?: string | null, lw?: number, dash?: boolean) {
  if (!stroke) return;
  doc.setDrawColor(stroke);
  doc.setLineWidth(Math.max(0.05, lw || 0.25));
  doc.setLineDashPattern(dash ? [1.6, 1] : [], 0);
}

function paint(doc: any, fill?: string | null, stroke?: string | null, lw?: number, dash?: boolean) {
  if (fill) doc.setFillColor(fill);
  setStroke(doc, stroke, lw, dash);
  if (fill && stroke) doc.fillStroke(); else if (fill) doc.fill(); else if (stroke) doc.stroke(); else doc.discardPath();
}

/** Texto centrado verticalmente y rotado alrededor de su punto de anclaje. */
export function text(doc: any, str: string, x: number, y: number, hmm: number, rot: number, align: 'c' | 'l' | 'r', color: string, bold: boolean) {
  if (hmm < 0.4) return;
  doc.setFont('helvetica', bold ? 'bold' : 'normal');
  doc.setFontSize((hmm * 72) / 25.4);
  doc.setTextColor(color);
  const w = doc.getTextWidth(str);
  const lx = align === 'c' ? -w / 2 : align === 'r' ? -w : 0, ly = hmm * 0.35;
  const c = Math.cos(rot), s = Math.sin(rot);
  doc.text(str, x + lx * c - ly * s, y + lx * s + ly * c, { angle: (-rot * 180) / Math.PI });
}

function titleBlock(doc: any, project: Project, level: Level, scale: number, pw: number, ph: number, ink: string, muted: string) {
  const y0 = ph - MARGIN - TITLE_H, x0 = MARGIN, w = pw - MARGIN * 2;
  doc.setDrawColor(ink); doc.setLineWidth(0.35);
  doc.line(x0, y0, x0 + w, y0);
  const cols = [0.36, 0.2, 0.14, 0.14, 0.16];
  const rooms = computeRooms(level);
  const total = rooms.reduce((s, r) => s + r.area, 0);
  const cells: [string, string][] = [
    ['PROYECTO', project.name || 'Sin título'],
    ['PLANO', `Planta · ${level.name}`],
    ['ESCALA', `1:${scale}`],
    ['FECHA', new Date().toLocaleDateString('es-CL')],
    ['SUPERFICIE ÚTIL', rooms.length ? fmtArea(total, project.units) : '—'],
  ];
  let x = x0;
  cells.forEach(([label, value], i) => {
    const cw = w * cols[i];
    if (i > 0) doc.line(x, y0, x, y0 + TITLE_H);
    text(doc, label, x + 3, y0 + 4.2, 2.2, 0, 'l', muted, false);
    const size = i === 0 ? 5 : 4;
    let v = value;
    doc.setFont('helvetica', 'bold'); doc.setFontSize((size * 72) / 25.4);
    while (v.length > 4 && doc.getTextWidth(v) > cw - 6) v = v.slice(0, -2);
    if (v !== value) v += '…';
    text(doc, v, x + 3, y0 + 10, size, 0, 'l', ink, true);
    x += cw;
  });
  // segunda línea: autor, unidades y barra de escala gráfica
  const info = [project.author ? `Dibujó: ${project.author}` : '', `Cotas en ${UNIT_NAMES[project.units].toLowerCase()}`, 'Hecho con PlanoLibre'].filter(Boolean).join('   ·   ');
  text(doc, info, x0 + 3, y0 + 16.2, 2.3, 0, 'l', muted, false);
  // barra de escala: 4 tramos
  const nice = [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100];
  const seg = nice.find(n => (n * 1000) / scale >= 8) || 100;
  const sw = (seg * 1000) / scale, bx = x0 + w - 4 - sw * 4, by = y0 + 15.2;
  for (let i = 0; i < 4; i++) {
    doc.setFillColor(i % 2 ? '#ffffff' : ink); doc.setDrawColor(ink); doc.setLineWidth(0.2);
    doc.rect(bx + i * sw, by, sw, 1.4, 'FD');
  }
  text(doc, '0', bx, by + 3.4, 2, 0, 'c', muted, false);
  text(doc, fmtLen(seg * 4, project.units, true), bx + sw * 4, by + 3.4, 2, 0, 'r', muted, false);
}

function schedulePage(doc: any, project: Project, levels: Level[], pw: number, ph: number, o: PdfOpts) {
  doc.addPage([pw, ph], o.landscape ? 'landscape' : 'portrait');
  const ink = '#111418', muted = '#5b6472';
  let y = MARGIN + 12;
  text(doc, 'Cuadro de superficies', MARGIN + 4, y, 6, 0, 'l', ink, true);
  y += 5;
  text(doc, project.name, MARGIN + 4, y + 2, 3, 0, 'l', muted, false);
  y += 10;
  const x1 = MARGIN + 4, x2 = MARGIN + 100, x3 = MARGIN + 140, right = Math.min(pw - MARGIN - 4, MARGIN + 180);
  let grand = 0;
  for (const level of levels) {
    const rooms = computeRooms(level);
    if (!rooms.length) continue;
    text(doc, level.name.toUpperCase(), x1, y, 3, 0, 'l', ink, true);
    text(doc, 'Superficie útil', x2, y, 2.6, 0, 'l', muted, false);
    text(doc, 'Perímetro', x3, y, 2.6, 0, 'l', muted, false);
    y += 3; doc.setDrawColor(ink); doc.setLineWidth(0.3); doc.line(x1, y, right, y); y += 5;
    let sub = 0, n = 0;
    for (const r of rooms) {
      n++;
      text(doc, r.meta?.name || `Recinto ${n}`, x1, y, 3.2, 0, 'l', ink, false);
      text(doc, fmtArea(r.area, project.units), x2, y, 3.2, 0, 'l', ink, false);
      text(doc, fmtLen(r.perimeter, project.units, true), x3, y, 3.2, 0, 'l', ink, false);
      sub += r.area; y += 6;
      if (y > ph - MARGIN - 20) { doc.addPage([pw, ph], o.landscape ? 'landscape' : 'portrait'); y = MARGIN + 12; }
    }
    doc.setLineWidth(0.15); doc.line(x1, y - 2.5, right, y - 2.5); y += 2;
    text(doc, 'Subtotal', x1, y, 3.2, 0, 'l', ink, true);
    text(doc, fmtArea(sub, project.units), x2, y, 3.2, 0, 'l', ink, true);
    grand += sub; y += 12;
  }
  text(doc, 'TOTAL SUPERFICIE ÚTIL', x1, y, 3.4, 0, 'l', ink, true);
  text(doc, fmtArea(grand, project.units), x2, y, 3.4, 0, 'l', ink, true);
  y += 8;
  text(doc, 'La superficie útil se mide por la cara interior de los muros de cada recinto.', x1, y, 2.4, 0, 'l', muted, false);
}
