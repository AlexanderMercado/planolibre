// Vectorización simple de una imagen de plano: busca trazos rectos horizontales
// y verticales. Los trazos gruesos (muros rellenos) se entregan como sus dos
// caras, y los finos como una línea; después detect.ts los empareja en muros.
//
// Es deliberadamente simple: sirve para planos limpios, derechos y con buen
// contraste. Una foto torcida o con sombras no dará buen resultado.

import type { DSeg } from '../core/detect';

/** Capas de los trazos que entrega la vectorización. */
export const SOLID = 'macizo', LINE = 'linea';

export interface VectorizeOpts {
  /** largo mínimo de un trazo, en píxeles */
  minLen: number;
  /** desde este grosor un trazo se considera muro relleno */
  minThick: number;
  /** sobre este grosor es una mancha, no un muro */
  maxThick: number;
}

/**
 * `dark` tiene un byte por píxel (1 = oscuro), fila por fila. Devuelve segmentos en píxeles.
 *
 * Primero se separa lo "macizo" (píxeles que son gruesos en las dos direcciones: los muros
 * rellenos) de lo fino (líneas). Así una línea de ventana que cruza un muro no lo parte.
 */
export function vectorizeMask(dark: Uint8Array, w: number, h: number, o: VectorizeOpts): DSeg[] {
  const out: DSeg[] = [];
  const k = Math.max(3, Math.round(o.minThick));
  // píxeles cuyo tramo oscuro horizontal y vertical mide al menos k
  const okH = new Uint8Array(w * h), thick = new Uint8Array(w * h), thin = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w;) {
      if (!dark[y * w + x]) { x++; continue; }
      let e = x; while (e < w && dark[y * w + e]) e++;
      if (e - x >= k) okH.fill(1, y * w + x, y * w + e);
      x = e;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h;) {
      if (!dark[y * w + x]) { y++; continue; }
      let e = y; while (e < h && dark[e * w + x]) e++;
      if (e - y >= k) for (let j = y; j < e; j++) if (okH[j * w + x]) thick[j * w + x] = 1;
      y = e;
    }
  }
  for (let i = 0; i < thin.length; i++) thin[i] = dark[i] && !thick[i] ? 1 : 0;

  // una pasada genérica: `major` es el eje a lo largo del trazo y `minor` el perpendicular
  type R = { a: number; b: number; m0: number; m1: number };
  const pass = (nMinor: number, nMajor: number, at: (minor: number, major: number) => number, emit: (r: R) => void) => {
    let open: R[] = [];
    for (let m = 0; m <= nMinor; m++) {
      const next: R[] = [];
      if (m < nMinor) {
        let j = 0;
        while (j < nMajor) {
          if (!at(m, j)) { j++; continue; }
          let e = j + 1, gap = 0;
          // se toleran cortes de hasta 2 píxeles (ruido de compresión o escaneo)
          while (e < nMajor && (at(m, e) || (gap < 2 && e + 1 < nMajor && (at(m, e + 1) || (e + 2 < nMajor && at(m, e + 2)))))) { gap = at(m, e) ? 0 : gap + 1; e++; }
          if (e - j >= o.minLen) {
            const tol = Math.max(2, Math.round((e - j) * 0.01));
            const i = open.findIndex(r => r.m1 === m - 1 && Math.abs(r.a - j) <= tol && Math.abs(r.b - e) <= tol);
            if (i >= 0) { const r = open.splice(i, 1)[0]; r.m1 = m; next.push(r); }
            else next.push({ a: j, b: e, m0: m, m1: m });
          }
          j = e;
        }
      }
      for (const r of open) emit(r);
      open = next;
    }
  };
  // la "capa" dice de dónde salió cada trazo: cara de un muro macizo o línea fina
  const seg = (a: number, b: number, m: number, horizontal: boolean, layer: string) => out.push(horizontal ? { x1: a, y1: m, x2: b, y2: m, layer } : { x1: m, y1: a, x2: m, y2: b, layer });
  for (const horizontal of [true, false]) {
    const nMinor = horizontal ? h : w, nMajor = horizontal ? w : h;
    const px = (mask: Uint8Array) => (horizontal ? (m: number, j: number) => mask[m * w + j] : (m: number, j: number) => mask[j * w + m]);
    // muros macizos: se entregan sus dos caras
    pass(nMinor, nMajor, px(thick), r => { const th = r.m1 - r.m0 + 1; if (th >= k && th <= o.maxThick) { seg(r.a, r.b, r.m0, horizontal, SOLID); seg(r.a, r.b, r.m1 + 1, horizontal, SOLID); } });
    // líneas finas: una sola línea por su centro
    pass(nMinor, nMajor, px(thin), r => { if (r.m1 - r.m0 + 1 < k) seg(r.a, r.b, (r.m0 + r.m1 + 1) / 2, horizontal, LINE); });
  }
  return out;
}

/** Umbral de Otsu sobre un histograma de luminancia de 256 niveles. */
export function otsu(hist: number[] | Uint32Array, total: number): number {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const d = sumB / wB - (sum - sumB) / wF, v = wB * wF * d * d;
    if (v > best) { best = v; thr = i; }
  }
  return thr;
}

/** Carga la imagen, la pasa a blanco y negro y la vectoriza. `widthM` es su ancho real en metros. */
export async function vectorizeImage(dataUrl: string, widthM: number, maxSide = 2800): Promise<{ segs: DSeg[]; w: number; h: number }> {
  const img = new Image();
  await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('No se pudo leer la imagen de fondo.')); img.src = dataUrl; });
  const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const lum = new Uint8Array(w * h), hist = new Uint32Array(256);
  for (let i = 0, j = 0; i < lum.length; i++, j += 4) { const v = (px[j] * 77 + px[j + 1] * 150 + px[j + 2] * 29) >> 8; lum[i] = v; hist[v]++; }
  const thr = Math.max(80, Math.min(175, otsu(hist, lum.length)));
  let n = 0;
  const dark = new Uint8Array(w * h);
  for (let i = 0; i < lum.length; i++) if (lum[i] < thr) { dark[i] = 1; n++; }
  // plano en negativo (líneas claras sobre fondo oscuro, tipo blueprint)
  if (n > lum.length * 0.5) for (let i = 0; i < dark.length; i++) dark[i] = dark[i] ? 0 : 1;
  const ppm = w / widthM;
  const segs = vectorizeMask(dark, w, h, { minLen: Math.max(12, Math.round(0.35 * ppm)), minThick: Math.max(3, Math.round(0.05 * ppm)), maxThick: Math.max(6, Math.round(0.5 * ppm)) });
  return { segs, w, h };
}
