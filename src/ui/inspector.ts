// Panel derecho: propiedades de lo seleccionado, niveles, capas y resumen de superficies.

import type { ID, Level, Opening, Wall } from '../core/model';
import { LAYERS, newLevel, uid } from '../core/model';
import { dist, sub, unit } from '../core/geom';
import { store } from '../core/store';
import { levelBounds, nodeMap, settleNodes, splitWall, wallsAt } from '../core/topology';
import { fmtArea, fmtLen, parseLen, toUnit, unitSuffix } from '../core/units';
import { symbolDef } from '../core/symbols';
import { ROOM_NAMES, ROOM_TYPES, roomTypeFromName } from '../core/themes';
import { OPENING_DEFAULTS } from '../core/ops';
import type { Editor } from '../editor/editor';
import { confirmDialog, h, icon, openMenu, promptDialog, toast } from './dom';
import { convertShapes } from '../core/convert';
import { describeDetection } from './dialogs';

const edit = (fn: () => void) => { store.checkpoint(); fn(); store.touch(); };

/** Convierte en muros editables el dibujo de referencia seleccionado (o todo su grupo). */
function convertSelectedShapes() {
  const lv = store.level;
  let ids = new Set(store.selection.filter(s => s.type === 'shape').map(s => s.id));
  if (ids.size === 1) {
    const one = lv.shapes.find(x => ids.has(x.id));
    if (one?.group) ids = new Set(lv.shapes.filter(x => x.group === one.group).map(x => x.id));
  }
  const chosen = lv.shapes.filter(s => ids.has(s.id));
  store.checkpoint();
  const res = convertShapes(lv, chosen, { height: store.project.settings.wallHeight, keepRest: true });
  if (!res.walls) {
    store.dropCheckpoint();
    toast('No se reconocieron muros en este dibujo: se buscan dos líneas paralelas separadas entre 5 y 45 cm.', 'error');
    return;
  }
  lv.shapes = lv.shapes.filter(s => !ids.has(s.id)).concat(res.rest);
  store.selection = res.wallIds.slice(0, 400).map(id => ({ type: 'wall' as const, id }));
  store.touch();
  store.emit('select');
  toast(`Convertido: ${describeDetection(res)}. Revísalos: Ctrl+Z lo deshace.`);
}
let textEditing: ID | null = null;

function section(title: string, ...children: (Node | null | false | undefined)[]): HTMLElement {
  return h('section', { class: 'insp-section' }, title ? h('h3', null, title) : null, ...(children.filter(Boolean) as Node[]));
}
function row(label: string, control: Node, help?: string): HTMLElement {
  return h('label', { class: 'field' }, h('span', { class: 'field-label', title: help || null }, label), control);
}
function lenInput(key: string, valueM: number, onCommit: (m: number) => void, min = 0.01): HTMLElement {
  const u = store.project.units;
  const inp = h('input', {
    class: 'input', type: 'text', inputmode: 'decimal', 'data-key': key, value: toUnit(valueM, u),
    onchange: () => { const v = parseLen(inp.value, u); if (v == null || v < min) { inp.value = toUnit(valueM, u); toast('Medida no válida', 'error'); return; } onCommit(v); },
    onfocus: () => inp.select(),
  });
  return h('div', { class: 'input-wrap' }, inp, u === 'ft' ? null : h('span', { class: 'input-suffix' }, unitSuffix(u)));
}
function numInput(key: string, value: number, onCommit: (v: number) => void, suffix = '', step = 1): HTMLElement {
  const inp = h('input', { class: 'input', type: 'number', step, 'data-key': key, value: String(Math.round(value * 100) / 100), onchange: () => { const v = parseFloat(inp.value); if (Number.isFinite(v)) onCommit(v); }, onfocus: () => inp.select() });
  return h('div', { class: 'input-wrap' }, inp, suffix ? h('span', { class: 'input-suffix' }, suffix) : null);
}
function selectInput(key: string, options: [string, string][], value: string, onChange: (v: string) => void): HTMLElement {
  const sel = h('select', { class: 'input', 'data-key': key, onchange: () => onChange(sel.value) }, options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
  return sel;
}
function check(label: string, checked: boolean, onChange: (v: boolean) => void): HTMLElement {
  const inp = h('input', { type: 'checkbox', checked, onchange: () => onChange(inp.checked) });
  return h('label', { class: 'check' }, inp, h('span', null, label));
}
function btn(label: string, ic: string | null, onClick: () => void, cls = ''): HTMLElement {
  return h('button', { class: 'btn btn-sm ' + cls, onclick: onClick }, ic ? icon(ic, 15) : null, label);
}
function info(label: string, value: string): HTMLElement {
  return h('div', { class: 'info-row' }, h('span', null, label), h('strong', null, value));
}

/**
 * Cambia el largo de un muro "estirando" el plano: los muros perpendiculares
 * del extremo que se mueve se trasladan completos, así una habitación
 * rectangular sigue siendo rectangular.
 */
function setWallLength(lv: Level, w: Wall, L: number) {
  const nm = nodeMap(lv);
  const a = nm.get(w.a)!, b = nm.get(w.b)!;
  const d = unit(sub(b, a)), cur = dist(a, b);
  const moveB = wallsAt(lv, w.b).length <= wallsAt(lv, w.a).length;
  const fixed = moveB ? w.a : w.b, start = moveB ? w.b : w.a;
  const k = moveB ? L - cur : cur - L;
  const delta = { x: d.x * k, y: d.y * k };
  let moving = new Set<ID>([start]);
  const queue = [start];
  let ok = true;
  while (queue.length) {
    const id = queue.pop()!;
    for (const x of wallsAt(lv, id)) {
      if (x.id === w.id) continue;
      const p = nm.get(x.a)!, q = nm.get(x.b)!;
      const xd = unit(sub(q, p));
      if (Math.abs(xd.x * d.x + xd.y * d.y) > 0.02) continue; // sólo los muros perpendiculares se trasladan; el resto se alarga o se inclina
      const other = x.a === id ? x.b : x.a;
      if (other === fixed) { ok = false; break; }
      if (!moving.has(other)) { moving.add(other); queue.push(other); }
    }
    if (!ok) break;
  }
  if (!ok) moving = new Set([start]);
  for (const n of lv.nodes) if (moving.has(n.id)) { n.x += delta.x; n.y += delta.y; }
  settleNodes(lv, [...moving]);
}

export function mountInspector(el: HTMLElement, ed: Editor) {
  let raf = 0;
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); };
  store.on(ev => { if (ev !== 'tool') schedule(); });
  ed.onFocusField = key => {
    render();
    const f = el.querySelector(`[data-key="${key}"]`) as HTMLInputElement | null;
    if (f) { f.focus(); f.select?.(); }
  };

  function render() {
    const active = document.activeElement as HTMLElement | null;
    const key = active && el.contains(active) ? active.dataset.key : null;
    const scroll = el.scrollTop;
    el.replaceChildren(...build());
    el.scrollTop = scroll;
    if (key) (el.querySelector(`[data-key="${key}"]`) as HTMLElement | null)?.focus();
  }

  function build(): HTMLElement[] {
    const sel = store.selection, lv = store.level;
    if (store.viewer) return viewerSections();
    const out: HTMLElement[] = [];
    if (sel.length === 0) out.push(...planSections());
    else if (sel.length === 1) out.push(single(sel[0].type, sel[0].id));
    else out.push(multi());
    out.push(levelsSection(), layersSection());
    if (sel.length !== 0) return out;
    out.push(summarySection(lv));
    return out;
  }

  // ───────────── visor: información y capas del dibujo importado ─────────────
  function viewerSections(): HTMLElement[] {
    const lv = store.level, u = store.project.units;
    const b = levelBounds(lv);
    const count = new Map<string, number>();
    for (const s of lv.shapes) count.set(s.layer || '0', (count.get(s.layer || '0') || 0) + 1);
    const names = [...count.keys()].sort((x, y) => x.localeCompare(y));
    const hidden = new Set(lv.hiddenLayers || []);
    const setHidden = (next: Set<string>) => { lv.hiddenLayers = [...next]; store.touch(); };
    const list = h('div', { class: 'layer-list' }, names.map(n => {
      const on = !hidden.has(n);
      return h('button', { class: 'layer layer-cad' + (on ? '' : ' off'), title: on ? 'Ocultar capa' : 'Mostrar capa', onclick: () => { const nx = new Set(hidden); if (on) nx.add(n); else nx.delete(n); setHidden(nx); } },
        icon(on ? 'eye' : 'eyeOff', 16), h('span', { class: 'layer-cad-name' }, n), h('span', { class: 'muted' }, String(count.get(n))));
    }));
    return [
      section('Visor',
        info('Archivo', store.project.settings.viewer?.file || '—'),
        info('Elementos', lv.shapes.length.toLocaleString('es')),
        b ? info('Tamaño', `${fmtLen(b.maxX - b.minX, u)} × ${fmtLen(b.maxY - b.minY, u, true)}`) : null,
        h('p', { class: 'hint' }, 'El dibujo se muestra tal cual, sin editar. Usa Medir para tomar distancias (el cursor se ajusta a los vértices) e "Imprimir en PDF" para sacarlo a escala en varias hojas.'),
      ),
      section('Capas del dibujo',
        names.length > 1 ? h('div', { class: 'btn-row' }, btn('Mostrar todas', 'eye', () => setHidden(new Set())), btn('Ocultar todas', null, () => setHidden(new Set(names)))) : null,
        list,
        h('p', { class: 'hint' }, 'Las capas ocultas tampoco se imprimen.'),
      ),
    ];
  }

  // ───────────── sin selección: ajustes del plano ─────────────
  function planSections(): HTMLElement[] {
    const p = store.project, st = p.settings, adv = store.advanced;
    const presets: [string, string][] = [['0.1', 'Tabique (10 cm)'], ['0.15', 'Muro (15 cm)'], ['0.2', 'Muro exterior (20 cm)'], ['0.25', 'Muro grueso (25 cm)']];
    const cur = String(st.wallThickness);
    if (!presets.some(x => x[0] === cur)) presets.push([cur, `Personalizado (${fmtLen(st.wallThickness, p.units, true)})`]);
    const set = (fn: () => void) => { fn(); store.emit('view'); };
    const out = [section('Muros nuevos',
      row('Tipo de muro', selectInput('wt', presets, cur, v => set(() => { st.wallThickness = parseFloat(v); }))),
      adv ? row('Grosor exacto', lenInput('wtx', st.wallThickness, v => set(() => { st.wallThickness = v; }))) : null,
      adv ? row('Altura', lenInput('wh', st.wallHeight, v => set(() => { st.wallHeight = v; }), 0.3)) : null,
      h('p', { class: 'hint' }, 'Se aplica a los muros que dibujes desde ahora. Para cambiar uno existente, selecciónalo.'),
    )];
    out.push(section('Mostrar en el plano',
      check('Medidas de cada recinto', st.showRoomDims, v => set(() => { st.showRoomDims = v; })),
      check('Superficies (m²)', st.showAreas, v => set(() => { st.showAreas = v; })),
      check('Cotas generales exteriores', st.showOverallDims, v => set(() => { st.showOverallDims = v; })),
    ));
    if (adv) out.push(section('Precisión y ajuste',
      row('Paso de cuadrícula', selectInput('gs', [['0.01', '1 cm'], ['0.05', '5 cm'], ['0.1', '10 cm'], ['0.25', '25 cm'], ['0.5', '50 cm'], ['1', '1 m']], String(st.gridStep), v => set(() => { st.gridStep = parseFloat(v); }))),
      check('Ajustar a la cuadrícula', st.snapGrid, v => set(() => { st.snapGrid = v; })),
      check('Ajustar a ángulos de 45° y 90°', st.snapAngle, v => set(() => { st.snapAngle = v; })),
      check('Ajustar a puntos, muros y alineaciones', st.snapObjects, v => set(() => { st.snapObjects = v; })),
      row('Autor (para el cajetín)', h('input', { class: 'input', type: 'text', 'data-key': 'author', value: p.author, placeholder: 'Tu nombre', onchange: (e: Event) => set(() => { p.author = (e.target as HTMLInputElement).value; }) })),
    ));
    if (store.level.background) out.push(backgroundSection());
    return out;
  }

  function backgroundSection(): HTMLElement {
    const bg = store.level.background!;
    const slider = h('input', {
      type: 'range', min: '0.05', max: '1', step: '0.05', value: String(bg.opacity), class: 'range',
      oninput: () => { bg.opacity = parseFloat(slider.value); ed.requestDraw(); },
      onchange: () => store.touch(),
    });
    return section('Imagen de fondo',
      h('p', { class: 'hint' }, 'Úsala como guía para calcar los muros encima, o deja que la app intente reconocerlos. Primero calibra su escala.'),
      row('Opacidad', slider),
      info('Tamaño', `${fmtLen(bg.w, store.project.units)} × ${fmtLen(bg.h, store.project.units, true)}`),
      check('Bloquear (no se mueve al hacer clic)', bg.locked, v => { bg.locked = v; if (v && store.selection.some(s => s.type === 'background')) store.select([]); store.touch(); }),
      h('div', { class: 'btn-row' }, btn('Reconocer muros en el fondo', 'wall', () => ed.detectBackground(), 'btn-primary')),
      h('div', { class: 'btn-row' },
        btn('Calibrar escala', 'calibrate', () => store.setTool('calibrate')),
        btn('Quitar', 'trash', () => edit(() => { delete store.project.assets[bg.asset]; store.level.background = null; store.selection = []; }))),
    );
  }

  // ───────────── un elemento seleccionado ─────────────
  function single(type: string, id: ID): HTMLElement {
    const lv = store.level, u = store.project.units, adv = store.advanced;
    const del = btn('Eliminar', 'trash', () => ed.deleteSelection(), 'btn-danger-ghost');
    if (type === 'wall') {
      const w = lv.walls.find(x => x.id === id);
      if (!w) return section('Muro');
      const nm = nodeMap(lv), a = nm.get(w.a)!, b = nm.get(w.b)!;
      const L = dist(a, b);
      const ang = Math.round(((Math.atan2(-(b.y - a.y), b.x - a.x) * 180) / Math.PI + 360) % 180);
      return section('Muro',
        row('Largo', lenInput('len', L, v => { edit(() => setWallLength(lv, w, v)); ed.pruneSelection(); }), 'Medido entre los ejes de los muros'),
        row('Grosor', lenInput('thick', w.thickness, v => edit(() => { w.thickness = Math.min(1.5, v); }))),
        adv ? row('Altura', lenInput('height', w.height, v => edit(() => { w.height = v; }), 0.2)) : null,
        adv ? info('Ángulo', ang + '°') : null,
        h('div', { class: 'btn-row' },
          btn('Dividir', 'split', () => { store.checkpoint(); const n = splitWall(lv, w.id, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }); store.touch(); if (n) store.select([{ type: 'node', id: n.id }]); }),
          del),
        h('p', { class: 'hint' }, 'Arrastra el muro o sus puntos para moverlo. Al cambiar el largo, el resto del plano se estira para mantenerse recto.'),
      );
    }
    if (type === 'node') {
      const n = lv.nodes.find(x => x.id === id);
      if (!n) return section('Punto');
      return section('Punto (esquina)',
        adv ? row('X', lenInput('nx', n.x, v => { edit(() => { n.x = v; settleNodes(lv, [n.id]); }); ed.pruneSelection(); }, -1e6)) : null,
        adv ? row('Y', lenInput('ny', n.y, v => { edit(() => { n.y = v; settleNodes(lv, [n.id]); }); ed.pruneSelection(); }, -1e6)) : null,
        info('Muros que llegan', String(wallsAt(lv, n.id).length)),
        h('div', { class: 'btn-row' }, del),
        h('p', { class: 'hint' }, 'Arrástralo para cambiar la forma. Si lo sueltas sobre otro punto o muro, se unen.'),
      );
    }
    if (type === 'opening') {
      const o = lv.openings.find(x => x.id === id);
      if (!o) return section('Abertura');
      const styles: Record<string, [string, string][]> = {
        door: [['single', 'Abatible'], ['double', 'Doble hoja'], ['sliding', 'Corredera']],
        window: [['sliding', 'Corredera'], ['single', 'Abatible'], ['fixed', 'Fija']],
        gap: [['single', 'Vano libre']],
      };
      const g = store.derived().geoms.get(o.wall);
      return section(o.kind === 'door' ? 'Puerta' : o.kind === 'window' ? 'Ventana' : 'Vano',
        row('Tipo', selectInput('okind', [['door', 'Puerta'], ['window', 'Ventana'], ['gap', 'Vano (sin puerta)']], o.kind, v => edit(() => {
          const d = OPENING_DEFAULTS[v as Opening['kind']];
          o.kind = v as Opening['kind']; o.style = d.style; o.height = d.height; o.sill = d.sill;
        }))),
        o.kind !== 'gap' ? row('Estilo', selectInput('ostyle', styles[o.kind], o.style, v => edit(() => { o.style = v as Opening['style']; }))) : null,
        row('Ancho', lenInput('owidth', o.width, v => edit(() => { o.width = v; }), 0.2)),
        adv || o.kind === 'window' ? row('Alto', lenInput('oheight', o.height, v => edit(() => { o.height = v; }), 0.2)) : null,
        o.kind === 'window' ? row('Antepecho', lenInput('osill', o.sill, v => edit(() => { o.sill = v; }), 0), 'Altura desde el piso hasta la base de la ventana') : null,
        adv && g ? row('Distancia al inicio del muro', lenInput('opos', Math.max(0, o.t * g.len - o.width / 2), v => edit(() => { o.t = Math.max(0, Math.min(1, (v + o.width / 2) / g.len)); }), 0)) : null,
        o.kind === 'door' ? h('div', { class: 'btn-row' },
          btn('Cambiar bisagra', 'flip', () => edit(() => { o.flipH = !o.flipH; })),
          btn('Abrir al otro lado', 'rotate', () => edit(() => { o.flipV = !o.flipV; }))) : null,
        h('div', { class: 'btn-row' }, del),
        h('p', { class: 'hint' }, 'Arrástrala para deslizarla por el muro o pasarla a otro.'),
      );
    }
    if (type === 'item') {
      const it = lv.items.find(x => x.id === id);
      if (!it) return section('Mueble');
      return section(symbolDef(it.type).name,
        row('Ancho', lenInput('iw', it.w, v => edit(() => { it.w = v; }), 0.05)),
        row('Fondo', lenInput('ih', it.h, v => edit(() => { it.h = v; }), 0.05)),
        row('Rotación', numInput('irot', it.rot, v => edit(() => { it.rot = ((v % 360) + 360) % 360; }), '°', 15)),
        h('div', { class: 'btn-row' },
          btn('Girar 90°', 'rotate', () => ed.rotateSelection(90)),
          btn('Duplicar', 'copy', () => ed.duplicate()),
          del),
      );
    }
    if (type === 'room') {
      const r = store.derived().rooms.find(x => x.key === id);
      if (!r) return section('Recinto');
      const setName = (name: string) => edit(() => {
        if (r.meta) { r.meta.name = name; r.meta.type = roomTypeFromName(name) === 'other' && !name ? 'other' : roomTypeFromName(name) !== 'other' ? roomTypeFromName(name) : r.meta.type; }
        else lv.rooms.push({ id: uid('r'), x: r.center.x, y: r.center.y, name, type: roomTypeFromName(name) });
      });
      const listId = 'room-names';
      return section('Recinto',
        row('Nombre', h('div', null,
          h('input', { class: 'input', type: 'text', list: listId, 'data-key': 'name', value: r.meta?.name || '', placeholder: 'Ej.: Dormitorio', onchange: (e: Event) => setName((e.target as HTMLInputElement).value.trim()) }),
          h('datalist', { id: listId }, ROOM_NAMES.map(n => h('option', { value: n }))))),
        row('Uso (color)', selectInput('rtype', ROOM_TYPES.map(t => [t.key, t.name] as [string, string]), r.meta?.type || 'other', v => edit(() => {
          if (r.meta) r.meta.type = v; else lv.rooms.push({ id: uid('r'), x: r.center.x, y: r.center.y, name: '', type: v });
        }))),
        info('Superficie útil', fmtArea(r.area, u)),
        info('Perímetro interior', fmtLen(r.perimeter, u, true)),
        h('p', { class: 'hint' }, 'La superficie se calcula sola, por la cara interior de los muros, y se actualiza al mover cualquier punto.'),
      );
    }
    if (type === 'label') {
      const l = lv.labels.find(x => x.id === id);
      if (!l) return section('Texto');
      return section('Texto',
        row('Contenido', h('input', { class: 'input', type: 'text', 'data-key': 'text', value: l.text, oninput: (e: Event) => { if (textEditing !== l.id) { store.checkpoint(); textEditing = l.id; } l.text = (e.target as HTMLInputElement).value || ' '; ed.requestDraw(); }, onchange: () => { textEditing = null; store.touch(); } })),
        row('Tamaño', selectInput('lsize', [['2.5', 'Pequeño'], ['3.5', 'Normal'], ['5', 'Grande'], ['7', 'Título'], ['10', 'Muy grande']], String(l.size), v => edit(() => { l.size = parseFloat(v); }))),
        row('Rotación', numInput('lrot', l.rot, v => edit(() => { l.rot = ((v % 360) + 360) % 360; }), '°', 15)),
        h('div', { class: 'btn-row' }, btn('Duplicar', 'copy', () => ed.duplicate()), del),
      );
    }
    if (type === 'dim') {
      const d = lv.dims.find(x => x.id === id);
      if (!d) return section('Cota');
      return section('Cota',
        info('Medida', fmtLen(Math.hypot(d.x2 - d.x1, d.y2 - d.y1), u, true)),
        row('Separación', lenInput('doff', d.offset, v => edit(() => { d.offset = v; }), -1e6)),
        h('div', { class: 'btn-row' }, del),
        h('p', { class: 'hint' }, 'Arrastra la cota para separarla del muro.'),
      );
    }
    if (type === 'shape') {
      const s = lv.shapes.find(x => x.id === id);
      if (!s) return section('Línea');
      return section(s.kind === 'text' ? 'Texto importado' : 'Línea',
        info('Capa', s.layer || '—'),
        s.kind === 'poly' ? check('Línea de trazos', !!s.dash, v => edit(() => { s.dash = v; })) : null,
        s.kind === 'poly' && s.pts.length >= 6 ? check('Figura cerrada', !!s.closed, v => edit(() => { s.closed = v; })) : null,
        s.kind === 'poly' && s.group ? h('div', { class: 'btn-row' }, btn('Convertir el dibujo en muros', 'wall', convertSelectedShapes, 'btn-primary')) : null,
        h('div', { class: 'btn-row' }, btn('Duplicar', 'copy', () => ed.duplicate()), del),
      );
    }
    if (type === 'background' && lv.background) return backgroundSection();
    return section('');
  }

  function multi(): HTMLElement {
    const sel = store.selection, lv = store.level;
    const walls = sel.filter(s => s.type === 'wall').map(s => lv.walls.find(w => w.id === s.id)).filter(Boolean) as Wall[];
    const shapes = sel.filter(s => s.type === 'shape');
    const imported = shapes.length === sel.length && shapes.length > 1;
    return section(imported ? `Dibujo importado` : `${sel.length} elementos`,
      imported ? info('Elementos', String(shapes.length)) : null,
      imported ? h('p', { class: 'hint' }, 'Es un calco: puedes dibujar encima (el cursor se ajusta al eje de sus muros) o convertirlo en muros editables.') : null,
      imported ? h('div', { class: 'btn-row' }, btn('Convertir en muros', 'wall', convertSelectedShapes, 'btn-primary')) : null,
      walls.length === sel.length ? row('Grosor de todos', lenInput('mthick', walls[0].thickness, v => edit(() => { for (const w of walls) w.thickness = Math.min(1.5, v); }))) : null,
      h('div', { class: 'btn-row' },
        btn('Duplicar', 'copy', () => ed.duplicate()),
        btn('Eliminar', 'trash', () => ed.deleteSelection(), 'btn-danger-ghost')),
      h('p', { class: 'hint' }, 'Arrastra cualquiera para moverlos juntos. Mayús + clic agrega o quita de la selección.'),
    );
  }

  // ───────────── niveles ─────────────
  function levelsSection(): HTMLElement {
    const p = store.project;
    const list = h('div', { class: 'level-list' });
    p.levels.slice().reverse().forEach(lv => {
      const i = p.levels.indexOf(lv);
      list.append(h('div', { class: 'level' + (i === p.activeLevel ? ' active' : ''), onclick: () => { if (i !== p.activeLevel) { p.activeLevel = i; store.selection = []; store.touch(); store.emit('select'); ed.fit(); } } },
        h('span', { class: 'level-name' }, lv.name),
        h('button', { class: 'icon-btn', title: 'Opciones del nivel', onclick: (e: Event) => {
          e.stopPropagation();
          openMenu(e.currentTarget as HTMLElement, [
            { label: 'Cambiar nombre…', action: async () => { const n = await promptDialog('Nombre del nivel', lv.name); if (n && n.trim()) { lv.name = n.trim(); store.touch(); } } },
            { label: 'Altura sobre el suelo…', action: async () => { const n = await promptDialog('Altura del piso de este nivel', toUnit(lv.elevation, p.units), `En ${unitSuffix(p.units)}. Se usa en la vista 3D.`); const v = n ? parseLen(n, p.units) : null; if (v != null) { lv.elevation = v; store.touch(); } } },
            { sep: true },
            { label: 'Eliminar nivel', icon: 'trash', disabled: p.levels.length < 2, action: async () => {
              if (!(await confirmDialog('Eliminar nivel', `Se borrará "${lv.name}" con todo su contenido.`, 'Eliminar', true))) return;
              store.checkpoint(); p.levels.splice(i, 1); p.activeLevel = Math.min(p.activeLevel, p.levels.length - 1); store.selection = []; store.touch(); store.emit('select');
            } },
          ], 'right');
        } }, icon('chevron', 15)),
      ));
    });
    const add = (copy: boolean) => {
      const cur = store.level;
      const top = p.levels[p.levels.length - 1];
      const hgt = Math.max(p.settings.wallHeight, ...top.walls.map(w => w.height));
      const nl = newLevel(`Nivel ${p.levels.length + 1}`, top.elevation + hgt + 0.2);
      if (copy) {
        const map = new Map<ID, ID>();
        nl.nodes = cur.nodes.map(n => { const id = uid('n'); map.set(n.id, id); return { ...n, id }; });
        nl.walls = cur.walls.map(w => ({ ...w, id: uid('w'), a: map.get(w.a)!, b: map.get(w.b)! }));
      }
      store.checkpoint();
      p.levels.push(nl); p.activeLevel = p.levels.length - 1; store.selection = [];
      store.touch(); store.emit('select');
    };
    return section('Niveles', list,
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn btn-sm', onclick: (e: Event) => openMenu(e.currentTarget as HTMLElement, [
          { label: 'Nivel vacío', icon: 'plus', action: () => add(false) },
          { label: 'Copiar los muros de este nivel', icon: 'copy', action: () => add(true) },
        ]) }, icon('plus', 15), 'Agregar nivel')),
      p.levels.length > 1 ? h('p', { class: 'hint' }, 'El nivel de abajo se ve en gris como referencia.') : null,
    );
  }

  // ───────────── capas ─────────────
  function layersSection(): HTMLElement {
    const st = store.project.settings;
    const keys = store.advanced ? LAYERS : LAYERS.filter(l => ['items', 'dims', 'rooms', 'labels', 'grid', 'background', 'shapes'].includes(l.key));
    return section('Capas visibles', h('div', { class: 'layer-list' }, keys.map(l => {
      const on = st.layers[l.key];
      return h('button', { class: 'layer' + (on ? '' : ' off'), title: on ? 'Ocultar' : 'Mostrar', onclick: () => { st.layers[l.key] = !on; store.emit('view'); } }, icon(on ? 'eye' : 'eyeOff', 16), h('span', null, l.name));
    })));
  }

  // ───────────── resumen ─────────────
  function summarySection(lv: Level): HTMLElement {
    const u = store.project.units, d = store.derived();
    const total = d.rooms.reduce((s, r) => s + r.area, 0);
    let wallLen = 0;
    for (const g of d.geoms.values()) wallLen += g.len;
    if (!d.rooms.length) return section('Resumen', h('p', { class: 'hint' }, lv.walls.length ? 'Cierra un contorno de muros para que se forme un recinto y se calcule su superficie.' : 'Aún no hay muros en este nivel.'), lv.walls.length ? info('Largo total de muros', fmtLen(wallLen, u, true)) : null);
    let n = 0;
    const rows = d.rooms.slice().sort((a, b) => b.area - a.area).map(r => {
      n++;
      return h('button', { class: 'sum-row', onclick: () => store.select([{ type: 'room', id: r.key }]) }, h('span', null, r.meta?.name || `Recinto ${n}`), h('strong', null, fmtArea(r.area, u)));
    });
    return section('Cuadro de superficies', h('div', { class: 'sum-list' }, rows),
      h('div', { class: 'sum-total' }, h('span', null, 'Total útil'), h('strong', null, fmtArea(total, u))),
      info('Largo total de muros', fmtLen(wallLen, u, true)),
      info('Puertas / ventanas', `${lv.openings.filter(o => o.kind === 'door').length} / ${lv.openings.filter(o => o.kind === 'window').length}`));
  }

  render();
}
