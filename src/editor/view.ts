import type { Pt } from '../core/model';
import type { Prim } from '../core/scene';
import type { Theme } from '../core/themes';

export const FONT = 'Inter, "Segoe UI", system-ui, -apple-system, Roboto, sans-serif';

/** Cámara 2D: convierte entre metros del plano y píxeles de pantalla. */
export class View {
  zoom = 60; // píxeles por metro
  ox = 80; oy = 80;
  w = 800; h = 600;
  dpr = 1;
  ctx: CanvasRenderingContext2D;

  constructor(public canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }
  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.w = Math.max(50, r.width); this.h = Math.max(50, r.height);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }
  toScreen(p: Pt): Pt { return { x: p.x * this.zoom + this.ox, y: p.y * this.zoom + this.oy }; }
  toWorld(sx: number, sy: number): Pt { return { x: (sx - this.ox) / this.zoom, y: (sy - this.oy) / this.zoom }; }
  zoomAt(sx: number, sy: number, factor: number) {
    const z = Math.max(4, Math.min(1500, this.zoom * factor));
    const w = this.toWorld(sx, sy);
    this.zoom = z;
    this.ox = sx - w.x * z; this.oy = sy - w.y * z;
  }
  fit(b: { minX: number; minY: number; maxX: number; maxY: number } | null, pad = 70) {
    if (!b) { this.zoom = 60; this.ox = this.w / 2 - 4 * 60; this.oy = this.h / 2 - 3 * 60; return; }
    const bw = Math.max(0.5, b.maxX - b.minX), bh = Math.max(0.5, b.maxY - b.minY);
    this.zoom = Math.max(4, Math.min(220, Math.min((this.w - pad * 2) / bw, (this.h - pad * 2) / bh)));
    this.ox = this.w / 2 - ((b.minX + b.maxX) / 2) * this.zoom;
    this.oy = this.h / 2 - ((b.minY + b.maxY) / 2) * this.zoom;
  }
  /**
   * Metros por milímetro de papel para textos y cotas en pantalla. Sigue la
   * escala del plano, pero se limita para que el texto siempre sea legible.
   */
  annot(scale: number): number {
    const base = scale / 1000;
    const lo = 9.5 / (2.5 * this.zoom), hi = 15 / (2.5 * this.zoom);
    return Math.max(lo, Math.min(hi, base));
  }
}

/** Dibuja primitivas en un canvas 2D. Se usa en pantalla y al exportar PNG. */
export function drawPrims(ctx: CanvasRenderingContext2D, prims: Prim[], zoom: number, ox: number, oy: number, lwScale = 4) {
  ctx.lineJoin = 'round'; ctx.lineCap = 'butt';
  for (const p of prims) {
    if (p.k === 'poly') {
      const n = p.pts.length;
      if (n < 4) continue;
      ctx.beginPath();
      ctx.moveTo(p.pts[0] * zoom + ox, p.pts[1] * zoom + oy);
      for (let i = 2; i < n; i += 2) ctx.lineTo(p.pts[i] * zoom + ox, p.pts[i + 1] * zoom + oy);
      if (p.closed) ctx.closePath();
      if (p.fill) { ctx.fillStyle = p.fill; ctx.fill(); }
      if (p.stroke) {
        ctx.strokeStyle = p.stroke; ctx.lineWidth = Math.max(0.6, (p.lw || 0.25) * lwScale);
        if (p.dash) ctx.setLineDash([lwScale * 1.5, lwScale]);
        ctx.stroke();
        if (p.dash) ctx.setLineDash([]);
      }
    } else if (p.k === 'arc') {
      ctx.beginPath();
      ctx.arc(p.cx * zoom + ox, p.cy * zoom + oy, Math.max(0, p.r * zoom), p.a0, p.a1);
      ctx.strokeStyle = p.stroke; ctx.lineWidth = Math.max(0.6, (p.lw || 0.25) * lwScale);
      if (p.dash) ctx.setLineDash([lwScale * 1.5, lwScale]);
      ctx.stroke();
      if (p.dash) ctx.setLineDash([]);
    } else if (p.k === 'circle') {
      ctx.beginPath();
      ctx.arc(p.cx * zoom + ox, p.cy * zoom + oy, Math.max(0, p.r * zoom), 0, Math.PI * 2);
      if (p.fill) { ctx.fillStyle = p.fill; ctx.fill(); }
      if (p.stroke) { ctx.strokeStyle = p.stroke; ctx.lineWidth = Math.max(0.6, (p.lw || 0.25) * lwScale); ctx.stroke(); }
    } else {
      const px = p.h * zoom;
      if (px < 2.5) continue;
      ctx.save();
      ctx.translate(p.x * zoom + ox, p.y * zoom + oy);
      if (p.rot) ctx.rotate(p.rot);
      ctx.font = `${p.bold ? '600 ' : ''}${px}px ${FONT}`;
      ctx.textAlign = p.align === 'l' ? 'left' : p.align === 'r' ? 'right' : 'center';
      ctx.textBaseline = 'middle';
      if (p.halo) { ctx.strokeStyle = p.halo; ctx.lineWidth = Math.max(2, px * 0.35); ctx.lineJoin = 'round'; ctx.strokeText(p.text, 0, 0); }
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, 0, 0);
      ctx.restore();
    }
  }
}

const GRID_STEPS = [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 50, 100, 500];

export function drawGrid(ctx: CanvasRenderingContext2D, v: View, theme: Theme) {
  let i = GRID_STEPS.findIndex(s => s * v.zoom >= 9);
  if (i < 0) i = GRID_STEPS.length - 2;
  const minor = GRID_STEPS[i], major = GRID_STEPS[Math.min(GRID_STEPS.length - 1, i + 1)];
  const w0 = v.toWorld(0, 0), w1 = v.toWorld(v.w, v.h);
  const line = (step: number, color: string, lw: number) => {
    ctx.strokeStyle = color; ctx.lineWidth = lw;
    ctx.beginPath();
    for (let x = Math.floor(w0.x / step) * step; x <= w1.x; x += step) { const sx = Math.round(x * v.zoom + v.ox) + 0.5; ctx.moveTo(sx, 0); ctx.lineTo(sx, v.h); }
    for (let y = Math.floor(w0.y / step) * step; y <= w1.y; y += step) { const sy = Math.round(y * v.zoom + v.oy) + 0.5; ctx.moveTo(0, sy); ctx.lineTo(v.w, sy); }
    ctx.stroke();
  };
  line(minor, theme.grid, 1);
  line(major, theme.gridMajor, 1);
}

/** Etiqueta flotante tipo "píldora" en coordenadas de pantalla. */
export function pill(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, bg = '#1f6feb', fg = '#ffffff') {
  ctx.save();
  ctx.font = `600 12px ${FONT}`;
  const w = ctx.measureText(text).width + 14, h = 22;
  ctx.fillStyle = bg;
  ctx.beginPath();
  (ctx as any).roundRect ? (ctx as any).roundRect(x - w / 2, y - h / 2, w, h, 6) : ctx.rect(x - w / 2, y - h / 2, w, h);
  ctx.fill();
  ctx.fillStyle = fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + 0.5);
  ctx.restore();
}
