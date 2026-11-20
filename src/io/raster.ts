// Imágenes: importar una foto/escaneo o un PDF como fondo para calcar,
// y exportar el plano como PNG o SVG.

import type { Level, Project } from '../core/model';
import { buildScene, primsBounds, type Prim } from '../core/scene';
import { THEMES, type Theme } from '../core/themes';
import { drawPrims, FONT } from '../editor/view';

export function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(new Error('No se pudo leer el archivo.'));
    r.readAsDataURL(file);
  });
}

export function imageSize(dataUrl: string): Promise<{ w: number; h: number }> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => rej(new Error('El archivo no es una imagen válida.'));
    img.src = dataUrl;
  });
}

/** Reduce imágenes muy grandes para que el proyecto no pese de más. */
export async function shrinkImage(dataUrl: string, maxSide = 3200): Promise<{ dataUrl: string; w: number; h: number }> {
  const { w, h } = await imageSize(dataUrl);
  if (Math.max(w, h) <= maxSide) return { dataUrl, w, h };
  const k = maxSide / Math.max(w, h);
  const img = new Image();
  await new Promise<void>(r => { img.onload = () => r(); img.src = dataUrl; });
  const c = document.createElement('canvas');
  c.width = Math.round(w * k); c.height = Math.round(h * k);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return { dataUrl: c.toDataURL('image/jpeg', 0.88), w: c.width, h: c.height };
}

export interface PdfPage { dataUrl: string; w: number; h: number; widthMm: number; heightMm: number; pages: number }

/** Convierte una página de un PDF en imagen (pdf.js, todo local). */
export async function openPdfPage(data: ArrayBuffer, pageNum = 1): Promise<{ pdfjs: any; pdf: any; page: any }> {
  const pdfjs: any = await import('pdfjs-dist');
  const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  const pdf = await pdfjs.getDocument({ data }).promise;
  const page = await pdf.getPage(Math.min(Math.max(1, pageNum), pdf.numPages));
  return { pdfjs, pdf, page };
}

export async function pdfPageToImage(data: ArrayBuffer, pageNum = 1): Promise<PdfPage> {
  const { pdf, page } = await openPdfPage(data, pageNum);
  const base = page.getViewport({ scale: 1 });
  const k = Math.min(4, 3200 / Math.max(base.width, base.height));
  const vp = page.getViewport({ scale: k });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return { dataUrl: canvas.toDataURL('image/png'), w: canvas.width, h: canvas.height, widthMm: (base.width * 25.4) / 72, heightMm: (base.height * 25.4) / 72, pages: pdf.numPages };
}

function scene(project: Project, level: Level, theme: Theme, annot: number): Prim[] {
  const st = project.settings;
  return buildScene(level, { theme, annot, units: project.units, layers: st.layers, showRoomDims: st.showRoomDims, showAreas: st.showAreas, showOverallDims: st.showOverallDims });
}

export async function exportPng(project: Project, themeId: 'tech' | 'color' | 'blue', maxSide = 3600): Promise<Blob> {
  const level = project.levels[project.activeLevel], theme = THEMES[themeId];
  const prims = scene(project, level, theme, project.scale / 1000);
  const b = primsBounds(prims) || { minX: 0, minY: 0, maxX: 4, maxY: 3 };
  const pad = 0.6, w = b.maxX - b.minX + pad * 2, h = b.maxY - b.minY + pad * 2;
  const zoom = Math.min(400, maxSide / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.ceil(w * zoom); c.height = Math.ceil(h * zoom);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = theme.bg; ctx.fillRect(0, 0, c.width, c.height);
  // grosor de línea proporcional a la escala del plano (px por mm de papel)
  drawPrims(ctx, prims, zoom, (-b.minX + pad) * zoom, (-b.minY + pad) * zoom, Math.max(1.5, (zoom * project.scale) / 1000));
  return new Promise((res, rej) => c.toBlob(bl => (bl ? res(bl) : rej(new Error('No se pudo generar la imagen.'))), 'image/png'));
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** SVG en milímetros a la escala del plano: se puede imprimir o abrir en Inkscape/Illustrator. */
export function exportSvg(project: Project, themeId: 'tech' | 'color' | 'blue'): string {
  const level = project.levels[project.activeLevel], theme = THEMES[themeId];
  const prims = scene(project, level, theme, project.scale / 1000);
  const b = primsBounds(prims) || { minX: 0, minY: 0, maxX: 4, maxY: 3 };
  const k = 1000 / project.scale, pad = 8;
  const X = (x: number) => +((x - b.minX) * k + pad).toFixed(3), Y = (y: number) => +((y - b.minY) * k + pad).toFixed(3);
  const W = +((b.maxX - b.minX) * k + pad * 2).toFixed(2), H = +((b.maxY - b.minY) * k + pad * 2).toFixed(2);
  const out: string[] = [`<?xml version="1.0" encoding="UTF-8"?>`, `<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}" font-family="${xml(FONT)}">`, `<title>${xml(project.name)} — ${xml(level.name)} — escala 1:${project.scale}</title>`, `<rect width="100%" height="100%" fill="${theme.bg}"/>`];
  let layer = '';
  for (const p of prims) {
    if (p.layer !== layer) { if (layer) out.push('</g>'); layer = p.layer; out.push(`<g id="${xml(layer)}">`); }
    const st = (stroke?: string | null, lw?: number, dash?: boolean, fill?: string | null) =>
      `fill="${fill || 'none'}"${stroke ? ` stroke="${stroke}" stroke-width="${Math.max(0.05, lw || 0.25)}" stroke-linejoin="round"${dash ? ' stroke-dasharray="1.6 1"' : ''}` : ''}`;
    if (p.k === 'poly') {
      const pts: string[] = [];
      for (let i = 0; i + 1 < p.pts.length; i += 2) pts.push(`${X(p.pts[i])},${Y(p.pts[i + 1])}`);
      out.push(`<${p.closed ? 'polygon' : 'polyline'} points="${pts.join(' ')}" ${st(p.stroke, p.lw, p.dash, p.fill)}/>`);
    } else if (p.k === 'arc') {
      let sweep = p.a1 - p.a0; while (sweep <= 0) sweep += Math.PI * 2;
      const x0 = X(p.cx + Math.cos(p.a0) * p.r), y0 = Y(p.cy + Math.sin(p.a0) * p.r), x1 = X(p.cx + Math.cos(p.a1) * p.r), y1 = Y(p.cy + Math.sin(p.a1) * p.r), r = +(p.r * k).toFixed(3);
      out.push(`<path d="M${x0} ${y0} A${r} ${r} 0 ${sweep > Math.PI ? 1 : 0} 1 ${x1} ${y1}" ${st(p.stroke, p.lw, p.dash)}/>`);
    } else if (p.k === 'circle') out.push(`<circle cx="${X(p.cx)}" cy="${Y(p.cy)}" r="${+(p.r * k).toFixed(3)}" ${st(p.stroke, p.lw, false, p.fill)}/>`);
    else {
      const rot = p.rot ? ` transform="rotate(${+((p.rot * 180) / Math.PI).toFixed(2)} ${X(p.x)} ${Y(p.y)})"` : '';
      out.push(`<text x="${X(p.x)}" y="${Y(p.y)}" font-size="${+(p.h * k).toFixed(3)}" text-anchor="${p.align === 'l' ? 'start' : p.align === 'r' ? 'end' : 'middle'}" dominant-baseline="central" fill="${p.color}"${p.bold ? ' font-weight="600"' : ''}${rot}>${xml(p.text)}</text>`);
    }
  }
  if (layer) out.push('</g>');
  out.push('</svg>');
  return out.join('\n');
}
