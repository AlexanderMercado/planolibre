// Extrae los trazos vectoriales de una página PDF (líneas y arcos), para poder
// reconocer muros en un PDF que fue exportado desde un programa de dibujo.
// Un PDF escaneado no tiene trazos: en ese caso se usa la imagen (vectorize.ts).

import type { DArc, DSeg } from '../core/detect';
import { openPdfPage } from './raster';

/** Coordenadas en puntos PDF (1/72 de pulgada), con el origen arriba a la izquierda. */
export interface PdfVectors { segs: DSeg[]; arcs: DArc[]; texts: { x: number; y: number; text: string }[]; w: number; h: number }

type M = number[];
const mul = (a: M, b: M): M => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];

/** Círculo que pasa por tres puntos. */
function circle3(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): { x: number; y: number; r: number } | null {
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
  const x = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d, y = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  return { x, y, r: Math.hypot(ax - x, ay - y) };
}
const norm = (a: number) => { a %= Math.PI * 2; return a < 0 ? a + Math.PI * 2 : a; };
function arcThrough(c: { x: number; y: number; r: number }, sx: number, sy: number, mx: number, my: number, ex: number, ey: number, layer: string): DArc | null {
  const t0 = Math.atan2(sy - c.y, sx - c.x), tm = Math.atan2(my - c.y, mx - c.x), t1 = Math.atan2(ey - c.y, ex - c.x);
  const fwd = norm(tm - t0) < norm(t1 - t0);
  const a0 = fwd ? t0 : t1, a1 = fwd ? t1 : t0, sweep = norm(a1 - a0);
  if (sweep < 0.35 || sweep > 3.5) return null;
  return { x: c.x, y: c.y, r: c.r, a0, a1, layer };
}

export async function pdfPageVectors(data: ArrayBuffer, pageNum = 1): Promise<PdfVectors> {
  const { pdfjs, page } = await openPdfPage(data, pageNum);
  const OPS = pdfjs.OPS;
  const vp = page.getViewport({ scale: 1 });
  const list = await page.getOperatorList();
  const segs: DSeg[] = [], arcs: DArc[] = [];
  let ctm: M = vp.transform.slice();
  let lw = 1, lum = 0, dash = false;
  const stack: { ctm: M; lw: number; lum: number; dash: boolean }[] = [];
  // subtrazos pendientes de pintar, ya en coordenadas de página
  let subs: { pts: number[]; closed: boolean; curves: number[][] }[] = [];
  const X = (x: number, y: number) => ctm[0] * x + ctm[2] * y + ctm[4], Y = (x: number, y: number) => ctm[1] * x + ctm[3] * y + ctm[5];

  const emit = (stroke: boolean, fill: boolean, close: boolean) => {
    const width = lw * Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]));
    const layer = fill && lum < 0.45 ? 'relleno' : stroke ? 'trazo:' + (Math.round(width * 20) / 20).toFixed(2) : 'fondo';
    for (const s of subs) {
      const p = s.pts, n = p.length / 2;
      if (close || fill) s.closed = true;
      // un trazo abierto cuyos puntos caen sobre un círculo es un arco (el abatimiento de una puerta)
      if (stroke && !fill && !s.closed && n >= 6) {
        const m = Math.floor(n / 2) * 2;
        const c = circle3(p[0], p[1], p[m], p[m + 1], p[p.length - 2], p[p.length - 1]);
        if (c && c.r > 1) {
          let ok = true;
          for (let i = 0; i < p.length; i += 2) if (Math.abs(Math.hypot(p[i] - c.x, p[i + 1] - c.y) - c.r) > 0.03 * c.r + 0.2) { ok = false; break; }
          const a = ok ? arcThrough(c, p[0], p[1], p[m], p[m + 1], p[p.length - 2], p[p.length - 1], layer) : null;
          if (a) { arcs.push(a); continue; }
        }
      }
      for (const cv of s.curves) {
        const mx = (cv[0] + 3 * cv[2] + 3 * cv[4] + cv[6]) / 8, my = (cv[1] + 3 * cv[3] + 3 * cv[5] + cv[7]) / 8;
        const c = circle3(cv[0], cv[1], mx, my, cv[6], cv[7]);
        const a = c && c.r > 1 ? arcThrough(c, cv[0], cv[1], mx, my, cv[6], cv[7], layer) : null;
        if (a) arcs.push(a);
      }
      for (let i = 0; i + 3 < p.length; i += 2) segs.push({ x1: p[i], y1: p[i + 1], x2: p[i + 2], y2: p[i + 3], layer, dash });
      if (s.closed && n >= 3) segs.push({ x1: p[p.length - 2], y1: p[p.length - 1], x2: p[0], y2: p[1], layer, dash });
    }
    subs = [];
  };

  const { fnArray, argsArray } = list;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i], a = argsArray[i];
    switch (fn) {
      case OPS.save: stack.push({ ctm: ctm.slice(), lw, lum, dash }); break;
      case OPS.restore: { const s = stack.pop(); if (s) { ctm = s.ctm; lw = s.lw; lum = s.lum; dash = s.dash; } break; }
      case OPS.transform: ctm = mul(ctm, a); break;
      case OPS.paintFormXObjectBegin: stack.push({ ctm: ctm.slice(), lw, lum, dash }); if (Array.isArray(a?.[0]) || a?.[0]?.length === 6) ctm = mul(ctm, a[0]); break;
      case OPS.paintFormXObjectEnd: { const s = stack.pop(); if (s) { ctm = s.ctm; lw = s.lw; lum = s.lum; dash = s.dash; } break; }
      case OPS.setLineWidth: lw = a[0]; break;
      case OPS.setDash: dash = Array.isArray(a[0]) ? a[0].length > 0 : !!a[0]?.length; break;
      case OPS.setFillRGBColor: lum = typeof a[0] === 'string'
        ? (parseInt(a[0].slice(1, 3), 16) * 0.299 + parseInt(a[0].slice(3, 5), 16) * 0.587 + parseInt(a[0].slice(5, 7), 16) * 0.114) / 255
        : (a[0] * 0.299 + a[1] * 0.587 + a[2] * 0.114) / 255; break;
      case OPS.setGState: for (const [k, v] of a[0] || []) if (k === 'LW') lw = v; break;
      case OPS.constructPath: {
        const ops: number[] = a[0], args: number[] = a[1];
        let cur: { pts: number[]; closed: boolean; curves: number[][] } | null = null;
        let x = 0, y = 0;
        const start = (px: number, py: number) => { cur = { pts: [X(px, py), Y(px, py)], closed: false, curves: [] }; subs.push(cur); x = px; y = py; };
        const line = (px: number, py: number) => { if (!cur) start(x, y); cur!.pts.push(X(px, py), Y(px, py)); x = px; y = py; };
        const curve = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) => {
          if (!cur) start(x, y);
          cur!.curves.push([X(x, y), Y(x, y), X(x1, y1), Y(x1, y1), X(x2, y2), Y(x2, y2), X(x3, y3), Y(x3, y3)]);
          // la curva corta el trazo: lo que sigue es otro tramo recto
          cur = null; x = x3; y = y3;
        };
        for (let k = 0, j = 0; k < ops.length; k++) {
          switch (ops[k] | 0) {
            case OPS.rectangle: { const rx = args[j++], ry = args[j++], rw = args[j++], rh = args[j++]; start(rx, ry); line(rx + rw, ry); line(rx + rw, ry + rh); line(rx, ry + rh); cur!.closed = true; cur = null; x = rx; y = ry; break; }
            case OPS.moveTo: start(args[j++], args[j++]); break;
            case OPS.lineTo: line(args[j++], args[j++]); break;
            case OPS.curveTo: curve(args[j++], args[j++], args[j++], args[j++], args[j++], args[j++]); break;
            case OPS.curveTo2: { const x2 = args[j++], y2 = args[j++], x3 = args[j++], y3 = args[j++]; curve(x, y, x2, y2, x3, y3); break; }
            case OPS.curveTo3: { const x1 = args[j++], y1 = args[j++], x3 = args[j++], y3 = args[j++]; curve(x1, y1, x3, y3, x3, y3); break; }
            case OPS.closePath: if (cur) { (cur as { closed: boolean }).closed = true; cur = null; } break;
          }
        }
        break;
      }
      case OPS.stroke: emit(true, false, false); break;
      case OPS.closeStroke: emit(true, false, true); break;
      case OPS.fill: case OPS.eoFill: emit(false, true, true); break;
      case OPS.fillStroke: case OPS.eoFillStroke: emit(true, true, true); break;
      case OPS.closeFillStroke: case OPS.closeEOFillStroke: emit(true, true, true); break;
      case OPS.endPath: subs = []; break;
    }
  }
  // textos (para nombrar recintos): se guarda el centro aproximado de cada uno
  const texts: { x: number; y: number; text: string }[] = [];
  try {
    const tc = await page.getTextContent();
    for (const it of tc.items as any[]) {
      const str = (it.str || '').trim();
      if (!str || !it.transform) continue;
      const m = mul(vp.transform, it.transform);
      const ux = m[0], uy = m[1], l = Math.hypot(ux, uy) || 1, wdt = (it.width || 0), hgt = (it.height || 0);
      texts.push({ x: m[4] + (ux / l) * (wdt / 2) + (uy / l) * (hgt / 2), y: m[5] + (uy / l) * (wdt / 2) - (ux / l) * (hgt / 2), text: str });
    }
  } catch { /* sin textos */ }
  return { segs, arcs, texts, w: vp.width, h: vp.height };
}

/**
 * Elige en qué trazos buscar muros: primero los rellenos oscuros (muros macizos),
 * luego las líneas más gruesas y por último todo. `test` devuelve cuántos muros salen.
 */
export function pdfWallLayers(v: PdfVectors, test: (layers: Set<string>) => number): Set<string> | null {
  const total = new Map<string, number>();
  for (const s of v.segs) total.set(s.layer || '', (total.get(s.layer || '') || 0) + Math.hypot(s.x2 - s.x1, s.y2 - s.y1));
  const strokes = [...total.keys()].filter(l => l.startsWith('trazo:'));
  const all = [...total.values()].reduce((a, b) => a + b, 0) || 1;
  const widths = strokes.filter(l => (total.get(l) || 0) > all * 0.03).map(l => parseFloat(l.slice(6)));
  const maxW = Math.max(0, ...widths);
  const tries: Set<string>[] = [];
  if (total.has('relleno')) tries.push(new Set(['relleno']));
  const thick = strokes.filter(l => parseFloat(l.slice(6)) >= maxW * 0.6);
  if (thick.length && thick.length < strokes.length) tries.push(new Set(thick));
  tries.push(new Set([...strokes, ...(total.has('relleno') ? ['relleno'] : [])]));
  let best: Set<string> | null = null, bn = 0;
  for (const t of tries) { const n = test(t); if (n >= 3) return t; if (n > bn) { bn = n; best = t; } }
  return best;
}
