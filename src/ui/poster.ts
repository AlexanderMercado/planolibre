// Diálogo "Imprimir en varias hojas": vista previa con la cuadrícula de páginas,
// donde se elige el tamaño (escala o número de hojas), la zona del plano y la
// posición del dibujo respecto de los cortes (arrastrándolo).

import type { Project } from '../core/model';
import type { Prim } from '../core/scene';
import { THEMES } from '../core/themes';
import { fmtLen } from '../core/units';
import { drawPrims } from '../editor/view';
import { PAPERS, SCALES, sceneFor } from '../io/pdf';
import { centerOffset, fitPosterScale, fmtScale, posterLayout, primsRect, type PosterOpts, type Rect } from '../io/poster';
import { h, icon, modal } from './dom';

const opt = (v: string, l: string, sel = false) => h('option', { value: v, selected: sel }, l);
const field = (label: string, ...control: Node[]) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), ...control);

export async function posterDialog(project: Project, viewTheme: 'tech' | 'color' | 'blue', viewRect: Rect | null): Promise<PosterOpts | null> {
  const level = project.levels[project.activeLevel];
  const saved = (() => { try { return JSON.parse(localStorage.getItem('planolibre:poster') || '{}'); } catch { return {}; } })();
  const o: PosterOpts = {
    paper: 'A4', landscape: true, margin: 10, overlap: 10, skipEmpty: true, marks: true, index: true, ...saved,
    scale: project.scale, region: null, offsetX: 0, offsetY: 0, theme: viewTheme,
  };
  if (!PAPERS[o.paper]) o.paper = 'A4';
  let centered = true;                 // mientras no se mueva a mano, el dibujo va centrado
  let picking = false;                 // modo "marcar sección"
  let prims: Prim[] = [], primsKey = '';
  const scene = () => {
    const key = o.scale + '|' + o.theme;
    if (key !== primsKey) { prims = sceneFor(project, level, THEMES[o.theme], o.scale); primsKey = key; }
    return prims;
  };

  // ───────── vista previa ─────────
  const CW = 560, CH = 430, dpr = Math.min(2, window.devicePixelRatio || 1);
  const canvas = h('canvas', { class: 'poster-canvas', width: String(CW * dpr), height: String(CH * dpr) });
  const ctx = canvas.getContext('2d')!;
  const note = h('div', { class: 'note' });
  const tip = h('p', { class: 'muted poster-tip' });
  // transformación mundo → vista previa; se congela mientras se arrastra para que no "salte"
  let tf = { z: 1, ox: 0, oy: 0 };
  let drag: { x: number; y: number; offX: number; offY: number; rect?: Rect } | null = null;

  const layout = () => {
    scene();
    if (centered) Object.assign(o, centerOffset(prims, o));
    return posterLayout(prims, o);
  };
  const gridRect = (L: ReturnType<typeof posterLayout>): Rect => {
    const x = L.content.minX - o.offsetX / L.k, y = L.content.minY - o.offsetY / L.k, ov = L.printW - L.stepX;
    return { minX: x, minY: y, maxX: x + (L.cols * L.stepX + ov) / L.k, maxY: y + (L.rows * L.stepY + ov) / L.k };
  };

  function draw() {
    const L = layout(), g = gridRect(L), all = primsRect(prims) || L.content;
    if (!drag) {
      const b = { minX: Math.min(g.minX, all.minX), minY: Math.min(g.minY, all.minY), maxX: Math.max(g.maxX, all.maxX), maxY: Math.max(g.maxY, all.maxY) };
      const z = Math.min((CW - 36) / Math.max(1e-6, b.maxX - b.minX), (CH - 36) / Math.max(1e-6, b.maxY - b.minY));
      tf = { z, ox: CW / 2 - ((b.minX + b.maxX) / 2) * z, oy: CH / 2 - ((b.minY + b.maxY) / 2) * z };
    }
    const { z, ox, oy } = tf;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#eef0f3'; ctx.fillRect(0, 0, CW, CH);
    const sx = (x: number) => x * z + ox, sy = (y: number) => y * z + oy;
    // hojas (papel blanco)
    ctx.fillStyle = '#ffffff';
    for (const t of L.tiles) if (!(o.skipEmpty && t.empty)) ctx.fillRect(sx(g.minX + (t.col * L.stepX) / L.k), sy(g.minY + (t.row * L.stepY) / L.k), (L.printW / L.k) * z, (L.printH / L.k) * z);
    // el dibujo; lo que queda fuera de la sección elegida se ve atenuado
    ctx.save();
    drawPrims(ctx, prims.filter(p => p.k !== 'text' || p.h * z >= 5), z, ox, oy, Math.max(0.6, (z * o.scale) / 1000));
    ctx.restore();
    if (o.region) {
      const r = o.region;
      ctx.fillStyle = 'rgba(238,240,243,0.78)';
      ctx.beginPath(); ctx.rect(0, 0, CW, CH); ctx.rect(sx(r.minX), sy(r.minY), (r.maxX - r.minX) * z, (r.maxY - r.minY) * z); ctx.fill('evenodd');
      ctx.strokeStyle = '#0f9d58'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 3]);
      ctx.strokeRect(sx(r.minX), sy(r.minY), (r.maxX - r.minX) * z, (r.maxY - r.minY) * z);
      ctx.setLineDash([]);
    }
    // cuadrícula de hojas con su código
    const ovW = ((L.printW - L.stepX) / L.k) * z;
    for (const t of L.tiles) {
      const x = sx(g.minX + (t.col * L.stepX) / L.k), y = sy(g.minY + (t.row * L.stepY) / L.k), w = (L.printW / L.k) * z, hh = (L.printH / L.k) * z;
      const skipped = o.skipEmpty && t.empty;
      if (!skipped && ovW > 1.5) {
        ctx.fillStyle = 'rgba(31,111,235,0.10)';
        if (t.col < L.cols - 1) ctx.fillRect(x + w - ovW, y, ovW, hh);
        if (t.row < L.rows - 1) ctx.fillRect(x, y + hh - ovW, w, ovW);
      }
      ctx.strokeStyle = skipped ? '#b6bcc6' : '#1f6feb'; ctx.lineWidth = skipped ? 1 : 1.5; ctx.setLineDash(skipped ? [4, 4] : []);
      ctx.strokeRect(x, y, w, hh);
      ctx.setLineDash([]);
      const fs = Math.max(9, Math.min(18, Math.min(w, hh) * 0.22));
      ctx.font = `700 ${fs}px system-ui, sans-serif`; ctx.fillStyle = skipped ? '#9aa1ac' : '#1f6feb'; ctx.textBaseline = 'top';
      if (w > 18 && hh > 14) ctx.fillText(t.label, x + 4, y + 3);
    }
    if (drag?.rect) {
      const r = drag.rect;
      ctx.fillStyle = 'rgba(15,157,88,0.14)'; ctx.strokeStyle = '#0f9d58'; ctx.lineWidth = 1.5;
      ctx.fillRect(sx(r.minX), sy(r.minY), (r.maxX - r.minX) * z, (r.maxY - r.minY) * z);
      ctx.strokeRect(sx(r.minX), sy(r.minY), (r.maxX - r.minX) * z, (r.maxY - r.minY) * z);
    }
    // resumen
    const wc = (L.content.maxX - L.content.minX) * L.k, hc = (L.content.maxY - L.content.minY) * L.k;
    const skippedN = L.tiles.length - L.count;
    const many = L.count > 60;
    note.className = 'note ' + (many ? 'note-warn' : 'note-ok');
    note.replaceChildren(
      h('strong', null, `${L.count} hoja${L.count === 1 ? '' : 's'} ${o.paper} ${o.landscape ? 'horizontal' : 'vertical'}`),
      ` (${L.rows} fila${L.rows === 1 ? '' : 's'} × ${L.cols} columna${L.cols === 1 ? '' : 's'}${skippedN > 0 && o.skipEmpty ? `, se omiten ${skippedN} vacía${skippedN === 1 ? '' : 's'}` : ''}) a escala 1:${fmtScale(o.scale)}. `,
      `El dibujo mide ${(Math.round(wc) / 10).toLocaleString('es')} × ${(Math.round(hc) / 10).toLocaleString('es')} cm en papel${o.region ? ' (sólo la sección marcada)' : ''}. `,
      many ? 'Son muchas hojas: prueba una escala más chica, una hoja más grande o imprime sólo una sección.' : 'Imprime al 100 %, sin "ajustar a la página".');
    tip.textContent = picking ? 'Arrastra un rectángulo sobre la vista previa para marcar la sección que quieres imprimir.' : 'Arrastra el dibujo para moverlo respecto de los cortes de hoja. Las franjas azules se repiten en la hoja vecina.';
    canvas.style.cursor = picking ? 'crosshair' : drag ? 'grabbing' : 'grab';
    syncInputs();
  }

  const pos = (e: PointerEvent) => { const r = canvas.getBoundingClientRect(); return { x: ((e.clientX - r.left) * CW) / r.width, y: ((e.clientY - r.top) * CH) / r.height }; };
  canvas.addEventListener('pointerdown', e => {
    const p = pos(e);
    canvas.setPointerCapture(e.pointerId);
    drag = { x: p.x, y: p.y, offX: o.offsetX, offY: o.offsetY };
    if (picking) { const wx = (p.x - tf.ox) / tf.z, wy = (p.y - tf.oy) / tf.z; drag.rect = { minX: wx, minY: wy, maxX: wx, maxY: wy }; }
    draw();
  });
  canvas.addEventListener('pointermove', e => {
    if (!drag) return;
    const p = pos(e);
    if (drag.rect) {
      const ax = (drag.x - tf.ox) / tf.z, ay = (drag.y - tf.oy) / tf.z, bx = (p.x - tf.ox) / tf.z, by = (p.y - tf.oy) / tf.z;
      drag.rect = { minX: Math.min(ax, bx), minY: Math.min(ay, by), maxX: Math.max(ax, bx), maxY: Math.max(ay, by) };
    } else {
      const k = 1000 / o.scale;
      centered = false;
      o.offsetX = Math.max(0, Math.round(drag.offX + ((p.x - drag.x) / tf.z) * k));
      o.offsetY = Math.max(0, Math.round(drag.offY + ((p.y - drag.y) / tf.z) * k));
    }
    draw();
  });
  const endDrag = () => {
    if (!drag) return;
    const r = drag.rect;
    drag = null;
    if (r) {
      if (r.maxX - r.minX > 0.05 && r.maxY - r.minY > 0.05) { o.region = r; centered = true; }
      picking = false;
    }
    draw();
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // ───────── controles ─────────
  const num = (value: number, min: number, max: number, on: (v: number) => void, step = '1') => {
    const i = h('input', { class: 'input', type: 'number', min: String(min), max: String(max), step, value: String(value), onchange: () => { const v = parseFloat(i.value.replace(',', '.')); if (Number.isFinite(v)) on(Math.max(min, Math.min(max, v))); draw(); } });
    return i;
  };
  const sel = (options: Node[], on: (v: string) => void) => { const s = h('select', { class: 'input', onchange: () => { on(s.value); draw(); } }, options); return s; };
  const chk = (label: string, key: 'skipEmpty' | 'marks' | 'index') => { const i = h('input', { type: 'checkbox', checked: o[key], onchange: () => { o[key] = i.checked; draw(); } }); return h('label', { class: 'check' }, i, h('span', null, label)); };
  const mini = (label: string, ic: string | null, on: () => void) => h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { on(); draw(); } }, ic ? icon(ic, 14) : null, label);

  const scaleInp = num(o.scale, 1, 5000, v => { o.scale = v; }, 'any');
  const scaleSel = sel([opt('', 'Escalas comunes…', true), ...SCALES.filter(s => s <= 1000).map(s => opt(String(s), `1:${s}`))], v => { if (v) o.scale = parseFloat(v); scaleSel.value = ''; });
  const fitC = h('input', { class: 'input', type: 'number', min: '1', max: '30', value: '2' }), fitR = h('input', { class: 'input', type: 'number', min: '1', max: '30', value: '2' });
  const fit = () => {
    const c = Math.max(1, Math.min(30, parseInt(fitC.value, 10) || 1)), r = Math.max(1, Math.min(30, parseInt(fitR.value, 10) || 1));
    centered = true;
    // el tamaño de cotas y textos depende de la escala, así que se afina en un par de pasadas
    for (let i = 0; i < 4; i++) {
      const L = posterLayout(scene(), { ...o, offsetX: 0, offsetY: 0 });
      if (i > 0 && L.cols <= c && L.rows <= r) break;
      o.scale = i < 3 ? fitPosterScale(L.content, o, c, r) : Math.ceil(o.scale * 1.03 * 10) / 10;
    }
  };
  const offX = num(0, 0, 100000, v => { o.offsetX = v; centered = false; }), offY = num(0, 0, 100000, v => { o.offsetY = v; centered = false; });
  const regionInfo = h('span', { class: 'muted' });
  const pickBtn = h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { picking = !picking; draw(); } }, icon('select', 14), 'Marcar sección');
  function syncInputs() {
    if (document.activeElement !== scaleInp) scaleInp.value = String(Math.round(o.scale * 10) / 10);
    if (document.activeElement !== offX) offX.value = String(Math.round(o.offsetX));
    if (document.activeElement !== offY) offY.value = String(Math.round(o.offsetY));
    pickBtn.classList.toggle('btn-primary', picking);
    regionInfo.textContent = o.region ? `Sección de ${fmtLen(o.region.maxX - o.region.minX, 'm', true)} × ${fmtLen(o.region.maxY - o.region.minY, 'm', true)}` : 'Todo el plano';
  }

  const form = h('div', { class: 'stack poster-form' },
    h('div', { class: 'form-grid' },
      field('Hoja', sel(Object.keys(PAPERS).map(p => opt(p, p, p === o.paper)), v => { o.paper = v; })),
      field('Orientación', sel([opt('h', 'Horizontal', o.landscape), opt('v', 'Vertical', !o.landscape)], v => { o.landscape = v === 'h'; }))),
    h('div', { class: 'poster-group' },
      h('span', { class: 'field-label' }, 'Tamaño del dibujo'),
      h('div', { class: 'poster-row' }, h('span', null, 'Escala 1:'), scaleInp, scaleSel),
      h('div', { class: 'poster-row' }, h('span', null, 'o en'), fitC, h('span', null, '×'), fitR, h('span', null, 'hojas'), mini('Ajustar', 'fit', fit)),
      h('p', { class: 'muted' }, 'Hojas a lo ancho × a lo alto. Un número de escala menor da un dibujo más grande y más hojas.')),
    h('div', { class: 'poster-group' },
      h('span', { class: 'field-label' }, 'Qué imprimir'),
      h('div', { class: 'btn-row' },
        mini('Todo el plano', null, () => { o.region = null; centered = true; picking = false; }),
        viewRect ? mini('Lo que se ve en pantalla', null, () => { o.region = { ...viewRect }; centered = true; picking = false; }) : null,
        pickBtn),
      regionInfo),
    h('div', { class: 'poster-group' },
      h('span', { class: 'field-label' }, 'Posición en las hojas'),
      h('div', { class: 'poster-row' }, h('span', null, 'Izquierda'), offX, h('span', null, 'Arriba'), offY, h('span', null, 'mm')),
      h('div', { class: 'btn-row' }, mini('Centrar', null, () => { centered = true; }), mini('Pegar arriba a la izquierda', null, () => { centered = false; o.offsetX = 0; o.offsetY = 0; }))),
    h('div', { class: 'form-grid' },
      field('Margen de la hoja (mm)', num(o.margin, 0, 40, v => { o.margin = v; })),
      field('Traslape entre hojas (mm)', num(o.overlap, 0, 60, v => { o.overlap = v; }))),
    field('Estilo', sel([opt('tech', 'Técnico (blanco y negro)', o.theme === 'tech'), opt('color', 'Color', o.theme === 'color'), opt('blue', 'Blueprint', o.theme === 'blue')], v => { o.theme = v as PosterOpts['theme']; })),
    h('div', { class: 'stack' },
      chk('Omitir las hojas que quedan en blanco', 'skipEmpty'),
      chk('Marcas de corte, código de hoja y hojas vecinas', 'marks'),
      chk('Agregar una primera página con la guía de armado', 'index')),
  );
  const body = h('div', { class: 'poster', 'data-noenter': '1' }, form, h('div', { class: 'poster-preview' }, canvas, tip, note));
  draw();
  const ok = await modal('Imprimir en varias hojas (PDF)', body, [{ label: 'Cancelar', value: false }, { label: 'Descargar PDF', primary: true, value: true }], { size: 'xl' });
  if (!ok) return null;
  try { localStorage.setItem('planolibre:poster', JSON.stringify({ paper: o.paper, landscape: o.landscape, margin: o.margin, overlap: o.overlap, skipEmpty: o.skipEmpty, marks: o.marks, index: o.index })); } catch { /* ignore */ }
  layout(); // deja el desplazamiento centrado si corresponde
  return o;
}
