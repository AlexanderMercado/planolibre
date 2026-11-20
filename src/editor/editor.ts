// Editor interactivo: maneja el lienzo, el ratón/teclado y las herramientas.

import type { Dim, ID, Item, Label, Opening, OpeningKind, Pt, Sel, Shape } from '../core/model';
import { uid } from '../core/model';
import { add, dist, mid, mul, perp, projSeg, rotate, sub, unit } from '../core/geom';
import { store } from '../core/store';
import { addWall, levelBounds, nodeMap, openingFrames, removeNode, removeWalls, settleNodes, splitWall } from '../core/topology';
import { buildScene, dimPrims, itemCorners, itemPrims, type Prim } from '../core/scene';
import { THEMES, type Theme } from '../core/themes';
import { fmtArea, fmtLen, parseLen, unitSuffix } from '../core/units';
import { symbolDef } from '../core/symbols';
import { OPENING_DEFAULTS, nearestWall } from '../core/ops';
import { View, drawGrid, drawPrims, pill, FONT } from './view';
import { snapPoint, type Snap } from './snap';
import { boxSelect, dimLine, hitTest, itemLocal, labelBox } from './hit';

export interface PE { w: Pt; s: Pt; shift: boolean; alt: boolean; ctrl: boolean; button: number }

interface Tool {
  id: string;
  hint(): string;
  cursor?: string;
  down?(e: PE): void; move?(e: PE): void; up?(e: PE): void; dbl?(e: PE): void;
  key?(e: KeyboardEvent): boolean;
  /** devuelve true si había algo en curso que cancelar */
  cancel?(): boolean;
  overlay?(ctx: CanvasRenderingContext2D): void;
  leave?(): void;
}

const ACCENT = '#1f6feb';
const deg = (r: number) => (r * 180) / Math.PI;

/** Texto que el usuario teclea para dar una medida exacta mientras dibuja. */
class Typed {
  text = '';
  handle(e: KeyboardEvent, allowX = false): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (/^[0-9.,'"]$/.test(e.key) || (allowX && /^[x* ]$/i.test(e.key) && this.text)) { this.text += e.key; return true; }
    if (e.key === 'Backspace' && this.text) { this.text = this.text.slice(0, -1); return true; }
    return false;
  }
  clear() { this.text = ''; }
}

export class Editor {
  view: View;
  hover: Sel | null = null;
  last: PE | null = null;
  onHint: (s: string) => void = () => {};
  onCursor: (p: Pt | null) => void = () => {};
  onFocusField: (key: string) => void = () => {};
  onView: () => void = () => {};
  askText: (title: string, value: string, help?: string) => Promise<string | null> = async () => null;
  toast: (msg: string) => void = () => {};
  /** se llama cuando la imagen de fondo queda calibrada */
  onCalibrated: () => void = () => {};
  /** reconocer muros en la imagen o PDF de fondo (lo implementa la app) */
  detectBackground: () => void = () => {};

  private tools: Record<string, Tool>;
  private current = 'select';
  private dirty = false;
  private images = new Map<ID, HTMLImageElement>();
  private pan: { sx: number; sy: number; ox: number; oy: number } | null = null;
  private space = false;
  private pointers = new Map<number, Pt>();
  private pinch: { d: number; cx: number; cy: number } | null = null;
  private clip: { walls: { a: Pt; b: Pt; thickness: number; height: number }[]; openings: (Opening & { p: Pt })[]; items: Item[]; labels: Label[]; dims: Dim[]; shapes: Shape[] } | null = null;

  constructor(public canvas: HTMLCanvasElement) {
    this.view = new View(canvas);
    this.tools = {
      select: new SelectTool(this), wall: new WallTool(this), room: new RoomTool(this),
      door: new OpeningTool(this, 'door'), window: new OpeningTool(this, 'window'), gap: new OpeningTool(this, 'gap'),
      dim: new DimTool(this), measure: new MeasureTool(this), text: new TextTool(this), line: new LineTool(this),
      place: new PlaceTool(this), calibrate: new CalibrateTool(this), hand: new HandTool(this),
    };
    this.bind();
    store.on(ev => {
      if (ev === 'tool' && store.tool !== this.current) { this.tools[this.current]?.leave?.(); this.current = store.tool; }
      if (ev === 'tool' && !['select', 'hand', 'door', 'window', 'gap'].includes(store.tool) && store.selection.length) store.select([]);
      if (ev === 'tool') { this.updateCursor(); this.onHint(this.tool.hint()); }
      this.requestDraw();
    });
    new ResizeObserver(() => {
      this.view.resize();
      // Si se pidió encuadrar cuando el lienzo aún no tenía tamaño (pestaña oculta o panel abriéndose), se repite ahora.
      if (this.pendingFit && this.view.w > 120 && this.view.h > 120) this.fit();
      this.requestDraw();
    }).observe(canvas);
    this.view.resize();
  }

  get tool(): Tool { return this.tools[store.tool] || this.tools.select; }
  theme(): Theme { return THEMES[store.viewMode === '3d' ? 'color' : store.viewMode]; }
  annot(): number { return this.view.annot(store.project.scale); }
  refreshHint() { this.onHint(this.tool.hint()); }

  // ─────────────────────────── eventos ───────────────────────────

  private pe(ev: PointerEvent | MouseEvent): PE {
    const r = this.canvas.getBoundingClientRect();
    const s = { x: ev.clientX - r.left, y: ev.clientY - r.top };
    return { s, w: this.view.toWorld(s.x, s.y), shift: ev.shiftKey, alt: ev.altKey, ctrl: ev.ctrlKey || ev.metaKey, button: ev.button };
  }

  private bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', ev => {
      c.focus();
      const e = this.pe(ev);
      this.last = e;
      if (ev.pointerType === 'touch') {
        this.pointers.set(ev.pointerId, e.s);
        if (this.pointers.size === 2) {
          const [a, b] = [...this.pointers.values()];
          this.pinch = { d: dist(a, b), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
          this.tool.cancel?.();
          return;
        }
      }
      try { c.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
      if (ev.button === 1 || this.space || (ev.button === 0 && store.tool === 'hand')) {
        this.pan = { sx: e.s.x, sy: e.s.y, ox: this.view.ox, oy: this.view.oy };
        c.style.cursor = 'grabbing';
        return;
      }
      if (ev.button === 2) { if (!this.tool.cancel?.() && store.tool !== 'select') store.setTool('select'); this.requestDraw(); return; }
      if (ev.button !== 0) return;
      this.tool.down?.(e);
      this.requestDraw();
    });
    c.addEventListener('pointermove', ev => {
      const e = this.pe(ev);
      this.last = e;
      if (ev.pointerType === 'touch' && this.pointers.has(ev.pointerId)) {
        this.pointers.set(ev.pointerId, e.s);
        if (this.pinch && this.pointers.size === 2) {
          const [a, b] = [...this.pointers.values()];
          const d = dist(a, b), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
          this.view.ox += cx - this.pinch.cx; this.view.oy += cy - this.pinch.cy;
          if (this.pinch.d > 0) this.view.zoomAt(cx, cy, d / this.pinch.d);
          this.pinch = { d, cx, cy };
          this.requestDraw();
          return;
        }
      }
      if (this.pan) {
        this.view.ox = this.pan.ox + (e.s.x - this.pan.sx); this.view.oy = this.pan.oy + (e.s.y - this.pan.sy);
        this.requestDraw();
        return;
      }
      this.onCursor(e.w);
      this.tool.move?.(e);
      this.requestDraw();
    });
    const up = (ev: PointerEvent) => {
      this.pointers.delete(ev.pointerId);
      if (this.pinch) { if (this.pointers.size < 2) this.pinch = null; return; }
      if (this.pan) { this.pan = null; this.updateCursor(); return; }
      if (ev.button !== 0) return;
      this.tool.up?.(this.pe(ev));
      this.requestDraw();
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('pointerleave', () => { this.onCursor(null); });
    c.addEventListener('dblclick', ev => { this.tool.dbl?.(this.pe(ev)); this.requestDraw(); });
    c.addEventListener('contextmenu', ev => ev.preventDefault());
    c.addEventListener('wheel', ev => {
      ev.preventDefault();
      const e = this.pe(ev);
      const dy = ev.deltaMode === 1 ? ev.deltaY * 33 : ev.deltaY;
      this.view.zoomAt(e.s.x, e.s.y, Math.exp(-dy * (ev.ctrlKey ? 0.01 : 0.0018)));
      this.requestDraw();
    }, { passive: false });
    window.addEventListener('keydown', ev => this.onKey(ev));
    window.addEventListener('keyup', ev => { if (ev.code === 'Space') { this.space = false; this.updateCursor(); } });
  }

  private onKey(ev: KeyboardEvent) {
    const t = ev.target as HTMLElement;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (typing) { if (ev.key === 'Escape') (t as HTMLElement).blur(); return; }
    if (document.querySelector('.modal-backdrop')) return;
    if (store.viewMode === '3d') return;
    const mod = ev.ctrlKey || ev.metaKey;
    if (this.tool.key?.(ev)) { ev.preventDefault(); this.requestDraw(); return; }
    const k = ev.key.toLowerCase();
    if (ev.code === 'Space') { this.space = true; this.canvas.style.cursor = 'grab'; ev.preventDefault(); return; }
    if (ev.key === 'Escape') {
      if (!this.tool.cancel?.()) { if (store.tool !== 'select') store.setTool('select'); else store.select([]); }
      this.refreshHint(); this.requestDraw(); return;
    }
    if (mod && k === 'z') { ev.preventDefault(); ev.shiftKey ? store.redo() : store.undo(); return; }
    if (mod && k === 'y') { ev.preventDefault(); store.redo(); return; }
    if (mod && k === 'c') { this.copy(); return; }
    if (mod && k === 'v') { ev.preventDefault(); this.paste(); return; }
    if (mod && k === 'd') { ev.preventDefault(); this.duplicate(); return; }
    if (mod && k === 'a') { ev.preventDefault(); this.selectAll(); return; }
    if (mod) return;
    if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); this.deleteSelection(); return; }
    if (ev.key.startsWith('Arrow')) {
      const s = store.project.settings.gridStep * (ev.shiftKey ? 10 : 1);
      const d = ev.key === 'ArrowLeft' ? { x: -s, y: 0 } : ev.key === 'ArrowRight' ? { x: s, y: 0 } : ev.key === 'ArrowUp' ? { x: 0, y: -s } : { x: 0, y: s };
      if (store.selection.length) { ev.preventDefault(); this.nudge(d); }
      return;
    }
    const map: Record<string, string> = { v: 'select', m: 'wall', h: 'room', p: 'door', n: 'window', c: 'dim', t: 'text', l: 'line', d: 'measure' };
    if (k === 'r' && store.selection.some(s => s.type === 'item' || s.type === 'label')) { this.rotateSelection(ev.shiftKey ? -90 : 90); return; }
    if (k === 'f') { this.fit(); return; }
    if (map[k]) { if (!store.advanced && ['dim', 'line'].includes(map[k])) return; store.setTool(map[k]); }
  }

  updateCursor() {
    this.canvas.style.cursor = this.space ? 'grab' : this.tool.cursor || (store.tool === 'select' ? (this.hover ? 'pointer' : 'default') : 'crosshair');
  }

  // ─────────────────────────── comandos ───────────────────────────

  private pendingFit = false;
  fit() {
    this.pendingFit = this.view.w <= 120 || this.view.h <= 120;
    this.view.fit(levelBounds(store.level)); this.requestDraw();
  }
  zoomBy(f: number) { this.view.zoomAt(this.view.w / 2, this.view.h / 2, f); this.requestDraw(); }

  /** Quita de la selección lo que ya no existe. */
  pruneSelection() {
    const lv = store.level;
    const has: Record<string, (id: ID) => boolean> = {
      node: id => lv.nodes.some(n => n.id === id), wall: id => lv.walls.some(n => n.id === id), opening: id => lv.openings.some(n => n.id === id),
      item: id => lv.items.some(n => n.id === id), dim: id => lv.dims.some(n => n.id === id), label: id => lv.labels.some(n => n.id === id),
      shape: id => lv.shapes.some(n => n.id === id), room: id => store.derived().rooms.some(r => r.key === id), background: () => !!lv.background,
    };
    const next = store.selection.filter(s => has[s.type](s.id));
    if (next.length !== store.selection.length) store.select(next);
  }

  deleteSelection() {
    const sel = store.selection;
    if (!sel.length) return;
    const lv = store.level;
    store.checkpoint();
    const ids = (t: Sel['type']) => new Set(sel.filter(s => s.type === t).map(s => s.id));
    const walls = ids('wall'), nodes = ids('node'), op = ids('opening'), it = ids('item'), dm = ids('dim'), lb = ids('label'), sh = ids('shape');
    lv.openings = lv.openings.filter(o => !op.has(o.id));
    lv.items = lv.items.filter(o => !it.has(o.id));
    lv.dims = lv.dims.filter(o => !dm.has(o.id));
    lv.labels = lv.labels.filter(o => !lb.has(o.id));
    if (sh.size) {
      const groups = new Set(lv.shapes.filter(s => sh.has(s.id) && s.group).map(s => s.group));
      lv.shapes = lv.shapes.filter(s => !sh.has(s.id) && !(s.group && groups.has(s.group)));
    }
    if (walls.size) removeWalls(lv, [...walls]);
    for (const n of nodes) removeNode(lv, n);
    const rooms = store.derived().rooms;
    for (const s of sel) if (s.type === 'room') { const r = rooms.find(x => x.key === s.id); if (r?.meta) lv.rooms = lv.rooms.filter(m => m !== r.meta); }
    if (sel.some(s => s.type === 'background') && lv.background) { delete store.project.assets[lv.background.asset]; lv.background = null; }
    store.selection = [];
    store.touch();
    store.emit('select');
  }

  selectAll() {
    if (store.viewer) return;
    const lv = store.level;
    store.select([
      ...lv.walls.map(w => ({ type: 'wall' as const, id: w.id })), ...lv.items.map(w => ({ type: 'item' as const, id: w.id })),
      ...lv.labels.map(w => ({ type: 'label' as const, id: w.id })), ...lv.dims.map(w => ({ type: 'dim' as const, id: w.id })),
      ...lv.shapes.map(w => ({ type: 'shape' as const, id: w.id })),
    ]);
  }

  copy() {
    const lv = store.level, nodes = nodeMap(lv), sel = store.selection;
    const has = (t: Sel['type'], id: ID) => sel.some(s => s.type === t && s.id === id);
    const geoms = store.derived().geoms;
    const wallIds = new Set(lv.walls.filter(w => has('wall', w.id)).map(w => w.id));
    const frames = openingFrames(lv, geoms);
    this.clip = JSON.parse(JSON.stringify({
      walls: lv.walls.filter(w => wallIds.has(w.id)).map(w => ({ a: nodes.get(w.a), b: nodes.get(w.b), thickness: w.thickness, height: w.height })),
      openings: frames.filter(f => wallIds.has(f.o.wall) || has('opening', f.o.id)).filter(f => wallIds.has(f.o.wall)).map(f => ({ ...f.o, p: f.c })),
      items: lv.items.filter(i => has('item', i.id)), labels: lv.labels.filter(i => has('label', i.id)),
      dims: lv.dims.filter(i => has('dim', i.id)), shapes: lv.shapes.filter(i => has('shape', i.id)),
    }));
    const n = this.clip!.walls.length + this.clip!.items.length + this.clip!.labels.length + this.clip!.dims.length + this.clip!.shapes.length;
    if (n) this.toast(`${n} elemento${n === 1 ? '' : 's'} copiado${n === 1 ? '' : 's'}`);
  }

  paste(off = 0.5) {
    if (store.viewer) return;
    const c = this.clip;
    if (!c) return;
    const lv = store.level;
    store.checkpoint();
    const sel: Sel[] = [];
    const o = { x: off, y: off };
    for (const w of c.walls) for (const id of addWall(lv, add(w.a, o), add(w.b, o), w.thickness, w.height)) sel.push({ type: 'wall', id });
    for (const op of c.openings) {
      const nw = nearestWall(lv, add(op.p, o), 0.05);
      if (nw) { const { p, ...rest } = op; lv.openings.push({ ...rest, id: uid('o'), wall: nw.id, t: nw.t }); }
    }
    for (const it of c.items) { const n = { ...it, id: uid('i'), x: it.x + off, y: it.y + off }; lv.items.push(n); sel.push({ type: 'item', id: n.id }); }
    for (const it of c.labels) { const n = { ...it, id: uid('t'), x: it.x + off, y: it.y + off }; lv.labels.push(n); sel.push({ type: 'label', id: n.id }); }
    for (const it of c.dims) { const n = { ...it, id: uid('d'), x1: it.x1 + off, y1: it.y1 + off, x2: it.x2 + off, y2: it.y2 + off }; lv.dims.push(n); sel.push({ type: 'dim', id: n.id }); }
    for (const it of c.shapes) {
      const n: Shape = { ...it, id: uid('s'), group: undefined, pts: it.pts.map((v, i) => (it.kind === 'poly' || i < 2 ? v + off : v)) };
      lv.shapes.push(n); sel.push({ type: 'shape', id: n.id });
    }
    // el siguiente pegado cae un poco más allá
    for (const w of c.walls) { w.a = add(w.a, o); w.b = add(w.b, o); }
    for (const op of c.openings) op.p = add(op.p, o);
    for (const it of c.items) { it.x += off; it.y += off; }
    for (const it of c.labels) { it.x += off; it.y += off; }
    for (const it of c.dims) { it.x1 += off; it.y1 += off; it.x2 += off; it.y2 += off; }
    for (const it of c.shapes) it.pts = it.pts.map((v, i) => (it.kind === 'poly' || i < 2 ? v + off : v));
    store.touch();
    store.select(sel);
  }

  duplicate() {
    const saved = this.clip;
    this.clip = null;
    const t = this.toast; this.toast = () => {};
    this.copy(); this.toast = t;
    this.paste();
    this.clip = saved;
  }

  nudge(d: Pt) {
    const lv = store.level, sel = store.selection;
    const nodeIds = new Set<ID>();
    for (const s of sel) {
      if (s.type === 'node') nodeIds.add(s.id);
      if (s.type === 'wall') { const w = lv.walls.find(x => x.id === s.id); if (w) { nodeIds.add(w.a); nodeIds.add(w.b); } }
    }
    store.checkpoint();
    for (const n of lv.nodes) if (nodeIds.has(n.id)) { n.x += d.x; n.y += d.y; }
    for (const s of sel) {
      if (s.type === 'item') { const it = lv.items.find(x => x.id === s.id); if (it) { it.x += d.x; it.y += d.y; } }
      if (s.type === 'label') { const it = lv.labels.find(x => x.id === s.id); if (it) { it.x += d.x; it.y += d.y; } }
      if (s.type === 'dim') { const it = lv.dims.find(x => x.id === s.id); if (it) { it.x1 += d.x; it.y1 += d.y; it.x2 += d.x; it.y2 += d.y; } }
      if (s.type === 'shape') { const it = lv.shapes.find(x => x.id === s.id); if (it) moveShape(it, d); }
    }
    if (nodeIds.size) settleNodes(lv, [...nodeIds]);
    store.touch();
    this.pruneSelection();
  }

  rotateSelection(by: number) {
    const lv = store.level;
    const targets = store.selection.filter(s => s.type === 'item' || s.type === 'label');
    if (!targets.length) return;
    store.checkpoint();
    for (const s of targets) {
      const it = s.type === 'item' ? lv.items.find(x => x.id === s.id) : lv.labels.find(x => x.id === s.id);
      if (it) it.rot = (((it.rot + by) % 360) + 360) % 360;
    }
    store.touch();
  }

  // ─────────────────────────── dibujo ───────────────────────────

  getImage(asset: ID): HTMLImageElement | null {
    let img = this.images.get(asset);
    if (!img) {
      const src = store.project.assets[asset];
      if (!src) return null;
      img = new Image();
      img.onload = () => this.requestDraw();
      img.src = src;
      this.images.set(asset, img);
    }
    return img.complete && img.naturalWidth ? img : null;
  }

  requestDraw() {
    if (this.dirty) return;
    this.dirty = true;
    requestAnimationFrame(() => { this.dirty = false; this.draw(); });
  }

  scenePrims(): Prim[] {
    const st = store.project.settings, d = store.derived();
    return buildScene(store.level, {
      theme: this.theme(), annot: this.annot(), units: store.project.units, layers: st.layers,
      showRoomDims: st.showRoomDims, showAreas: st.showAreas, showOverallDims: st.showOverallDims, rooms: d.rooms, geoms: d.geoms,
    });
  }

  draw() {
    const v = this.view, ctx = v.ctx, theme = this.theme(), lv = store.level, st = store.project.settings;
    ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, v.w, v.h);
    if (st.layers.grid) drawGrid(ctx, v, theme);
    const bg = lv.background;
    if (bg && st.layers.background) {
      const img = this.getImage(bg.asset);
      if (img) {
        ctx.globalAlpha = bg.opacity;
        const s = v.toScreen(bg);
        ctx.drawImage(img, s.x, s.y, bg.w * v.zoom, bg.h * v.zoom);
        ctx.globalAlpha = 1;
      }
    }
    // nivel inferior como referencia
    const below = store.project.levels[store.project.activeLevel - 1];
    if (below && st.layers.walls) {
      const nodes = nodeMap(below);
      ctx.strokeStyle = 'rgba(120,135,160,0.28)'; ctx.lineCap = 'square';
      for (const w of below.walls) {
        const a = nodes.get(w.a), b = nodes.get(w.b);
        if (!a || !b) continue;
        const sa = v.toScreen(a), sb = v.toScreen(b);
        ctx.lineWidth = Math.max(1, w.thickness * v.zoom);
        ctx.beginPath(); ctx.moveTo(sa.x, sa.y); ctx.lineTo(sb.x, sb.y); ctx.stroke();
      }
      ctx.lineCap = 'butt';
    }
    drawPrims(ctx, this.scenePrims(), v.zoom, v.ox, v.oy);
    this.drawSelection(ctx);
    if (['select', 'wall', 'room'].includes(store.tool) && st.layers.walls) this.drawNodes(ctx);
    this.tool.overlay?.(ctx);
    this.drawScaleBar(ctx, theme);
    this.onView();
  }

  private drawNodes(ctx: CanvasRenderingContext2D) {
    const v = this.view;
    if (v.zoom < 14) return;
    for (const n of store.level.nodes) {
      const s = v.toScreen(n);
      if (s.x < -10 || s.y < -10 || s.x > v.w + 10 || s.y > v.h + 10) continue;
      const sel = store.isSelected('node', n.id), hov = this.hover?.type === 'node' && this.hover.id === n.id;
      ctx.beginPath();
      ctx.arc(s.x, s.y, sel || hov ? 6.5 : 4, 0, Math.PI * 2);
      ctx.fillStyle = sel ? ACCENT : '#ffffff';
      ctx.fill();
      ctx.lineWidth = sel || hov ? 2.5 : 1.5; ctx.strokeStyle = ACCENT;
      ctx.stroke();
    }
  }

  poly(ctx: CanvasRenderingContext2D, pts: Pt[], close = true) {
    ctx.beginPath();
    pts.forEach((p, i) => { const s = this.view.toScreen(p); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); });
    if (close) ctx.closePath();
  }

  itemHandles(it: Item): { rot: Pt; size: Pt } {
    const a = (it.rot * Math.PI) / 180, c = { x: it.x, y: it.y };
    return {
      rot: rotate({ x: it.x, y: it.y - it.h / 2 - 26 / this.view.zoom }, a, c),
      size: rotate({ x: it.x + it.w / 2, y: it.y + it.h / 2 }, a, c),
    };
  }

  private drawSelection(ctx: CanvasRenderingContext2D) {
    const lv = store.level, d = store.derived(), v = this.view;
    const list: { s: Sel; hover: boolean }[] = store.selection.map(s => ({ s, hover: false }));
    if (this.hover && store.tool === 'select' && !store.isSelected(this.hover.type, this.hover.id)) list.push({ s: this.hover, hover: true });
    const frames = openingFrames(lv, d.geoms);
    for (const { s, hover } of list) {
      ctx.save();
      ctx.strokeStyle = ACCENT; ctx.lineWidth = hover ? 1.5 : 2;
      ctx.fillStyle = hover ? 'rgba(31,111,235,0.10)' : 'rgba(31,111,235,0.22)';
      if (s.type === 'wall') {
        const g = d.geoms.get(s.id);
        if (g) { this.poly(ctx, [g.aL, g.bL, g.bR, g.aR]); ctx.fill(); ctx.stroke(); }
      } else if (s.type === 'opening') {
        const f = frames.find(x => x.o.id === s.id);
        if (f) { const n = mul(f.g.nrm, f.thick / 2 + 2 / v.zoom); this.poly(ctx, [add(f.p0, n), add(f.p1, n), sub(f.p1, n), sub(f.p0, n)]); ctx.fill(); ctx.stroke(); }
      } else if (s.type === 'item') {
        const it = lv.items.find(x => x.id === s.id);
        if (it) {
          this.poly(ctx, itemCorners(it));
          if (!hover) ctx.setLineDash([5, 4]);
          ctx.stroke(); ctx.setLineDash([]);
          if (!hover && store.selection.length === 1) {
            const h = this.itemHandles(it), hr = v.toScreen(h.rot), hs = v.toScreen(h.size);
            const top = v.toScreen(rotate({ x: it.x, y: it.y - it.h / 2 }, (it.rot * Math.PI) / 180, { x: it.x, y: it.y }));
            ctx.beginPath(); ctx.moveTo(top.x, top.y); ctx.lineTo(hr.x, hr.y); ctx.stroke();
            ctx.fillStyle = '#fff';
            ctx.beginPath(); ctx.arc(hr.x, hr.y, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
            ctx.fillRect(hs.x - 5, hs.y - 5, 10, 10); ctx.strokeRect(hs.x - 5, hs.y - 5, 10, 10);
          }
        }
      } else if (s.type === 'label') {
        const l = lv.labels.find(x => x.id === s.id);
        if (l) {
          const b = labelBox(l, this.annot()), a = (l.rot * Math.PI) / 180;
          this.poly(ctx, [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => rotate({ x: l.x + (x * b.w) / 2, y: l.y + (y * b.h) / 2 }, a, l)));
          ctx.setLineDash([4, 3]); ctx.stroke();
        }
      } else if (s.type === 'dim') {
        const dm = lv.dims.find(x => x.id === s.id);
        if (dm) { const { q1, q2 } = dimLine(dm); ctx.lineWidth = 3; ctx.globalAlpha = 0.5; this.poly(ctx, [q1, q2], false); ctx.stroke(); }
      } else if (s.type === 'shape') {
        const sh = lv.shapes.find(x => x.id === s.id);
        if (sh) {
          ctx.globalAlpha = 0.75; ctx.lineWidth = 2;
          if (sh.kind === 'poly') { const pts: Pt[] = []; for (let i = 0; i + 1 < sh.pts.length; i += 2) pts.push({ x: sh.pts[i], y: sh.pts[i + 1] }); this.poly(ctx, pts, !!sh.closed); ctx.stroke(); }
          else if (sh.kind === 'text') {
            const hh = sh.h || 0.2, w = (sh.text || '').length * hh * 0.56, x0 = sh.align === 'c' ? -w / 2 : sh.align === 'r' ? -w : 0, o = { x: sh.pts[0], y: sh.pts[1] };
            this.poly(ctx, [[x0, -hh / 2], [x0 + w, -hh / 2], [x0 + w, hh / 2], [x0, hh / 2]].map(([x, y]) => rotate({ x: o.x + x, y: o.y + y }, sh.rot || 0, o)));
            ctx.lineWidth = 1; ctx.setLineDash([4, 3]); ctx.stroke();
          } else { const c = v.toScreen({ x: sh.pts[0], y: sh.pts[1] }); ctx.beginPath(); ctx.arc(c.x, c.y, Math.max(1, (sh.r || 0) * v.zoom), sh.kind === 'arc' ? sh.a0 || 0 : 0, sh.kind === 'arc' ? sh.a1 || 0 : Math.PI * 2); ctx.stroke(); }
        }
      } else if (s.type === 'room') {
        const r = d.rooms.find(x => x.key === s.id);
        if (r) { this.poly(ctx, r.inner); ctx.fill(); if (!hover) { ctx.setLineDash([6, 4]); ctx.stroke(); } }
      } else if (s.type === 'background' && lv.background) {
        const b = lv.background;
        this.poly(ctx, [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }]);
        ctx.setLineDash([6, 4]); ctx.stroke();
      }
      ctx.restore();
    }
  }

  private drawScaleBar(ctx: CanvasRenderingContext2D, theme: Theme) {
    const v = this.view, units = store.project.units;
    const nice = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
    const m = nice.find(n => n * v.zoom >= 70) || 500;
    const w = m * v.zoom, x = 16, y = v.h - 18;
    ctx.save();
    ctx.strokeStyle = theme.text; ctx.fillStyle = theme.text; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y - 5); ctx.stroke();
    ctx.font = `11px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText(fmtLen(m, units, true), x + w / 2, y - 3);
    ctx.restore();
  }

  /** Marca de ajuste y líneas guía. */
  drawSnap(ctx: CanvasRenderingContext2D, snap: Snap | null) {
    if (!snap) return;
    const v = this.view;
    ctx.save();
    ctx.strokeStyle = '#e5484d'; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
    for (const g of snap.guides) {
      const a = v.toScreen(g.a), b = v.toScreen(g.b);
      const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
      ctx.beginPath(); ctx.moveTo(a.x - (dx / L) * 20, a.y - (dy / L) * 20); ctx.lineTo(b.x + (dx / L) * 20, b.y + (dy / L) * 20); ctx.stroke();
    }
    ctx.setLineDash([]);
    const s = v.toScreen(snap.p);
    ctx.lineWidth = 2;
    if (snap.kind === 'node' || snap.kind === 'vertex') { ctx.strokeStyle = '#e5484d'; ctx.strokeRect(s.x - 7, s.y - 7, 14, 14); }
    else if (snap.kind === 'refaxis') {
      // eje de un muro del calco: rombo con su etiqueta, para que se entienda por qué el cursor no va a la cara
      ctx.strokeStyle = '#0f9d58';
      ctx.beginPath(); ctx.moveTo(s.x, s.y - 9); ctx.lineTo(s.x + 9, s.y); ctx.lineTo(s.x, s.y + 9); ctx.lineTo(s.x - 9, s.y); ctx.closePath(); ctx.stroke();
      pill(ctx, s.x, s.y - 24, 'eje del muro del calco', '#0f9d58');
    }
    else if (snap.kind === 'wall') { ctx.strokeStyle = '#e5484d'; ctx.beginPath(); ctx.moveTo(s.x - 6, s.y - 6); ctx.lineTo(s.x + 6, s.y + 6); ctx.moveTo(s.x + 6, s.y - 6); ctx.lineTo(s.x - 6, s.y + 6); ctx.stroke(); }
    else { ctx.fillStyle = ACCENT; ctx.beginPath(); ctx.arc(s.x, s.y, 3.5, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  }

  /** Etiqueta de longitud sobre un segmento (en vivo mientras se dibuja o arrastra). */
  lengthPill(ctx: CanvasRenderingContext2D, a: Pt, b: Pt, text?: string, bg = ACCENT) {
    const L = dist(a, b);
    if (L < 1e-4) return;
    const m = this.view.toScreen(mid(a, b));
    const n = perp(unit(sub(b, a)));
    pill(ctx, m.x + n.x * 20, m.y + n.y * 20, text ?? fmtLen(L, store.project.units, true), bg);
  }
}

function moveShape(s: Shape, d: Pt) {
  if (s.kind === 'poly') for (let i = 0; i + 1 < s.pts.length; i += 2) { s.pts[i] += d.x; s.pts[i + 1] += d.y; }
  else { s.pts[0] += d.x; s.pts[1] += d.y; }
}

// ═══════════════════════════ Herramientas ═══════════════════════════

type MoveDrag = {
  kind: 'move'; start: Pt; startS: Pt; moved: boolean; anchor: Pt; snapNodes: boolean;
  nodes: Map<ID, Pt>; items: Map<ID, Pt>; labels: Map<ID, Pt>; dims: Map<ID, Dim>; shapes: Map<ID, number[]>; bg: Pt | null;
};
type Drag =
  | MoveDrag
  | { kind: 'opening'; id: ID; moved: boolean; startS: Pt }
  | { kind: 'box'; a: Pt; b: Pt; additive: boolean; moved: boolean; startS: Pt }
  | { kind: 'rotate' | 'resize'; id: ID; moved: boolean }
  | { kind: 'dim'; id: ID; moved: boolean; startS: Pt };

class SelectTool implements Tool {
  id = 'select';
  private drag: Drag | null = null;
  private snap: Snap | null = null;
  constructor(private ed: Editor) {}
  hint() { return 'Arrastra los puntos, muros o muebles para modificarlos · Doble clic en un muro agrega un punto · Supr borra'; }

  private expand(hit: Sel): Sel[] {
    if (hit.type === 'shape') {
      const lv = store.level, s = lv.shapes.find(x => x.id === hit.id);
      if (s?.group) return lv.shapes.filter(x => x.group === s.group).map(x => ({ type: 'shape' as const, id: x.id }));
    }
    return [hit];
  }

  down(e: PE) {
    const ed = this.ed, lv = store.level, v = ed.view;
    this.snap = null;
    const single = store.selection.length === 1 ? store.selection[0] : null;
    if (single?.type === 'item') {
      const it = lv.items.find(x => x.id === single.id);
      if (it) {
        const h = ed.itemHandles(it);
        if (dist(v.toScreen(h.rot), e.s) < 10) { this.drag = { kind: 'rotate', id: it.id, moved: false }; return; }
        if (dist(v.toScreen(h.size), e.s) < 10) { this.drag = { kind: 'resize', id: it.id, moved: false }; return; }
      }
    }
    const hit = hitTest(lv, store.derived(), e.w, v.zoom, ed.annot());
    if (!hit) {
      if (!e.shift) store.select([]);
      this.drag = { kind: 'box', a: e.w, b: e.w, additive: e.shift, moved: false, startS: e.s };
      return;
    }
    if (e.shift) { store.select(this.expand(hit), true); return; }
    if (!store.isSelected(hit.type, hit.id)) store.select(this.expand(hit));
    if (hit.type === 'room') { this.drag = { kind: 'box', a: e.w, b: e.w, additive: true, moved: false, startS: e.s }; return; }
    if (hit.type === 'opening') { this.drag = { kind: 'opening', id: hit.id, moved: false, startS: e.s }; return; }
    if (hit.type === 'dim' && store.selection.length === 1) { this.drag = { kind: 'dim', id: hit.id, moved: false, startS: e.s }; return; }
    this.drag = this.startMove(e, hit);
  }

  private startMove(e: PE, hit: Sel): MoveDrag {
    const lv = store.level, nm = nodeMap(lv);
    const d: MoveDrag = { kind: 'move', start: e.w, startS: e.s, moved: false, anchor: e.w, snapNodes: false, nodes: new Map(), items: new Map(), labels: new Map(), dims: new Map(), shapes: new Map(), bg: null };
    for (const s of store.selection) {
      if (s.type === 'node') { const n = nm.get(s.id); if (n) d.nodes.set(n.id, { x: n.x, y: n.y }); }
      else if (s.type === 'wall') { const w = lv.walls.find(x => x.id === s.id); if (w) for (const id of [w.a, w.b]) { const n = nm.get(id); if (n) d.nodes.set(id, { x: n.x, y: n.y }); } }
      else if (s.type === 'item') { const it = lv.items.find(x => x.id === s.id); if (it) d.items.set(it.id, { x: it.x, y: it.y }); }
      else if (s.type === 'label') { const it = lv.labels.find(x => x.id === s.id); if (it) d.labels.set(it.id, { x: it.x, y: it.y }); }
      else if (s.type === 'dim') { const it = lv.dims.find(x => x.id === s.id); if (it) d.dims.set(it.id, { ...it }); }
      else if (s.type === 'shape') { const it = lv.shapes.find(x => x.id === s.id); if (it) d.shapes.set(it.id, it.pts.slice()); }
      else if (s.type === 'background' && lv.background) d.bg = { x: lv.background.x, y: lv.background.y };
    }
    if (hit.type === 'node') { d.anchor = { ...d.nodes.get(hit.id)! }; d.snapNodes = true; }
    else if (hit.type === 'wall') {
      const w = lv.walls.find(x => x.id === hit.id)!;
      const a = d.nodes.get(w.a)!, b = d.nodes.get(w.b)!;
      d.anchor = dist(a, e.w) < dist(b, e.w) ? { ...a } : { ...b };
      d.snapNodes = true;
    } else if (hit.type === 'item') d.anchor = { ...d.items.get(hit.id)! };
    else if (hit.type === 'label') d.anchor = { ...d.labels.get(hit.id)! };
    return d;
  }

  move(e: PE) {
    const ed = this.ed, lv = store.level, v = ed.view, d = this.drag, st = store.project.settings;
    if (!d) {
      const h = hitTest(lv, store.derived(), e.w, v.zoom, ed.annot());
      if (h?.type !== ed.hover?.type || h?.id !== ed.hover?.id) { ed.hover = h; ed.updateCursor(); }
      return;
    }
    const far = (s0: Pt) => dist(s0, e.s) > 3;
    if (d.kind === 'box') { d.b = e.w; if (far(d.startS)) d.moved = true; return; }
    if (d.kind === 'move') {
      if (!d.moved) { if (!far(d.startS)) return; store.checkpoint(); d.moved = true; }
      const raw = add(d.anchor, sub(e.w, d.start));
      let target: Pt;
      if (d.snapNodes) {
        this.snap = snapPoint(raw, v.zoom, { excludeNodes: new Set(d.nodes.keys()), free: e.alt, noWalls: d.nodes.size > 1 });
        target = this.snap.p;
      } else {
        const g = st.gridStep;
        target = e.alt || !st.snapGrid ? raw : { x: Math.round(raw.x / g) * g, y: Math.round(raw.y / g) * g };
      }
      const dl = sub(target, d.anchor);
      for (const n of lv.nodes) { const o = d.nodes.get(n.id); if (o) { n.x = o.x + dl.x; n.y = o.y + dl.y; } }
      for (const it of lv.items) { const o = d.items.get(it.id); if (o) { it.x = o.x + dl.x; it.y = o.y + dl.y; } }
      for (const it of lv.labels) { const o = d.labels.get(it.id); if (o) { it.x = o.x + dl.x; it.y = o.y + dl.y; } }
      for (const it of lv.dims) { const o = d.dims.get(it.id); if (o) { it.x1 = o.x1 + dl.x; it.y1 = o.y1 + dl.y; it.x2 = o.x2 + dl.x; it.y2 = o.y2 + dl.y; } }
      for (const it of lv.shapes) {
        const o = d.shapes.get(it.id);
        if (o) it.pts = o.map((val, i) => (it.kind === 'poly' || i < 2 ? val + (i % 2 ? dl.y : dl.x) : val));
      }
      if (d.bg && lv.background) { lv.background.x = d.bg.x + dl.x; lv.background.y = d.bg.y + dl.y; }
      store.touch();
      return;
    }
    if (d.kind === 'opening') {
      if (!d.moved) { if (!far(d.startS)) return; store.checkpoint(); d.moved = true; }
      const o = lv.openings.find(x => x.id === d.id);
      if (!o) return;
      placeOpening(o, e, this.ed);
      store.touch();
      return;
    }
    if (d.kind === 'dim') {
      if (!d.moved) { if (!far(d.startS)) return; store.checkpoint(); d.moved = true; }
      const dm = lv.dims.find(x => x.id === d.id);
      if (!dm) return;
      const p1 = { x: dm.x1, y: dm.y1 }, n = perp(unit(sub({ x: dm.x2, y: dm.y2 }, p1)));
      dm.offset = (e.w.x - p1.x) * n.x + (e.w.y - p1.y) * n.y;
      store.touch();
      return;
    }
    const it = lv.items.find(x => x.id === d.id);
    if (!it) return;
    if (!d.moved) { store.checkpoint(); d.moved = true; }
    if (d.kind === 'rotate') {
      let a = deg(Math.atan2(e.w.y - it.y, e.w.x - it.x)) + 90;
      if (!e.alt) a = Math.round(a / 15) * 15;
      it.rot = ((a % 360) + 360) % 360;
    } else {
      const q = itemLocal(it, e.w), g = e.alt ? 0.001 : 0.05;
      it.w = Math.max(0.1, Math.round((Math.abs(q.x) * 2) / g) * g);
      it.h = Math.max(0.1, Math.round((Math.abs(q.y) * 2) / g) * g);
    }
    store.touch();
  }

  up(_e: PE) {
    const d = this.drag, lv = store.level;
    this.drag = null; this.snap = null;
    if (!d) return;
    if (d.kind === 'box') {
      if (d.moved) store.select(boxSelect(lv, store.derived().geoms, d.a, d.b), d.additive && store.selection.every(s => s.type !== 'room'));
      return;
    }
    if (d.kind === 'move' && d.moved && d.nodes.size) {
      settleNodes(lv, [...d.nodes.keys()]);
      store.touch();
      this.ed.pruneSelection();
    }
  }

  dbl(e: PE) {
    const ed = this.ed, lv = store.level;
    const hit = hitTest(lv, store.derived(), e.w, ed.view.zoom, ed.annot());
    if (!hit) return;
    if (hit.type === 'wall') {
      store.checkpoint();
      const n = splitWall(lv, hit.id, e.w);
      if (!n) { store.dropCheckpoint(); return; }
      store.touch();
      store.select([{ type: 'node', id: n.id }]);
    } else if (hit.type === 'label') { store.select([hit]); ed.onFocusField('text'); }
    else if (hit.type === 'room') { store.select([hit]); ed.onFocusField('name'); }
  }

  cancel() { if (this.drag) { this.drag = null; return true; } return false; }

  overlay(ctx: CanvasRenderingContext2D) {
    const d = this.drag, ed = this.ed, v = ed.view, lv = store.level;
    if (!d) return;
    if (d.kind === 'box' && d.moved) {
      const a = v.toScreen(d.a), b = v.toScreen(d.b);
      ctx.fillStyle = 'rgba(31,111,235,0.08)'; ctx.strokeStyle = ACCENT; ctx.lineWidth = 1;
      ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y); ctx.strokeRect(a.x + 0.5, a.y + 0.5, b.x - a.x, b.y - a.y);
    }
    if (d.kind === 'move' && d.moved && d.nodes.size) {
      ed.drawSnap(ctx, this.snap);
      const nm = nodeMap(lv);
      const walls = lv.walls.filter(w => d.nodes.has(w.a) !== d.nodes.has(w.b) || (d.nodes.size === 1 && (d.nodes.has(w.a) || d.nodes.has(w.b))));
      for (const w of walls.slice(0, 10)) ed.lengthPill(ctx, nm.get(w.a)!, nm.get(w.b)!);
    }
    if (d.kind === 'opening' && d.moved) {
      const o = lv.openings.find(x => x.id === d.id);
      if (o) openingDistances(ctx, ed, o);
    }
    if ((d.kind === 'resize' || d.kind === 'rotate') && d.moved) {
      const it = lv.items.find(x => x.id === d.id);
      if (it) {
        const s = v.toScreen(it), u = store.project.units;
        pill(ctx, s.x, s.y, d.kind === 'resize' ? `${fmtLen(it.w, u)} × ${fmtLen(it.h, u, true)}` : `${Math.round(it.rot)}°`);
      }
    }
  }
}

/** Ubica una abertura sobre el muro más cercano al cursor. */
function placeOpening(o: Opening, e: PE, ed: Editor): boolean {
  const lv = store.level, st = store.project.settings;
  const nw = nearestWall(lv, e.w, Math.max(0.6, 40 / ed.view.zoom));
  if (!nw) return false;
  const g = store.derived().geoms.get(nw.id);
  if (!g) return false;
  const changed = o.wall !== nw.id;
  o.wall = nw.id;
  let s = nw.t * g.len;
  const w = Math.min(o.width, g.len - 0.06);
  if (!e.alt) {
    if (Math.abs(s - g.len / 2) < 9 / ed.view.zoom) s = g.len / 2;
    else if (st.snapGrid) s = Math.round((s - w / 2) / st.gridStep) * st.gridStep + w / 2;
  }
  s = Math.max(w / 2 + 0.03, Math.min(g.len - w / 2 - 0.03, s));
  o.t = g.len > 0 ? s / g.len : 0.5;
  if (changed || store.tool !== 'select') {
    const side = (e.w.x - nw.proj.x) * g.nrm.x + (e.w.y - nw.proj.y) * g.nrm.y;
    if (Math.abs(side) > 0.02) o.flipV = side < 0;
  }
  return true;
}

/** Muestra la distancia desde cada lado de la abertura hasta los extremos del muro. */
function openingDistances(ctx: CanvasRenderingContext2D, ed: Editor, o: Opening) {
  const f = openingFrames({ ...store.level, openings: [o] }, store.derived().geoms)[0];
  if (!f) return;
  const off = mul(f.g.nrm, -(f.thick / 2 + 16 / ed.view.zoom));
  if (f.s0 > 0.05) ed.lengthPill(ctx, add(f.g.a, off), add(f.p0, off), undefined, '#475569');
  if (f.g.len - f.s1 > 0.05) ed.lengthPill(ctx, add(f.p1, off), add(f.g.b, off), undefined, '#475569');
  const c = ed.view.toScreen(add(f.c, mul(f.g.nrm, f.thick / 2 + 22 / ed.view.zoom)));
  pill(ctx, c.x, c.y, fmtLen(f.width, store.project.units, true));
}

class WallTool implements Tool {
  id = 'wall';
  private start: Pt | null = null;
  private snap: Snap | null = null;
  private typed = new Typed();
  private count = 0;
  constructor(private ed: Editor) {}
  hint() {
    return this.start
      ? 'Clic para fijar el siguiente punto · Escribe una medida y Enter para un largo exacto · Mayús = ángulo recto · Esc para terminar'
      : 'Haz clic donde empieza el muro. Los muros se unen solos al tocar otros.';
  }
  private doSnap(e: PE) { this.snap = snapPoint(e.w, this.ed.view.zoom, { from: this.start || undefined, ortho: e.shift, free: e.alt, verts: true, axes: true }); }
  move(e: PE) { this.doSnap(e); }
  /** grosor del muro del calco sobre el que se empezó a dibujar, si lo hay */
  private refT: number | null = null;
  private commit(p: Pt, finish: boolean) {
    const st = store.project.settings;
    if (!this.start || dist(this.start, p) < 0.01) return;
    store.checkpoint();
    addWall(store.level, this.start, p, (this.snap?.kind === 'refaxis' ? this.snap.t : null) ?? this.refT ?? st.wallThickness, st.wallHeight);
    store.touch();
    this.refT = this.snap?.kind === 'refaxis' ? this.snap.t ?? null : null;
    this.count++;
    this.start = finish ? null : p;
    if (finish) this.count = 0;
    this.typed.clear();
    this.ed.refreshHint();
  }
  down(e: PE) {
    this.doSnap(e);
    const s = this.snap!;
    if (!this.start) { this.start = s.p; this.refT = s.kind === 'refaxis' ? s.t ?? null : null; this.count = 0; this.ed.refreshHint(); return; }
    // al cerrar contra un punto o muro existente, la cadena termina sola
    this.commit(s.p, s.kind === 'node' || s.kind === 'wall');
    if (this.ed.last) this.doSnap(this.ed.last);
  }
  dbl() { this.start = null; this.typed.clear(); this.ed.refreshHint(); }
  key(ev: KeyboardEvent) {
    if (!this.start) return false;
    if (this.typed.handle(ev)) return true;
    if (ev.key === 'Enter') {
      const len = parseLen(this.typed.text, store.project.units);
      if (len && len > 0 && this.snap) {
        const d = unit(sub(this.snap.p, this.start));
        this.commit(add(this.start, mul(d, len)), false);
        if (this.ed.last) this.doSnap(this.ed.last);
      } else { this.start = null; this.typed.clear(); this.ed.refreshHint(); }
      return true;
    }
    return false;
  }
  cancel() {
    if (this.typed.text) { this.typed.clear(); return true; }
    if (this.start) { this.start = null; this.ed.refreshHint(); return true; }
    return false;
  }
  leave() { this.start = null; this.typed.clear(); this.snap = null; }
  overlay(ctx: CanvasRenderingContext2D) {
    const ed = this.ed, v = ed.view, st = store.project.settings;
    if (this.start && this.snap) {
      const a = v.toScreen(this.start), b = v.toScreen(this.snap.p);
      ctx.save();
      ctx.strokeStyle = 'rgba(31,111,235,0.45)'; ctx.lineWidth = Math.max(2, st.wallThickness * v.zoom); ctx.lineCap = 'butt';
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.strokeStyle = ACCENT; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.restore();
      const L = dist(this.start, this.snap.p);
      if (L > 0.01) {
        const ang = Math.abs(deg(Math.atan2(-(this.snap.p.y - this.start.y), this.snap.p.x - this.start.x)));
        const txt = this.typed.text ? `${this.typed.text} ${unitSuffix(store.project.units)} ⏎` : `${fmtLen(L, store.project.units, true)}  ·  ${Math.round(ang > 180 ? 360 - ang : ang)}°`;
        ed.lengthPill(ctx, this.start, this.snap.p, txt, this.typed.text ? '#0f9d58' : ACCENT);
      }
    }
    ed.drawSnap(ctx, this.snap);
  }
}

class RoomTool implements Tool {
  id = 'room';
  private a: Pt | null = null;
  private b: Pt | null = null;
  private startS: Pt | null = null;
  private dragging = false;
  private snap: Snap | null = null;
  private typed = new Typed();
  private refT: number | null = null;
  constructor(private ed: Editor) {}
  hint() {
    return this.a ? 'Mueve y haz clic en la esquina opuesta · o escribe ancho x largo (ej. 4x3) y Enter'
      : 'Arrastra o haz clic en dos esquinas para crear una habitación rectangular completa';
  }
  down(e: PE) {
    this.snap = snapPoint(e.w, this.ed.view.zoom, { free: e.alt, verts: true, axes: true });
    if (!this.a) { this.a = this.snap.p; this.b = this.snap.p; this.refT = this.snap.kind === 'refaxis' ? this.snap.t ?? null : null; this.startS = e.s; this.dragging = true; this.ed.refreshHint(); }
    else { this.b = this.snap.p; this.commit(); }
  }
  move(e: PE) {
    this.snap = snapPoint(e.w, this.ed.view.zoom, { free: e.alt, verts: true, axes: true });
    if (this.a) this.b = this.snap.p;
  }
  up(e: PE) {
    if (this.a && this.dragging && this.startS && dist(this.startS, e.s) > 6) this.commit();
    this.dragging = false;
  }
  private commit() {
    const a = this.a, b = this.b, st = store.project.settings;
    this.a = this.b = null; this.typed.clear(); this.dragging = false;
    this.ed.refreshHint();
    if (!a || !b || Math.abs(a.x - b.x) < 0.1 || Math.abs(a.y - b.y) < 0.1) return;
    const lv = store.level;
    store.checkpoint();
    const c = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
    // si se calcó sobre un muro del dibujo importado, se copia también su grosor
    const t = this.refT ?? (this.snap?.kind === 'refaxis' ? this.snap.t : null) ?? st.wallThickness;
    this.refT = null;
    for (let i = 0; i < 4; i++) addWall(lv, c[i], c[(i + 1) % 4], t, st.wallHeight);
    store.touch();
  }
  key(ev: KeyboardEvent) {
    if (!this.a) return false;
    if (this.typed.handle(ev, true)) return true;
    if (ev.key === 'Enter' && this.typed.text && this.b) {
      const parts = this.typed.text.split(/[x* ]+/i).filter(Boolean).map(s => parseLen(s, store.project.units));
      const w = parts[0], h = parts[1] ?? parts[0];
      if (w && h) {
        const sx = this.b.x >= this.a.x ? 1 : -1, sy = this.b.y >= this.a.y ? 1 : -1;
        this.b = { x: this.a.x + sx * w, y: this.a.y + sy * h };
        this.commit();
      }
      return true;
    }
    return false;
  }
  cancel() {
    if (this.typed.text) { this.typed.clear(); return true; }
    if (this.a) { this.a = this.b = null; this.ed.refreshHint(); return true; }
    return false;
  }
  leave() { this.a = this.b = null; this.typed.clear(); this.snap = null; }
  overlay(ctx: CanvasRenderingContext2D) {
    const ed = this.ed, u = store.project.units;
    if (this.a && this.b) {
      const a = this.a, b = this.b;
      const c = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
      ctx.save();
      ctx.fillStyle = 'rgba(31,111,235,0.10)'; ctx.strokeStyle = ACCENT; ctx.lineWidth = 2;
      ed.poly(ctx, c); ctx.fill(); ctx.stroke();
      ctx.restore();
      const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
      if (w > 0.05 && h > 0.05) {
        if (this.typed.text) { const m = ed.view.toScreen(mid(a, b)); pill(ctx, m.x, m.y, `${this.typed.text} ${unitSuffix(u)} ⏎`, '#0f9d58'); }
        else {
          ed.lengthPill(ctx, c[0], c[1]); ed.lengthPill(ctx, c[1], c[2]);
          const m = ed.view.toScreen(mid(a, b));
          pill(ctx, m.x, m.y, fmtArea(w * h, u), '#475569');
        }
      }
    }
    ed.drawSnap(ctx, this.snap);
  }
}

class OpeningTool implements Tool {
  private ghost: Opening | null = null;
  constructor(private ed: Editor, public id: OpeningKind) {}
  hint() {
    const n = this.id === 'door' ? 'la puerta' : this.id === 'window' ? 'la ventana' : 'el vano';
    return `Acerca el cursor a un muro y haz clic para colocar ${n} · El lado del cursor define hacia dónde abre`;
  }
  private template(): Opening {
    const d = OPENING_DEFAULTS[this.id];
    const sel = store.selection.length === 1 && store.selection[0].type === 'opening' ? store.level.openings.find(o => o.id === store.selection[0].id) : null;
    const base = sel && sel.kind === this.id ? sel : null;
    return { id: 'ghost', wall: '', t: 0.5, width: base?.width ?? d.width, kind: this.id, style: base?.style ?? d.style, flipH: base?.flipH ?? false, flipV: false, height: base?.height ?? d.height, sill: base?.sill ?? d.sill };
  }
  move(e: PE) {
    const o = this.template();
    this.ghost = placeOpening(o, e, this.ed) ? o : null;
  }
  down(e: PE) {
    this.move(e);
    if (!this.ghost) { this.ed.toast('Acerca el cursor a un muro para colocarla'); return; }
    const o = { ...this.ghost, id: uid('o') };
    store.checkpoint();
    store.level.openings.push(o);
    store.touch();
    store.select([{ type: 'opening', id: o.id }]);
    this.ghost = null;
  }
  leave() { this.ghost = null; }
  overlay(ctx: CanvasRenderingContext2D) {
    const o = this.ghost, ed = this.ed, v = ed.view;
    if (!o) return;
    const f = openingFrames({ ...store.level, openings: [o] }, store.derived().geoms)[0];
    if (!f) return;
    const n = mul(f.g.nrm, f.thick / 2);
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.strokeStyle = ACCENT; ctx.lineWidth = 2;
    ed.poly(ctx, [add(f.p0, n), add(f.p1, n), sub(f.p1, n), sub(f.p0, n)]); ctx.fill(); ctx.stroke();
    if (o.kind === 'door' && o.style !== 'sliding') {
      const sv = o.flipV ? -1 : 1, W = f.width;
      const leafs: [Pt, number, number][] = o.style === 'double' ? [[f.p0, W / 2, 1], [f.p1, W / 2, -1]] : o.flipH ? [[f.p1, W, -1]] : [[f.p0, W, 1]];
      for (const [h0, lw, dir] of leafs) {
        const H = add(h0, mul(f.g.nrm, (sv * f.thick) / 2)), tip = add(H, mul(f.g.nrm, sv * lw)), close = add(H, mul(f.g.dir, dir * lw));
        const sH = v.toScreen(H), sT = v.toScreen(tip);
        ctx.beginPath(); ctx.moveTo(sH.x, sH.y); ctx.lineTo(sT.x, sT.y); ctx.stroke();
        const a0 = Math.atan2(tip.y - H.y, tip.x - H.x), a1 = Math.atan2(close.y - H.y, close.x - H.x);
        let da = a1 - a0; while (da > Math.PI) da -= Math.PI * 2; while (da < -Math.PI) da += Math.PI * 2;
        ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(sH.x, sH.y, lw * v.zoom, a0, a1, da < 0); ctx.stroke(); ctx.lineWidth = 2;
      }
    }
    ctx.restore();
    openingDistances(ctx, ed, o);
  }
}

class DimTool implements Tool {
  id = 'dim';
  private p1: Pt | null = null;
  private p2: Pt | null = null;
  private off = 0;
  private snap: Snap | null = null;
  constructor(private ed: Editor) {}
  hint() {
    return !this.p1 ? 'Cota: haz clic en el primer punto a medir (se ajusta a esquinas y puntos)'
      : !this.p2 ? 'Haz clic en el segundo punto' : 'Mueve para separar la línea de cota y haz clic para fijarla';
  }
  move(e: PE) {
    if (this.p1 && this.p2) {
      const n = perp(unit(sub(this.p2, this.p1)));
      this.off = (e.w.x - this.p1.x) * n.x + (e.w.y - this.p1.y) * n.y;
      this.snap = null;
    } else this.snap = snapPoint(e.w, this.ed.view.zoom, { corners: true, verts: true, from: this.p1 || undefined, ortho: e.shift, free: e.alt });
  }
  down(e: PE) {
    this.move(e);
    if (!this.p1) this.p1 = this.snap!.p;
    else if (!this.p2) { if (dist(this.p1, this.snap!.p) > 0.01) { this.p2 = this.snap!.p; this.off = 0; } }
    else {
      const d: Dim = { id: uid('d'), x1: this.p1.x, y1: this.p1.y, x2: this.p2.x, y2: this.p2.y, offset: this.off };
      store.checkpoint();
      store.level.dims.push(d);
      store.touch();
      this.p1 = this.p2 = null;
    }
    this.ed.refreshHint();
  }
  cancel() { if (this.p1) { this.p1 = this.p2 = null; this.ed.refreshHint(); return true; } return false; }
  leave() { this.p1 = this.p2 = null; this.snap = null; }
  overlay(ctx: CanvasRenderingContext2D) {
    const ed = this.ed, v = ed.view;
    if (this.p1 && (this.p2 || this.snap)) {
      const p2 = this.p2 || this.snap!.p;
      const prims: Prim[] = [];
      dimPrims(prims, this.p1, p2, this.p2 ? this.off : 0, fmtLen(dist(this.p1, p2), store.project.units), ed.annot(), { ...ed.theme(), dim: ACCENT, text: ACCENT });
      drawPrims(ctx, prims, v.zoom, v.ox, v.oy);
    }
    ed.drawSnap(ctx, this.snap);
  }
}

class MeasureTool implements Tool {
  id = 'measure';
  private p1: Pt | null = null;
  private p2: Pt | null = null;
  private fixed = false;
  private snap: Snap | null = null;
  constructor(private ed: Editor) {}
  hint() { return this.p1 && !this.fixed ? 'Haz clic en el segundo punto' : 'Medir: haz clic en dos puntos para ver la distancia (no se guarda en el plano)'; }
  move(e: PE) {
    this.snap = snapPoint(e.w, this.ed.view.zoom, { corners: true, verts: true, from: this.p1 && !this.fixed ? this.p1 : undefined, ortho: e.shift, free: e.alt });
    if (this.p1 && !this.fixed) this.p2 = this.snap.p;
  }
  down(e: PE) {
    this.move(e);
    if (!this.p1 || this.fixed) { this.p1 = this.snap!.p; this.p2 = null; this.fixed = false; }
    else { this.p2 = this.snap!.p; this.fixed = true; }
    this.ed.refreshHint();
  }
  cancel() { if (this.p1) { this.p1 = this.p2 = null; this.fixed = false; this.ed.refreshHint(); return true; } return false; }
  leave() { this.p1 = this.p2 = null; this.fixed = false; this.snap = null; }
  overlay(ctx: CanvasRenderingContext2D) {
    const ed = this.ed, v = ed.view, u = store.project.units;
    if (this.p1 && this.p2) {
      const a = v.toScreen(this.p1), b = v.toScreen(this.p2);
      ctx.save();
      ctx.strokeStyle = '#e5484d'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([]); ctx.fillStyle = '#e5484d';
      for (const p of [a, b]) { ctx.beginPath(); ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
      const dx = Math.abs(this.p2.x - this.p1.x), dy = Math.abs(this.p2.y - this.p1.y);
      const extra = dx > 0.005 && dy > 0.005 ? `   (↔ ${fmtLen(dx, u)}  ↕ ${fmtLen(dy, u)})` : '';
      ed.lengthPill(ctx, this.p1, this.p2, fmtLen(dist(this.p1, this.p2), u, true) + extra, '#e5484d');
    }
    if (!this.fixed) ed.drawSnap(ctx, this.snap);
  }
}

class TextTool implements Tool {
  id = 'text';
  constructor(private ed: Editor) {}
  hint() { return 'Haz clic donde quieres poner el texto'; }
  down(e: PE) {
    const l: Label = { id: uid('t'), x: e.w.x, y: e.w.y, text: 'Texto', size: 3.5, rot: 0 };
    store.checkpoint();
    store.level.labels.push(l);
    store.touch();
    store.setTool('select');
    store.select([{ type: 'label', id: l.id }]);
    this.ed.onFocusField('text');
  }
}

class LineTool implements Tool {
  id = 'line';
  private pts: Pt[] = [];
  private snap: Snap | null = null;
  private typed = new Typed();
  constructor(private ed: Editor) {}
  hint() {
    return this.pts.length ? 'Clic para el siguiente punto · medida + Enter para largo exacto · Enter o doble clic para terminar · clic en el inicio para cerrar'
      : 'Línea libre: haz clic para empezar (deslindes, terrenos, ejes, detalles)';
  }
  private doSnap(e: PE) { this.snap = snapPoint(e.w, this.ed.view.zoom, { from: this.pts[this.pts.length - 1], ortho: e.shift, free: e.alt, corners: true, verts: true }); }
  move(e: PE) { this.doSnap(e); }
  down(e: PE) {
    this.doSnap(e);
    const p = this.snap!.p;
    if (this.pts.length >= 3 && dist(this.ed.view.toScreen(p), this.ed.view.toScreen(this.pts[0])) < 10) { this.finish(true); return; }
    if (!this.pts.length || dist(p, this.pts[this.pts.length - 1]) > 0.005) this.pts.push(p);
    this.ed.refreshHint();
  }
  dbl() { this.finish(false); }
  private finish(closed: boolean) {
    const pts = this.pts;
    this.pts = []; this.typed.clear();
    this.ed.refreshHint();
    if (pts.length < 2) return;
    const s: Shape = { id: uid('s'), kind: 'poly', pts: pts.flatMap(p => [p.x, p.y]), closed, layer: 'LINEAS' };
    store.checkpoint();
    store.level.shapes.push(s);
    store.touch();
    store.select([{ type: 'shape', id: s.id }]);
  }
  key(ev: KeyboardEvent) {
    if (!this.pts.length) return false;
    if (this.typed.handle(ev)) return true;
    if (ev.key === 'Enter') {
      const len = parseLen(this.typed.text, store.project.units);
      if (len && len > 0 && this.snap) {
        const last = this.pts[this.pts.length - 1];
        this.pts.push(add(last, mul(unit(sub(this.snap.p, last)), len)));
        this.typed.clear();
      } else this.finish(false);
      return true;
    }
    return false;
  }
  cancel() {
    if (this.typed.text) { this.typed.clear(); return true; }
    if (this.pts.length) { this.finish(false); return true; }
    return false;
  }
  leave() { this.pts = []; this.typed.clear(); this.snap = null; }
  overlay(ctx: CanvasRenderingContext2D) {
    const ed = this.ed;
    if (this.pts.length) {
      const all = this.snap ? [...this.pts, this.snap.p] : this.pts;
      ctx.save(); ctx.strokeStyle = ACCENT; ctx.lineWidth = 1.5;
      ed.poly(ctx, all, false); ctx.stroke(); ctx.restore();
      if (this.snap) {
        const last = this.pts[this.pts.length - 1];
        ed.lengthPill(ctx, last, this.snap.p, this.typed.text ? `${this.typed.text} ${unitSuffix(store.project.units)} ⏎` : undefined, this.typed.text ? '#0f9d58' : ACCENT);
      }
    }
    ed.drawSnap(ctx, this.snap);
  }
}

class PlaceTool implements Tool {
  id = 'place';
  private ghost: Item | null = null;
  private extraRot = 0;
  constructor(private ed: Editor) {}
  hint() { return 'Haz clic para colocar · R gira 90° · cerca de un muro se apoya solo contra él · Esc para terminar'; }
  move(e: PE) {
    const type = store.placing;
    if (!type) { this.ghost = null; return; }
    const def = symbolDef(type), st = store.project.settings, lv = store.level;
    const it: Item = { id: 'ghost', type, x: e.w.x, y: e.w.y, w: def.w, h: def.h, rot: this.extraRot };
    let stuck = false;
    if (!e.alt && def.z > 0.05 && type !== 'rug') {
      const nw = nearestWall(lv, e.w, Math.max(def.h, 0.6) * 0.75 + 0.2);
      const g = nw && store.derived().geoms.get(nw.id);
      if (nw && g) {
        // el respaldo (borde superior del símbolo) queda contra la cara del muro
        const side = (e.w.x - nw.proj.x) * g.nrm.x + (e.w.y - nw.proj.y) * g.nrm.y >= 0 ? 1 : -1;
        const n = mul(g.nrm, side);
        const base = deg(Math.atan2(n.y, n.x)) - 90 + this.extraRot;
        const depth = Math.abs(this.extraRot % 180) === 90 ? def.w : def.h;
        const along = Math.abs(this.extraRot % 180) === 90 ? def.h : def.w;
        let s = nw.t * g.len;
        if (st.snapGrid) s = Math.round(s / st.gridStep) * st.gridStep;
        // junto a una esquina, se ajusta al rincón
        const lim = along / 2 + g.wall.thickness / 2;
        if (s < lim + 0.25) s = Math.min(lim, g.len / 2); else if (s > g.len - lim - 0.25) s = Math.max(g.len - lim, g.len / 2);
        const c = add(add(g.a, mul(g.dir, s)), mul(n, g.wall.thickness / 2 + depth / 2));
        it.x = c.x; it.y = c.y; it.rot = ((base % 360) + 360) % 360;
        stuck = true;
      }
    }
    if (!stuck && !e.alt && st.snapGrid) { it.x = Math.round(it.x / st.gridStep) * st.gridStep; it.y = Math.round(it.y / st.gridStep) * st.gridStep; }
    this.ghost = it;
  }
  down(e: PE) {
    this.move(e);
    if (!this.ghost) return;
    const it = { ...this.ghost, id: uid('i') };
    store.checkpoint();
    store.level.items.push(it);
    store.touch();
    if (!e.shift) { store.setTool('select'); store.select([{ type: 'item', id: it.id }]); }
  }
  key(ev: KeyboardEvent) {
    if (ev.key.toLowerCase() === 'r') { this.extraRot = (this.extraRot + (ev.shiftKey ? 270 : 90)) % 360; if (this.ed.last) this.move(this.ed.last); return true; }
    return false;
  }
  leave() { this.ghost = null; this.extraRot = 0; }
  overlay(ctx: CanvasRenderingContext2D) {
    if (!this.ghost) return;
    const v = this.ed.view;
    ctx.save(); ctx.globalAlpha = 0.75;
    drawPrims(ctx, itemPrims(this.ghost, { ...this.ed.theme(), furnStroke: ACCENT }), v.zoom, v.ox, v.oy);
    ctx.restore();
  }
}

class CalibrateTool implements Tool {
  id = 'calibrate';
  private p1: Pt | null = null;
  private cur: Pt | null = null;
  constructor(private ed: Editor) {}
  hint() { return this.p1 ? 'Ahora haz clic en el otro extremo de esa medida conocida' : 'Calibrar: haz clic en un extremo de una medida que conozcas en la imagen (por ejemplo, el ancho de una puerta o un muro acotado)'; }
  move(e: PE) { this.cur = e.w; }
  async down(e: PE) {
    if (!this.p1) { this.p1 = e.w; this.ed.refreshHint(); return; }
    const p1 = this.p1, p2 = e.w, bg = store.level.background;
    this.p1 = null; this.cur = null;
    const measured = dist(p1, p2);
    if (!bg || measured < 1e-6) { store.setTool('select'); return; }
    const u = store.project.units;
    const txt = await this.ed.askText('¿Cuánto mide en la realidad?', '', `Escribe la distancia real entre los dos puntos (en ${unitSuffix(u)}). Ej.: ${u === 'm' ? '3,50' : u === 'cm' ? '350' : u === 'mm' ? '3500' : `11' 6"`}`);
    const real = txt ? parseLen(txt, u) : null;
    if (real && real > 0) {
      const f = real / measured;
      store.checkpoint();
      bg.x = p1.x + (bg.x - p1.x) * f; bg.y = p1.y + (bg.y - p1.y) * f;
      bg.w *= f; bg.h *= f;
      store.touch();
      this.ed.toast('Imagen calibrada. Ya puedes calcar los muros encima.');
      store.setTool('select');
      this.ed.onCalibrated();
      return;
    }
    store.setTool('select');
  }
  cancel() { if (this.p1) { this.p1 = null; this.ed.refreshHint(); return true; } return false; }
  leave() { this.p1 = null; this.cur = null; }
  overlay(ctx: CanvasRenderingContext2D) {
    if (!this.p1 || !this.cur) return;
    const v = this.ed.view, a = v.toScreen(this.p1), b = v.toScreen(this.cur);
    ctx.save(); ctx.strokeStyle = '#e5484d'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.restore();
  }
}

class HandTool implements Tool {
  id = 'hand'; cursor = 'grab';
  constructor(_ed: Editor) {}
  hint() { return 'Arrastra para mover la vista · rueda del ratón para acercar o alejar'; }
}

