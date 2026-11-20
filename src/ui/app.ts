// Arma la aplicación: barra superior, herramientas, lienzo, paneles y acciones de archivo.

import type { Item, Units } from '../core/model';
import { newProject, normalizeProject, uid } from '../core/model';
import { store } from '../core/store';
import { sampleProject } from '../core/sample';
import { buildScene, itemPrims } from '../core/scene';
import { THEMES, type ViewMode } from '../core/themes';
import { SYMBOLS, SYMBOL_CATS, type SymbolDef } from '../core/symbols';
import { levelBounds } from '../core/topology';
import { fmtArea, fmtLen, UNIT_NAMES } from '../core/units';
import { Editor } from '../editor/editor';
import { drawPrims } from '../editor/view';
import { cadBounds, cadToShapes, flatten, guessUnitFactor, type CadDoc } from '../io/cad';
import { parseDxf, writeDxf } from '../io/dxf';
import { exportPdf, SCALES } from '../io/pdf';
import { exportPng, exportSvg, fileToDataUrl, pdfPageToImage, shrinkImage } from '../io/raster';
import { deleteLocal, download, forgetFileHandle, lastProjectId, listLocal, loadLocal, pickFile, safeName, saveLocal, saveProjectFile } from '../io/storage';
import { backgroundDialog, cadImportDialog, describeDetection, dxfDialog, helpDialog, pdfDialog, projectsDialog, welcomeDialog } from './dialogs';
import { convertShapes, defaultWallLayers, layersOf, previewWalls, type ConvertResult } from '../core/convert';
import type { DArc, DSeg } from '../core/detect';
import type { Shape } from '../core/model';
import { pdfPageVectors, pdfWallLayers, type PdfVectors } from '../io/pdfvec';
import { exportPosterPdf } from '../io/poster';
import { posterDialog } from './poster';
import { confirmDialog, h, icon, openMenu, promptDialog, toast } from './dom';
import { mountInspector } from './inspector';
import type { View3D } from '../view3d';

interface ToolDef { id: string; label: string; icon: string; key?: string; adv?: boolean; tip: string }
const TOOLS: ToolDef[] = [
  { id: 'select', label: 'Seleccionar', icon: 'select', key: 'V', tip: 'Seleccionar, mover y arrastrar puntos' },
  { id: 'room', label: 'Habitación', icon: 'room', key: 'H', tip: 'Dibujar una habitación rectangular completa' },
  { id: 'wall', label: 'Muro', icon: 'wall', key: 'M', tip: 'Dibujar muros punto a punto' },
  { id: 'door', label: 'Puerta', icon: 'door', key: 'P', tip: 'Colocar una puerta sobre un muro' },
  { id: 'window', label: 'Ventana', icon: 'window', key: 'N', tip: 'Colocar una ventana sobre un muro' },
  { id: 'library', label: 'Muebles', icon: 'sofa', tip: 'Mobiliario, artefactos y símbolos' },
  { id: 'text', label: 'Texto', icon: 'text', key: 'T', tip: 'Agregar un texto o nota' },
  { id: 'measure', label: 'Medir', icon: 'measure', key: 'D', tip: 'Medir la distancia entre dos puntos' },
  { id: 'gap', label: 'Vano', icon: 'gap', adv: true, tip: 'Abrir un vano sin puerta en un muro' },
  { id: 'dim', label: 'Cota', icon: 'dim', key: 'C', adv: true, tip: 'Agregar una cota (línea de medida) permanente' },
  { id: 'line', label: 'Línea', icon: 'line', key: 'L', adv: true, tip: 'Líneas libres: deslindes, terreno, ejes, detalles' },
  { id: 'hand', label: 'Mover vista', icon: 'hand', tip: 'Arrastrar para desplazar el plano (o usa Espacio)' },
];

const pref = {
  get(k: string, d = '') { try { return localStorage.getItem('planolibre:' + k) ?? d; } catch { return d; } },
  set(k: string, v: string) { try { localStorage.setItem('planolibre:' + k, v); } catch { /* ignore */ } },
};

export async function mountApp(root: HTMLElement) {
  store.advanced = pref.get('adv') === '1';
  const vm = pref.get('view', 'color');
  store.viewMode = (['tech', 'color', 'blue'].includes(vm) ? vm : 'color') as ViewMode;

  // ───────────── estructura ─────────────
  const canvas = h('canvas', { class: 'canvas', tabindex: '0', 'aria-label': 'Lienzo del plano' });
  const view3dEl = h('div', { class: 'view3d', hidden: true });
  const hintEl = h('div', { class: 'hint-pill' });
  const emptyEl = h('div', { class: 'empty-state', hidden: true });
  const viewerEl = h('div', { class: 'viewer-bar', hidden: true });
  const zoomLabel = h('span', { class: 'zoom-label' }, '100%');
  const coordEl = h('span', { class: 'status-item' });
  const areaEl = h('span', { class: 'status-item' });
  const saveEl = h('span', { class: 'status-item status-save' });
  const nameInput = h('input', { class: 'proj-name', type: 'text', 'aria-label': 'Nombre del proyecto', spellcheck: 'false', onchange: () => { store.project.name = nameInput.value.trim() || 'Plano sin título'; nameInput.value = store.project.name; store.emit('view'); } });
  const toolsEl = h('nav', { class: 'tools', 'aria-label': 'Herramientas' });
  const libEl = h('aside', { class: 'library', hidden: true });
  const inspEl = h('aside', { class: 'inspector', 'aria-label': 'Propiedades' });
  const topRight = h('div', { class: 'top-group' });
  const modeEl = h('div', { class: 'segmented', role: 'tablist', 'aria-label': 'Modo de vista' });
  const undoBtn = h('button', { class: 'icon-btn', title: 'Deshacer (Ctrl+Z)', onclick: () => store.undo() }, icon('undo', 18));
  const redoBtn = h('button', { class: 'icon-btn', title: 'Rehacer (Ctrl+Y)', onclick: () => store.redo() }, icon('redo', 18));
  const fileBtn = h('button', { class: 'btn btn-ghost', onclick: () => fileMenu() }, 'Archivo', icon('chevron', 14));

  const stage = h('main', { class: 'stage' }, canvas, view3dEl, hintEl, emptyEl, viewerEl,
    h('div', { class: 'zoom-ctl' },
      h('button', { class: 'icon-btn', title: 'Alejar', onclick: () => ed.zoomBy(1 / 1.25) }, icon('minus', 16)),
      zoomLabel,
      h('button', { class: 'icon-btn', title: 'Acercar', onclick: () => ed.zoomBy(1.25) }, icon('plus', 16)),
      h('button', { class: 'icon-btn', title: 'Encuadrar todo (F)', onclick: () => { if (store.viewMode === '3d') { v3?.resetCamera(); v3?.build(store.project); } else ed.fit(); } }, icon('fit', 16))));

  root.replaceChildren(
    h('header', { class: 'topbar' },
      h('div', { class: 'brand' }, h('span', { class: 'logo', html: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 3h18v18H3z"/><path d="M3 13h8v8M11 3v5M16 13v8"/></svg>' }), h('span', { class: 'brand-name' }, 'PlanoLibre')),
      nameInput, fileBtn, h('div', { class: 'top-sep' }), undoBtn, redoBtn, h('div', { class: 'top-sep' }), modeEl,
      h('div', { class: 'top-spacer' }), topRight),
    h('div', { class: 'body' }, toolsEl, libEl, stage, inspEl),
    h('footer', { class: 'status' }, coordEl, areaEl, h('span', { class: 'top-spacer' }), saveEl),
  );

  const ed = new Editor(canvas);
  ed.onHint = s => { hintEl.textContent = s; };
  ed.toast = toast;
  ed.askText = promptDialog;
  ed.onCursor = p => { coordEl.textContent = p ? `X ${fmtLen(p.x, store.project.units)}   Y ${fmtLen(p.y, store.project.units)}` : ''; };
  ed.onView = () => { const z = Math.round((ed.view.zoom / 60) * 100) + '%'; if (zoomLabel.textContent !== z) zoomLabel.textContent = z; };
  mountInspector(inspEl, ed);

  let libOpen = false;
  let v3: View3D | null = null;
  let v3timer = 0;

  // ───────────── barra superior ─────────────
  function renderTop() {
    const p = store.project;
    if (document.activeElement !== nameInput) nameInput.value = p.name;
    modeEl.replaceChildren(...([['tech', 'Técnico'], ['color', 'Color'], ['blue', 'Blueprint'], ['3d', '3D']] as [ViewMode, string][]).map(([m, l]) =>
      h('button', { class: 'seg' + (store.viewMode === m ? ' active' : ''), role: 'tab', 'aria-selected': String(store.viewMode === m), title: m === '3d' ? 'Ver el plano en 3D' : `Vista ${l}`, onclick: () => store.setViewMode(m) }, m === '3d' ? icon('cube', 15) : null, l)));
    const scaleSel = h('select', { class: 'input input-top', title: 'Escala del plano: define el tamaño de textos y cotas, y la escala sugerida al imprimir', onchange: () => { p.scale = parseInt(scaleSel.value, 10); store.emit('view'); } },
      SCALES.filter(s => s <= 1000).map(s => h('option', { value: String(s), selected: s === p.scale }, `1:${s}`)));
    const unitSel = h('select', { class: 'input input-top', title: 'Unidades de medida', onchange: () => { p.units = unitSel.value as Units; store.emit('view'); } },
      (Object.keys(UNIT_NAMES) as Units[]).map(u => h('option', { value: u, selected: u === p.units }, UNIT_NAMES[u])));
    const advChk = h('input', { type: 'checkbox', checked: store.advanced, onchange: () => { pref.set('adv', advChk.checked ? '1' : '0'); store.setAdvanced(advChk.checked); } });
    topRight.replaceChildren(
      h('label', { class: 'top-field' }, h('span', null, 'Escala'), scaleSel),
      h('label', { class: 'top-field' }, h('span', null, 'Unidades'), unitSel),
      h('label', { class: 'switch', title: 'Muestra herramientas y opciones para usuarios con experiencia' }, advChk, h('span', { class: 'switch-track' }), h('span', null, 'Avanzado')),
      h('button', { class: 'btn btn-primary', onclick: (e: Event) => exportMenu(e.currentTarget as HTMLElement) }, icon('download', 16), 'Exportar'),
      h('button', { class: 'icon-btn', title: 'Ayuda y atajos', onclick: () => helpDialog() }, icon('help', 19)),
    );
    undoBtn.disabled = !store.canUndo(); redoBtn.disabled = !store.canRedo();
  }

  function renderTools() {
    const is3d = store.viewMode === '3d';
    const shown = store.viewer ? TOOLS.filter(t => t.id === 'hand' || t.id === 'measure').reverse() : TOOLS.filter(t => !t.adv || store.advanced);
    toolsEl.replaceChildren(...shown.map(t => {
      const active = t.id === 'library' ? libOpen || store.tool === 'place' : store.tool === t.id;
      return h('button', {
        class: 'tool' + (active ? ' active' : '') + (t.id === 'hand' && !store.viewer ? ' tool-last' : ''), disabled: is3d, title: t.tip + (t.key ? `  (${t.key})` : ''), 'aria-pressed': String(active),
        onclick: () => {
          if (t.id === 'library') { libOpen = !libOpen; if (store.tool !== 'select') store.setTool('select'); renderTools(); renderLibrary(); return; }
          libOpen = false; store.setTool(t.id); renderLibrary();
        },
      }, icon(t.icon, 22), h('span', null, t.label));
    }));
    toolsEl.classList.toggle('disabled', is3d);
  }

  // ───────────── biblioteca de muebles ─────────────
  const thumbs = new Map<string, HTMLCanvasElement>();
  function thumb(def: SymbolDef): HTMLCanvasElement {
    let c = thumbs.get(def.type);
    if (c) return c;
    const size = 60, dpr = Math.min(2, window.devicePixelRatio || 1);
    c = h('canvas', { width: String(size * dpr), height: String(size * dpr), style: `width:${size}px;height:${size}px` });
    const ctx = c.getContext('2d')!;
    ctx.scale(dpr, dpr);
    const z = (size - 10) / Math.max(def.w, def.h);
    const it: Item = { id: 'thumb', type: def.type, x: 0, y: 0, w: def.w, h: def.h, rot: 0 };
    drawPrims(ctx, itemPrims(it, { ...THEMES.color, furnStroke: '#4b5563' }), z, size / 2, size / 2, 5);
    thumbs.set(def.type, c);
    return c;
  }
  let libFilter = '';
  function renderLibrary() {
    const show = (libOpen || store.tool === 'place') && store.viewMode !== '3d';
    libEl.hidden = !show;
    if (!show) return;
    const search = h('input', { class: 'input', type: 'search', placeholder: 'Buscar mueble…', value: libFilter, oninput: () => { libFilter = search.value; fill(); } });
    const listEl = h('div', { class: 'lib-list' });
    const fill = () => {
      const q = libFilter.trim().toLowerCase();
      listEl.replaceChildren();
      for (const cat of SYMBOL_CATS) {
        const defs = SYMBOLS.filter(s => s.cat === cat && (!q || s.name.toLowerCase().includes(q) || cat.toLowerCase().includes(q)));
        if (!defs.length) continue;
        listEl.append(h('h4', null, cat), h('div', { class: 'lib-grid' }, defs.map(d => {
          const b = h('button', { class: 'lib-item' + (store.placing === d.type && store.tool === 'place' ? ' active' : ''), title: `${d.name} · ${fmtLen(d.w, store.project.units)} × ${fmtLen(d.h, store.project.units, true)}`, onclick: () => { store.setTool('place', d.type); } }, h('span', { class: 'lib-thumb' }), h('span', { class: 'lib-name' }, d.name));
          b.firstChild!.appendChild(thumb(d));
          return b;
        })));
      }
      if (!listEl.children.length) listEl.append(h('p', { class: 'muted' }, 'Sin resultados.'));
    };
    fill();
    libEl.replaceChildren(h('div', { class: 'lib-head' }, h('strong', null, 'Muebles y símbolos'), h('button', { class: 'icon-btn', title: 'Cerrar', onclick: () => { libOpen = false; if (store.tool === 'place') store.setTool('select'); renderTools(); renderLibrary(); } }, icon('close', 16))),
      search, h('p', { class: 'hint' }, 'Elige uno y haz clic en el plano para colocarlo. Cerca de un muro se apoya solo.'), listEl);
  }

  // ───────────── estado vacío, barra de estado ─────────────
  function renderEmpty() {
    const lv = store.level;
    const empty = !lv.walls.length && !lv.items.length && !lv.shapes.length && !lv.background && !lv.labels.length && store.tool === 'select' && store.viewMode !== '3d';
    emptyEl.hidden = !empty;
    if (!empty || emptyEl.childElementCount) return;
    emptyEl.append(h('div', { class: 'empty-card' },
      h('h2', null, 'Empieza tu plano'),
      h('p', null, 'Lo más rápido: dibuja una habitación arrastrando un rectángulo. Después arrastra sus puntos y muros para darle forma.'),
      h('div', { class: 'empty-actions' },
        h('button', { class: 'btn btn-primary', onclick: () => store.setTool('room') }, icon('room', 17), 'Dibujar una habitación'),
        h('button', { class: 'btn', onclick: () => store.setTool('wall') }, icon('wall', 17), 'Dibujar muros'),
        h('button', { class: 'btn', onclick: () => openAny() }, icon('upload', 17), 'Importar plano o imagen'),
        h('button', { class: 'btn btn-ghost', onclick: () => loadProject(sampleProject()) }, icon('spark', 17), 'Ver ejemplo'))));
  }
  // ───────────── visor (sólo visualización) ─────────────
  function renderViewer() {
    const v = store.project.settings.viewer;
    viewerEl.hidden = !v || store.viewMode === '3d';
    if (!v) { viewerEl.replaceChildren(); return; }
    if (viewerEl.dataset.file === v.file && viewerEl.childElementCount) return;
    viewerEl.dataset.file = v.file;
    viewerEl.replaceChildren(
      icon('eye', 17),
      h('span', { class: 'viewer-name', title: v.file }, h('strong', null, 'Sólo visualización'), ` · ${v.file}`),
      h('button', { class: 'btn btn-primary btn-sm', onclick: () => doPoster() }, icon('grid', 15), 'Imprimir en PDF'),
      h('button', { class: 'btn btn-sm', onclick: (e: Event) => openMenu(e.currentTarget as HTMLElement, [
        { label: 'Convertir en muros editables', icon: 'wall', action: () => leaveViewer(true) },
        { label: 'Dejarlo como calco editable', icon: 'line', action: () => leaveViewer(false) },
      ], 'right') }, 'Editar', icon('chevron', 13)));
  }
  function leaveViewer(walls: boolean) {
    const p = store.project, lv = store.level;
    store.checkpoint();
    p.settings.viewer = null;
    lv.hiddenLayers = [];
    p.settings.layers.grid = true;
    if (walls) {
      const res = convertShapes(lv, lv.shapes, { height: p.settings.wallHeight, keepRest: true });
      if (res.walls) { lv.shapes = res.rest; store.touch(); store.emit('view'); afterConvert(res, 'Convertido en plano editable'); return; }
      toast('No se reconocieron muros: el dibujo quedó como calco editable.', 'error');
    } else toast('Ahora es un calco editable: puedes dibujar encima, moverlo o borrarlo.');
    store.touch();
    store.setTool('select');
    store.emit('view');
  }

  function renderStatus() {
    const rooms = store.derived().rooms;
    const total = rooms.reduce((s, r) => s + r.area, 0);
    areaEl.textContent = rooms.length ? `${rooms.length} recinto${rooms.length === 1 ? '' : 's'} · ${fmtArea(total, store.project.units)} útiles` : '';
  }

  // ───────────── modo 3D ─────────────
  async function sync3d() {
    const on = store.viewMode === '3d';
    view3dEl.hidden = !on; canvas.hidden = on; hintEl.hidden = false;
    if (!on) return;
    hintEl.textContent = 'Vista 3D: arrastra para girar · rueda para acercar · clic derecho para desplazar. Vuelve a una vista 2D para editar.';
    if (!v3) {
      try { const m = await import('../view3d'); v3 = new m.View3D(view3dEl); }
      catch (e) { console.error(e); toast('No se pudo iniciar la vista 3D en este equipo.', 'error'); store.setViewMode('color'); return; }
    }
    v3.resetCamera(); v3.resize(); v3.build(store.project);
  }

  // ───────────── guardado automático ─────────────
  let saveTimer = 0;
  function scheduleSave() {
    saveEl.textContent = 'Guardando…';
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(async () => {
      try { await saveLocal(store.project); saveEl.textContent = 'Guardado en este navegador ✓'; }
      catch { saveEl.textContent = 'No se pudo guardar automáticamente: usa Archivo → Guardar'; }
    }, 700);
  }

  function loadProject(p: ReturnType<typeof newProject>, fit = true) {
    forgetFileHandle();
    store.setProject(p);
    store.setTool('select');
    v3?.resetCamera();
    if (fit) requestAnimationFrame(() => ed.fit());
  }

  // ───────────── archivos ─────────────
  async function readText(file: File): Promise<string> {
    const buf = await file.arrayBuffer();
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
    catch { return new TextDecoder('windows-1252').decode(buf); }
  }

  /** Mensaje y selección comunes después de convertir un dibujo en muros. */
  function afterConvert(res: ConvertResult, what: string) {
    store.setTool('select');
    store.select(res.wallIds.slice(0, 400).map(id => ({ type: 'wall' as const, id })));
    ed.fit();
    const rest = res.rest.length ? ` El resto (${res.rest.length.toLocaleString('es')} elementos) quedó como calco.` : '';
    toast(`${what}: ${describeDetection(res)}. Revísalos: Ctrl+Z deshace todo.${rest}`);
  }

  async function importCad(doc: CadDoc, name: string) {
    const ents = flatten(doc);
    const b = cadBounds(ents);
    if (!ents.length || !b) { toast('El archivo no contiene geometría 2D que se pueda importar.', 'error'); return; }
    const probe = cadToShapes(ents, 1, { x: 0, y: 0 });
    const r = await cadImportDialog(name, { w: b.maxX - b.minX, h: b.maxY - b.minY }, guessUnitFactor(doc, ents), ents.length, !!doc.insUnits,
      layersOf(probe), defaultWallLayers(probe),
      (factor, layers) => { const d = previewWalls(cadToShapes(ents, factor, { x: 0, y: 0 }), { layers }); return { walls: d.walls.length, doors: d.openings.filter(o => o.kind === 'door').length, windows: d.openings.filter(o => o.kind === 'window').length }; });
    if (!r) return;
    if (r.mode === 'view') {
      // el plano actual se guarda antes de cambiar al visor, que es un proyecto aparte
      try { await saveLocal(store.project); } catch { /* se sigue igual */ }
      const p = newProject(name.replace(/\.(dxf|dwg)$/i, '') || 'Dibujo');
      p.settings.viewer = { file: name };
      p.settings.layers.grid = false;
      p.levels[0].shapes = cadToShapes(ents, r.factor, { x: 0, y: 0 });
      loadProject(p);
      store.setViewMode('tech');
      toast('Abierto en modo sólo visualización. Usa "Imprimir en PDF" para sacarlo a escala en varias hojas.');
      return;
    }
    const lv = store.level;
    const cur = levelBounds(lv);
    const at = cur ? { x: cur.maxX + 1, y: cur.minY } : { x: 0, y: 0 };
    const shapes = cadToShapes(ents, r.factor, at);
    store.checkpoint();
    if (r.mode === 'walls') {
      const res = convertShapes(lv, shapes, { height: store.project.settings.wallHeight, keepRest: r.keepRest, layers: r.layers });
      if (res.walls) {
        for (const s of res.rest) lv.shapes.push(s);
        if (res.rest.length) store.project.settings.layers.shapes = true;
        store.touch();
        afterConvert(res, 'Importado como muros editables');
        return;
      }
      toast('No se reconocieron muros: el dibujo quedó como calco.', 'error');
    }
    for (const s of shapes) lv.shapes.push(s);
    store.project.settings.layers.shapes = true;
    store.touch();
    store.setTool('select');
    if (shapes.length <= 3000) store.select(shapes.map(s => ({ type: 'shape' as const, id: s.id })));
    ed.fit();
    if (r.mode !== 'walls') toast(`Importado como calco: ${shapes.length.toLocaleString('es')} elementos. Al dibujar muros encima, el cursor se ajusta al eje de sus muros.`);
  }

  // Trazos vectoriales del PDF que está de fondo (sólo en memoria, durante esta sesión).
  const pdfVectors = new Map<string, PdfVectors>();
  let detectAfterCalibrate = false;

  async function placeBackground(dataUrl: string, wPx: number, hPx: number, widthM: number | null, vec: PdfVectors | null = null, detect = false) {
    const lv = store.level;
    const w = widthM ?? 10, hh = (w * hPx) / wPx;
    const c = ed.view.toWorld(ed.view.w / 2, ed.view.h / 2);
    const asset = uid('a');
    store.checkpoint();
    if (lv.background) { pdfVectors.delete(lv.background.asset); delete store.project.assets[lv.background.asset]; }
    store.project.assets[asset] = dataUrl;
    if (vec) pdfVectors.set(asset, vec);
    const cur = levelBounds({ ...lv, background: null });
    // si se van a reconocer muros, el fondo va al lado de lo ya dibujado para no mezclarse con ello
    lv.background = { asset, x: cur ? (detect ? cur.maxX + 1 : cur.minX) : c.x - w / 2, y: cur ? cur.minY : c.y - hh / 2, w, h: hh, opacity: 0.6, locked: widthM != null };
    store.project.settings.layers.background = true;
    store.touch();
    ed.fit();
    detectAfterCalibrate = false;
    if (widthM == null) {
      detectAfterCalibrate = detect;
      store.setTool('calibrate');
      toast(detect ? 'Primero calibra: marca dos puntos de una medida que conozcas. Después se reconocen los muros.' : 'Ahora calibra: marca dos puntos de una medida que conozcas.');
    } else if (detect) await detectBackgroundWalls();
    else { store.setTool('select'); toast('Fondo colocado a escala. Ya puedes calcar los muros encima.'); }
  }

  /** Reconoce muros en el fondo: con los trazos del PDF si los hay, o analizando la imagen. */
  async function detectBackgroundWalls() {
    const lv = store.level, bg = lv.background;
    if (!bg) return;
    const data = store.project.assets[bg.asset];
    const height = store.project.settings.wallHeight;
    const build = (segs: DSeg[], arcs: DArc[], k: number): Shape[] => {
      const out: Shape[] = segs.map(s => ({ id: uid('s'), kind: 'poly' as const, pts: [bg.x + s.x1 * k, bg.y + s.y1 * k, bg.x + s.x2 * k, bg.y + s.y2 * k], layer: s.layer || '0', dash: s.dash }));
      for (const a of arcs) out.push({ id: uid('s'), kind: 'arc', pts: [bg.x + a.x * k, bg.y + a.y * k], r: a.r * k, a0: a.a0, a1: a.a1, layer: a.layer || '0' });
      return out;
    };
    // los textos del PDF sirven para nombrar los recintos ("Cocina", "Baño"…)
    const texts = (v: PdfVectors, k: number): Shape[] => v.texts.map(t => ({ id: uid('s'), kind: 'text' as const, pts: [bg.x + t.x * k, bg.y + t.y * k], text: t.text, h: 0.2, layer: 'texto' }));
    try {
      let shapes: Shape[] = [], layers: Set<string> | null = null, found = 0;
      const vec = pdfVectors.get(bg.asset);
      if (vec && vec.segs.length >= 8) {
        shapes = build(vec.segs, vec.arcs, bg.w / vec.w).concat(texts(vec, bg.w / vec.w));
        layers = pdfWallLayers(vec, set => previewWalls(shapes, { layers: set, dropFree: true }).walls.length);
        found = layers ? previewWalls(shapes, { layers, dropFree: true }).walls.length : 0;
      }
      if (!found) {
        if (!data) return;
        toast('Analizando la imagen…');
        await new Promise(r => setTimeout(r, 30));
        const { vectorizeImage, SOLID, LINE } = await import('../io/vectorize');
        const v = await vectorizeImage(data, bg.w);
        shapes = build(v.segs, [], bg.w / v.w);
        // plano de muros rellenos: sólo cuentan los trazos macizos; plano a doble línea: todas las líneas
        const solid = new Set([SOLID]);
        layers = previewWalls(shapes, { layers: solid, dropFree: true }).walls.length >= 3 ? solid : new Set([SOLID, LINE]);
      }
      store.checkpoint();
      const res = convertShapes(lv, shapes, { height, keepRest: false, layers, dropFree: true });
      if (!res.walls) {
        store.dropCheckpoint();
        store.setTool('select');
        toast('No se reconocieron muros en el fondo. Puedes calcarlos a mano: dibuja encima con Muro o Habitación.', 'error');
        return;
      }
      store.touch();
      afterConvert(res, vec && found ? 'Muros reconocidos en el PDF' : 'Muros reconocidos en la imagen (revisa: es experimental)');
    } catch (e: any) {
      console.error(e);
      toast('No se pudieron reconocer los muros: ' + (e?.message || 'error desconocido'), 'error');
    }
  }
  ed.onCalibrated = () => { if (detectAfterCalibrate) { detectAfterCalibrate = false; void detectBackgroundWalls(); } };
  ed.detectBackground = () => { void detectBackgroundWalls(); };

  async function handleFile(file: File) {
    const ext = (file.name.toLowerCase().split('.').pop() || '');
    try {
      if (ext === 'plano' || ext === 'json') {
        loadProject(normalizeProject(JSON.parse(await file.text())));
        toast(`"${store.project.name}" abierto`);
      } else if (ext === 'dxf') {
        await importCad(parseDxf(await readText(file)), file.name);
      } else if (ext === 'dwg') {
        toast('Leyendo DWG… (la primera vez carga el lector, puede tardar unos segundos)');
        const { parseDwg } = await import('../io/dwg');
        await importCad(await parseDwg(await file.arrayBuffer()), file.name);
      } else if (ext === 'pdf') {
        const buf = await file.arrayBuffer();
        toast('Leyendo PDF…');
        let page = await pdfPageToImage(buf.slice(0), 1);
        const vectors = async (n: number) => { try { return await pdfPageVectors(buf.slice(0), n); } catch (e) { console.warn(e); return null; } };
        let vec = await vectors(1);
        const r = await backgroundDialog('pdf', page.pages, !!vec && vec.segs.length >= 8);
        if (!r) return;
        if (r.page !== 1) { page = await pdfPageToImage(buf.slice(0), r.page); vec = await vectors(r.page); }
        await placeBackground(page.dataUrl, page.w, page.h, r.scale ? (page.widthMm / 1000) * r.scale : null, vec, r.detect);
      } else if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(ext)) {
        const img = await shrinkImage(await fileToDataUrl(file));
        const r = await backgroundDialog('image');
        if (!r) return;
        await placeBackground(img.dataUrl, img.w, img.h, null, null, r.detect);
      } else toast('Formato no reconocido. Se aceptan .plano, .dxf, .dwg, .pdf e imágenes.', 'error');
    } catch (e: any) {
      console.error(e);
      toast('No se pudo abrir el archivo: ' + (e?.message || 'error desconocido'), 'error');
    }
  }

  const ANY = '.plano,.json,.dxf,.dwg,.pdf,.png,.jpg,.jpeg,.webp';
  async function openAny(accept = ANY) { const f = await pickFile(accept); if (f) await handleFile(f); }

  async function save(saveAs = false) {
    try { await saveLocal(store.project); } catch { /* ignore */ }
    const r = await saveProjectFile(store.project, saveAs);
    if (r === 'saved') toast('Archivo guardado');
    else if (r === 'downloaded') toast('Archivo .plano descargado');
  }

  async function openProjects() {
    const id = await projectsDialog(await listLocal(), async pid => {
      if (pid === store.project.id) { toast('Ese es el proyecto que tienes abierto.'); return false; }
      if (!(await confirmDialog('Eliminar proyecto', 'Se borrará de este navegador. Esta acción no se puede deshacer.', 'Eliminar', true))) return false;
      await deleteLocal(pid);
      return true;
    });
    if (id && id !== store.project.id) { const p = await loadLocal(id); if (p) loadProject(p); }
  }

  function fileMenu() {
    openMenu(fileBtn, [
      { label: 'Nuevo plano', icon: 'plus', action: () => loadProject(newProject()) },
      { label: 'Abrir archivo…', icon: 'folder', hint: 'Ctrl+O', action: () => openAny() },
      { label: 'Mis proyectos…', icon: 'file', action: () => openProjects() },
      { sep: true },
      { label: 'Guardar como archivo', icon: 'save', hint: 'Ctrl+S', action: () => save() },
      { label: 'Guardar una copia…', action: () => save(true) },
      { sep: true },
      { header: 'Importar al plano actual' },
      { label: 'Dibujo de AutoCAD (DXF o DWG)…', icon: 'upload', action: () => openAny('.dxf,.dwg') },
      { label: 'Imagen o PDF para calcar…', icon: 'image', action: () => openAny('.pdf,.png,.jpg,.jpeg,.webp') },
      { sep: true },
      { label: 'Abrir plano de ejemplo', icon: 'spark', action: () => loadProject(sampleProject()) },
    ]);
  }

  const theme2d = (): 'tech' | 'color' | 'blue' => (store.viewMode === '3d' ? 'color' : store.viewMode);
  async function doPdf() {
    const o = await pdfDialog(store.project, theme2d());
    if (!o) return;
    try { download(safeName(store.project.name) + '.pdf', await exportPdf(store.project, o), 'application/pdf'); toast('PDF generado'); }
    catch (e: any) { console.error(e); toast('No se pudo generar el PDF: ' + (e?.message || ''), 'error'); }
  }
  async function doPoster() {
    const v = ed.view, a = v.toWorld(0, 0), b = v.toWorld(v.w, v.h);
    const o = await posterDialog(store.project, theme2d(), store.viewMode === '3d' ? null : { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y });
    if (!o) return;
    try { download(safeName(store.project.name) + '-hojas.pdf', await exportPosterPdf(store.project, o), 'application/pdf'); toast('PDF generado. Imprímelo al 100 %, sin "ajustar a la página".'); }
    catch (e: any) { console.error(e); toast('No se pudo generar el PDF: ' + (e?.message || ''), 'error'); }
  }
  async function doDxf() {
    const unit = await dxfDialog();
    if (!unit) return;
    const p = store.project, st = p.settings;
    const prims = buildScene(store.level, { theme: THEMES.tech, annot: p.scale / 1000, units: p.units, layers: { ...st.layers, grid: false, background: false }, showRoomDims: st.showRoomDims, showAreas: st.showAreas, showOverallDims: st.showOverallDims });
    download(safeName(p.name) + '.dxf', writeDxf(prims, unit), 'application/dxf');
    toast('DXF generado: ábrelo en AutoCAD o cualquier CAD');
  }
  async function doPng() {
    if (store.viewMode === '3d' && v3) {
      const blob = await (await fetch(v3.snapshot())).blob();
      download(safeName(store.project.name) + '-3d.png', blob, 'image/png');
    } else download(safeName(store.project.name) + '.png', await exportPng(store.project, theme2d()), 'image/png');
    toast('Imagen generada');
  }
  function exportMenu(anchor: HTMLElement) {
    openMenu(anchor, [
      { label: 'PDF a escala…', icon: 'file', hint: 'una hoja', action: doPdf },
      { label: 'PDF en varias hojas…', icon: 'grid', hint: 'planos grandes', action: doPoster },
      { label: 'DXF para AutoCAD…', icon: 'layers', hint: 'CAD', action: doDxf },
      { label: store.viewMode === '3d' ? 'Imagen PNG de la vista 3D' : 'Imagen PNG', icon: 'image', action: doPng },
      { label: 'SVG vectorial', icon: 'line', action: () => { download(safeName(store.project.name) + '.svg', exportSvg(store.project, theme2d()), 'image/svg+xml'); toast('SVG generado'); } },
      { sep: true },
      { label: '¿Y en formato DWG?', icon: 'help', action: doDxf },
      { label: 'Archivo de proyecto (.plano)', icon: 'save', action: () => save(true) },
    ], 'right');
  }

  // ───────────── eventos globales ─────────────
  window.addEventListener('keydown', ev => {
    const mod = ev.ctrlKey || ev.metaKey, k = ev.key.toLowerCase();
    if (mod && k === 's') { ev.preventDefault(); save(ev.shiftKey); }
    if (mod && k === 'o') { ev.preventDefault(); openAny(); }
  });
  window.addEventListener('dragover', ev => { ev.preventDefault(); });
  window.addEventListener('drop', ev => { ev.preventDefault(); const f = ev.dataTransfer?.files?.[0]; if (f) handleFile(f); });
  window.addEventListener('beforeunload', () => { saveLocal(store.project).catch(() => {}); });

  store.on(ev => {
    if (ev === 'view') { pref.set('view', store.viewMode === '3d' ? pref.get('view', 'color') : store.viewMode); sync3d(); }
    if (ev === 'view' || ev === 'project') renderTop();
    if (ev === 'view' || ev === 'project' || ev === 'change') { undoBtn.disabled = !store.canUndo(); redoBtn.disabled = !store.canRedo(); scheduleSave(); }
    if (ev === 'tool' || ev === 'view' || ev === 'project') { if (ev === 'tool' && !['place', 'select'].includes(store.tool)) libOpen = false; renderTools(); renderLibrary(); }
    renderEmpty(); renderStatus(); renderViewer();
    if (store.viewMode === '3d' && ev === 'change' && v3) { clearTimeout(v3timer); v3timer = window.setTimeout(() => v3?.build(store.project), 120); }
  });

  // ───────────── arranque ─────────────
  renderTop(); renderTools(); renderLibrary(); ed.refreshHint();
  let opened = false;
  const last = lastProjectId();
  if (last) { try { const p = await loadLocal(last); if (p) { loadProject(p); opened = true; } } catch { /* ignore */ } }
  if (!opened) {
    loadProject(newProject());
    let entries: Awaited<ReturnType<typeof listLocal>> = [];
    try { entries = await listLocal(); } catch { /* ignore */ }
    if (!new URLSearchParams(location.search).has('nowelcome')) {
      const c = await welcomeDialog(entries);
      if (c?.kind === 'sample') loadProject(sampleProject());
      else if (c?.kind === 'open') openAny();
      else if (c?.kind === 'project') { const p = await loadLocal(c.id); if (p) loadProject(p); }
    }
  }
  renderEmpty(); renderStatus();
  // acceso para pruebas automáticas y depuración desde la consola
  (window as any).planolibre = { store, editor: ed, handleFile, sampleProject, loadProject, exportPdf, exportPng, exportPosterPdf };
}
