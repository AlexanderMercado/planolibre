import type { Project } from '../core/model';
import { buildScene, primsBounds } from '../core/scene';
import { THEMES } from '../core/themes';
import { fmtLen } from '../core/units';
import { PAPERS, SCALES, resolveScale, type PdfOpts } from '../io/pdf';
import type { LocalEntry } from '../io/storage';
import { h, icon, modal } from './dom';

const opt = (v: string, l: string, sel = false) => h('option', { value: v, selected: sel }, l);
const field = (label: string, control: Node) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control);

// ───────────── Exportar PDF ─────────────

export async function pdfDialog(project: Project, viewTheme: 'tech' | 'color' | 'blue'): Promise<PdfOpts | null> {
  const level = project.levels[project.activeLevel];
  const saved = (() => { try { return JSON.parse(localStorage.getItem('planolibre:pdf') || '{}'); } catch { return {}; } })();
  const o: PdfOpts = { paper: 'A4', landscape: true, titleBlock: true, allLevels: false, includeBackground: false, schedule: false, ...saved, scale: 'fit', theme: viewTheme };
  if (!PAPERS[o.paper]) o.paper = 'A4';
  // se propone la escala del plano si cabe en la hoja; si no, la mayor que quepa
  if (resolveScale(project, level, o) <= project.scale) o.scale = project.scale;
  const note = h('div', { class: 'note' });
  const update = () => {
    const s = resolveScale(project, level, o);
    const st = project.settings;
    const b = primsBounds(buildScene(level, { theme: THEMES[o.theme], annot: s / 1000, units: project.units, layers: st.layers, showRoomDims: st.showRoomDims, showAreas: st.showAreas, showOverallDims: st.showOverallDims }));
    const [pa, pb] = PAPERS[o.paper];
    const pw = o.landscape ? Math.max(pa, pb) : Math.min(pa, pb), ph = o.landscape ? Math.min(pa, pb) : Math.max(pa, pb);
    const aw = pw - 26, ah = ph - 26 - (o.titleBlock ? 20 : 0);
    if (!b) { note.className = 'note'; note.textContent = 'El plano está vacío.'; return; }
    const w = ((b.maxX - b.minX) * 1000) / s, hh = ((b.maxY - b.minY) * 1000) / s;
    const fits = w <= aw && hh <= ah;
    note.className = 'note ' + (fits ? 'note-ok' : 'note-warn');
    note.textContent = o.scale === 'fit'
      ? `Se usará escala 1:${s}, la más grande que cabe en ${o.paper}. El dibujo ocupará ${Math.round(w)} × ${Math.round(hh)} mm.`
      : fits ? `A escala 1:${s} el dibujo ocupa ${Math.round(w)} × ${Math.round(hh)} mm y cabe en la hoja.`
        : `A escala 1:${s} el dibujo mide ${Math.round(w)} × ${Math.round(hh)} mm y NO cabe en ${o.paper} (${Math.round(aw)} × ${Math.round(ah)} mm útiles). Elige una hoja más grande, otra escala o "Ajustar".`;
  };
  const sel = (options: Node[], on: (v: string) => void) => { const s = h('select', { class: 'input', onchange: () => { on(s.value); update(); } }, options); return s; };
  const chk = (label: string, key: keyof PdfOpts) => { const i = h('input', { type: 'checkbox', checked: !!o[key], onchange: () => { (o as any)[key] = i.checked; update(); } }); return h('label', { class: 'check' }, i, h('span', null, label)); };
  const body = h('div', { class: 'form-grid' },
    field('Tamaño de hoja', sel(Object.keys(PAPERS).map(p => opt(p, `${p}  (${Math.round(PAPERS[p][0])} × ${Math.round(PAPERS[p][1])} mm)`, p === o.paper)), v => { o.paper = v; })),
    field('Orientación', sel([opt('h', 'Horizontal', o.landscape), opt('v', 'Vertical', !o.landscape)], v => { o.landscape = v === 'h'; })),
    field('Escala', sel([opt('fit', 'Ajustar automáticamente', o.scale === 'fit'), ...SCALES.map(s => opt(String(s), `1:${s}`, o.scale === s))], v => { o.scale = v === 'fit' ? 'fit' : parseInt(v, 10); })),
    field('Estilo', sel([opt('tech', 'Técnico (blanco y negro)', o.theme === 'tech'), opt('color', 'Color', o.theme === 'color'), opt('blue', 'Blueprint', o.theme === 'blue')], v => { o.theme = v as PdfOpts['theme']; })),
    h('div', { class: 'form-wide stack' },
      chk('Cajetín con nombre, escala, fecha y superficie', 'titleBlock'),
      chk('Agregar página con cuadro de superficies', 'schedule'),
      project.levels.length > 1 ? chk(`Incluir todos los niveles (${project.levels.length} páginas)`, 'allLevels') : null,
      level.background ? chk('Incluir la imagen de fondo', 'includeBackground') : null,
      note),
  );
  update();
  const ok = await modal('Exportar a PDF', body, [{ label: 'Cancelar', value: false }, { label: 'Descargar PDF', primary: true, value: true }]);
  if (!ok) return null;
  try { localStorage.setItem('planolibre:pdf', JSON.stringify({ paper: o.paper, landscape: o.landscape, titleBlock: o.titleBlock, schedule: o.schedule })); } catch { /* ignore */ }
  return o;
}

// ───────────── Exportar DXF / DWG ─────────────

export async function dxfDialog(): Promise<number | null> {
  let unit = 1;
  const s = h('select', { class: 'input', onchange: () => { unit = parseFloat(s.value); } }, opt('1', 'Metros'), opt('100', 'Centímetros'), opt('1000', 'Milímetros'));
  const body = h('div', { class: 'stack' },
    h('p', null, 'DXF es el formato de intercambio de AutoCAD. Lo abren directamente AutoCAD, BricsCAD, ZWCAD, LibreCAD, QCAD, Revit, SketchUp e Illustrator, con sus capas (MUROS, PUERTAS, VENTANAS, COTAS…).'),
    field('Unidad del dibujo', s),
    h('div', { class: 'note' }, h('strong', null, '¿Necesitas .dwg? '), 'DWG es un formato cerrado de Autodesk y no existe una forma libre y confiable de escribirlo desde el navegador. Abre este DXF en AutoCAD (o en el conversor gratuito ODA File Converter) y usa "Guardar como DWG": el resultado es idéntico.'),
  );
  const ok = await modal('Exportar para AutoCAD (DXF)', body, [{ label: 'Cancelar', value: false }, { label: 'Descargar DXF', primary: true, value: true }]);
  return ok ? unit : null;
}

// ───────────── Importar DXF / DWG ─────────────

export interface CadImportChoice { factor: number; mode: 'walls' | 'trace' | 'view'; layers: Set<string> | null; keepRest: boolean }
export interface WallPreview { walls: number; doors: number; windows: number; gaps?: number; named?: number }

/** Texto corto con lo que se reconoció: "12 muros, 3 puertas y 4 ventanas". */
export function describeDetection(p: WallPreview): string {
  const n = (v: number, one: string, many: string) => `${v} ${v === 1 ? one : many}`;
  const parts = [n(p.walls, 'muro', 'muros')];
  if (p.doors) parts.push(n(p.doors, 'puerta', 'puertas'));
  if (p.windows) parts.push(n(p.windows, 'ventana', 'ventanas'));
  if (p.gaps) parts.push(n(p.gaps, 'vano', 'vanos'));
  if (p.named) parts.push(n(p.named, 'recinto con nombre', 'recintos con nombre'));
  return parts.length > 1 ? parts.slice(0, -1).join(', ') + ' y ' + parts[parts.length - 1] : parts[0];
}

export async function cadImportDialog(
  name: string, size: { w: number; h: number }, guess: number, count: number, declared: boolean,
  layers: string[], autoLayers: Set<string> | null, preview: (factor: number, layers: Set<string> | null) => WallPreview,
): Promise<CadImportChoice | null> {
  let factor = guess, mode: 'walls' | 'trace' | 'view' = 'walls', keepRest = true;
  // null = automático (las capas que se llaman "muros" o, si no hay, todas)
  let chosen: Set<string> | null = null;
  const units: [number, string][] = [[0.001, 'Milímetros'], [0.01, 'Centímetros'], [1, 'Metros'], [0.0254, 'Pulgadas'], [0.3048, 'Pies']];
  const result = h('div', { class: 'note note-ok' });
  const found = h('span', { class: 'muted' });
  let first = true;
  const radio = (v: 'walls' | 'trace' | 'view', label: string, desc: Node | string) => {
    const i = h('input', { type: 'radio', name: 'cadmode', value: v, checked: v === mode, onchange: () => { mode = v; } });
    return { input: i, el: h('label', { class: 'radio-card' }, i, h('div', null, h('strong', null, label), typeof desc === 'string' ? h('span', { class: 'muted' }, desc) : desc)) };
  };
  const rWalls = radio('walls', 'Muros editables', found);
  const rTrace = radio('trace', 'Sólo calco', 'Queda como dibujo de referencia: no se puede editar, pero puedes dibujar encima y el cursor se ajusta a sus líneas.');
  const rView = radio('view', 'Sólo ver e imprimir', 'Abre el dibujo tal cual en un visor aparte, sin mezclarlo con tu plano (que queda guardado en Mis proyectos). Puedes medir, ocultar capas e imprimirlo a escala en varias hojas.');
  const upd = () => {
    result.textContent = `Con esa unidad, el dibujo mide ${fmtLen(size.w * factor, 'm', true)} × ${fmtLen(size.h * factor, 'm', true)}.`;
    let p: WallPreview = { walls: 0, doors: 0, windows: 0 };
    try { p = preview(factor, chosen); } catch (e) { console.error(e); }
    found.textContent = p.walls
      ? `Se reconocen ${describeDetection(p)}. Quedan listos para mover, medir y calcular superficies.`
      : 'No se reconocen muros con estas opciones (se buscan dos líneas paralelas separadas entre 5 y 45 cm). Revisa la unidad o las capas.';
    // la primera vez se propone lo que tiene sentido; después manda lo que elija la persona
    if (first) { mode = p.walls ? 'walls' : 'trace'; rWalls.input.checked = mode === 'walls'; rTrace.input.checked = mode === 'trace'; first = false; }
  };
  const s = h('select', { class: 'input', onchange: () => { factor = parseFloat(s.value); upd(); } }, units.map(([f, l]) => opt(String(f), l, Math.abs(f - guess) < 1e-9)));
  const layerBox = h('div', { class: 'layer-pick' });
  if (layers.length > 1) for (const l of layers) {
    const i = h('input', { type: 'checkbox', checked: autoLayers ? autoLayers.has(l) : true, onchange: () => {
      chosen = new Set([...layerBox.querySelectorAll('input')].filter(x => (x as HTMLInputElement).checked).map(x => (x as HTMLInputElement).value));
      upd();
    } });
    i.value = l;
    layerBox.append(h('label', { class: 'check' }, i, h('span', null, l)));
  }
  const keep = h('input', { type: 'checkbox', checked: true, onchange: () => { keepRest = keep.checked; } });
  const more = h('details', { class: 'more' },
    h('summary', null, 'Opciones de reconocimiento'),
    h('label', { class: 'check' }, keep, h('span', null, 'Conservar como calco lo que no sea muro (muebles, textos, ejes…)')),
    layers.length > 1 ? h('p', { class: 'muted' }, 'Capas donde buscar muros:') : null,
    layers.length > 1 ? layerBox : null,
  );
  upd();
  const body = h('div', { class: 'stack' },
    h('p', null, `"${name}" tiene ${count.toLocaleString('es')} elementos.`),
    field(declared ? 'Unidad del dibujo (detectada del archivo)' : 'Unidad del dibujo (estimada: revisa que el tamaño sea razonable)', s),
    result,
    h('p', { class: 'field-label' }, '¿Cómo lo quieres cargar?'),
    rWalls.el, rTrace.el, rView.el, more,
  );
  const ok = await modal('Importar dibujo CAD', body, [{ label: 'Cancelar', value: false }, { label: 'Importar', primary: true, value: true }]);
  return ok ? { factor, mode, layers: chosen, keepRest } : null;
}

// ───────────── Importar imagen / PDF de fondo ─────────────

export async function backgroundDialog(kind: 'image' | 'pdf', pages = 1, vector = false): Promise<{ scale: number | null; page: number; detect: boolean } | null> {
  // un PDF vectorial se reconoce bien; con imágenes es experimental y no se propone por defecto
  let mode = 'calibrate', scale = 100, page = 1, detect = vector;
  const scaleSel = h('select', { class: 'input', disabled: true, onchange: () => { scale = parseInt(scaleSel.value, 10); } }, SCALES.map(s => opt(String(s), `1:${s}`, s === 100)));
  const radio = (v: string, label: string, desc: string) => {
    const i = h('input', { type: 'radio', name: 'bgmode', value: v, checked: v === mode, onchange: () => { mode = v; scaleSel.disabled = mode !== 'scale'; } });
    return h('label', { class: 'radio-card' }, i, h('div', null, h('strong', null, label), h('span', { class: 'muted' }, desc)));
  };
  const load = (v: boolean, label: string, desc: string) => {
    const i = h('input', { type: 'radio', name: 'bgload', checked: v === detect, onchange: () => { detect = v; } });
    return h('label', { class: 'radio-card' }, i, h('div', null, h('strong', null, label), h('span', { class: 'muted' }, desc)));
  };
  const pageInp = h('input', { class: 'input', type: 'number', min: '1', max: String(pages), value: '1', onchange: () => { page = Math.max(1, Math.min(pages, parseInt(pageInp.value, 10) || 1)); } });
  const body = h('div', { class: 'stack' },
    h('p', null, kind === 'pdf' ? 'El PDF se coloca como fondo del plano, a su tamaño real.' : 'La imagen (foto, escaneo o captura) se coloca como fondo del plano, a su tamaño real.'),
    kind === 'pdf' && pages > 1 ? field(`Página (1 a ${pages})`, pageInp) : null,
    h('p', { class: 'field-label' }, '¿Cómo sabemos su tamaño real?'),
    radio('calibrate', 'Calibrar con una medida conocida (recomendado)', 'Marcas dos puntos sobre la imagen y escribes cuánto miden en la realidad.'),
    kind === 'pdf' ? radio('scale', 'Conozco la escala del PDF', 'Si el plano fue impreso a una escala exacta, se dimensiona solo.') : null,
    kind === 'pdf' ? field('Escala del PDF', scaleSel) : null,
    h('p', { class: 'field-label' }, '¿Cómo lo quieres cargar?'),
    load(true, 'Muros editables', kind === 'pdf' && vector
      ? 'Este PDF trae el dibujo como líneas: se reconocen los muros, puertas y ventanas y quedan listos para editar. El PDF queda debajo como calco.'
      : 'Experimental: intenta reconocer los muros en la imagen. Funciona con planos limpios, derechos y con muros bien marcados; revisa el resultado. La imagen queda debajo como calco.'),
    load(false, 'Sólo calco', 'Queda como imagen de fondo para que dibujes los muros encima. Puedes reconocer los muros más tarde desde el panel de la imagen.'),
  );
  const ok = await modal(kind === 'pdf' ? 'Importar PDF' : 'Importar imagen', body, [{ label: 'Cancelar', value: false }, { label: 'Colocar', primary: true, value: true }]);
  return ok ? { scale: mode === 'scale' ? scale : null, page, detect } : null;
}

// ───────────── Proyectos locales ─────────────

function projectList(entries: LocalEntry[], onOpen: (id: string) => void, onDelete?: (id: string) => Promise<boolean>): HTMLElement {
  if (!entries.length) return h('p', { class: 'muted' }, 'Todavía no hay proyectos guardados en este navegador.');
  const list = h('div', { class: 'proj-list' });
  for (const e of entries) {
    const rowEl = h('div', { class: 'proj' },
      h('button', { class: 'proj-main', onclick: () => onOpen(e.id) },
        icon('file', 18),
        h('div', null, h('strong', null, e.name || 'Sin título'), h('span', { class: 'muted' }, `${new Date(e.modified).toLocaleString('es-CL', { dateStyle: 'medium', timeStyle: 'short' })} · ${e.walls} muros${e.levels > 1 ? ` · ${e.levels} niveles` : ''}`))),
      onDelete ? h('button', { class: 'icon-btn', title: 'Eliminar proyecto', onclick: async () => { if (await onDelete(e.id)) rowEl.remove(); } }, icon('trash', 16)) : null);
    list.append(rowEl);
  }
  return list;
}

export function projectsDialog(entries: LocalEntry[], onDelete: (id: string) => Promise<boolean>): Promise<string | null> {
  return new Promise(resolve => {
    let chosen: string | null = null;
    const body = h('div', { class: 'stack' },
      h('p', { class: 'muted' }, 'Tus planos se guardan solos en este navegador. Para llevarlos a otro computador o respaldarlos, usa Archivo → Guardar como archivo.'),
      projectList(entries, id => { chosen = id; (document.querySelector('.modal-backdrop .modal-head .icon-btn') as HTMLElement)?.click(); }, onDelete));
    modal('Mis proyectos', body, [{ label: 'Cerrar', value: null }], { wide: true }).then(() => resolve(chosen));
  });
}

export type WelcomeChoice = { kind: 'blank' | 'sample' | 'open' } | { kind: 'project'; id: string } | null;

export function welcomeDialog(entries: LocalEntry[]): Promise<WelcomeChoice> {
  return new Promise(resolve => {
    let choice: WelcomeChoice = null;
    const pick = (c: WelcomeChoice) => { choice = c; (document.querySelector('.modal-backdrop .modal-head .icon-btn') as HTMLElement)?.click(); };
    const card = (ic: string, title: string, desc: string, c: WelcomeChoice) => h('button', { class: 'start-card', onclick: () => pick(c) }, icon(ic, 26), h('strong', null, title), h('span', { class: 'muted' }, desc));
    const body = h('div', { class: 'stack' },
      h('p', { class: 'lead' }, 'Dibuja planos a escala arrastrando puntos y muros. Las medidas y superficies se calculan solas.'),
      h('div', { class: 'start-grid' },
        card('plus', 'Plano en blanco', 'Empieza desde cero', { kind: 'blank' }),
        card('spark', 'Ver un ejemplo', 'Departamento de 2 dormitorios para explorar', { kind: 'sample' }),
        card('folder', 'Abrir archivo', '.plano, DXF, DWG, PDF o imagen', { kind: 'open' })),
      entries.length ? h('h3', { class: 'sub' }, 'Continuar con un proyecto') : null,
      entries.length ? projectList(entries.slice(0, 5), id => pick({ kind: 'project', id })) : null,
      h('p', { class: 'muted small' }, 'PlanoLibre es software libre y funciona 100% en tu computador: nada se sube a internet.'),
    );
    modal('Bienvenido a PlanoLibre', body, [], { wide: true }).then(() => resolve(choice));
  });
}

// ───────────── Ayuda ─────────────

export function helpDialog() {
  const k = (keys: string, what: string) => h('div', { class: 'key-row' }, h('span', null, keys.split(' ').map(x => (x === '/' || x === '+' ? x : h('kbd', null, x)))), h('span', null, what));
  const body = h('div', { class: 'help-grid' },
    h('div', null,
      h('h3', { class: 'sub' }, 'Cómo se usa'),
      h('ol', { class: 'steps' },
        h('li', null, h('strong', null, 'Habitación: '), 'arrastra un rectángulo y ya tienes cuatro muros con su superficie.'),
        h('li', null, h('strong', null, 'Muro: '), 'haz clic punto a punto. Escribe un número y Enter para un largo exacto.'),
        h('li', null, h('strong', null, 'Arrastra '), 'cualquier punto o muro: las medidas y áreas se recalculan al instante.'),
        h('li', null, h('strong', null, 'Puertas y ventanas: '), 'acércalas a un muro y haz clic.'),
        h('li', null, h('strong', null, 'Nombra los recintos '), 'haciendo doble clic dentro de ellos.'),
        h('li', null, h('strong', null, 'Exporta '), 'a PDF a escala, DXF para AutoCAD, PNG o SVG.')),
      h('h3', { class: 'sub' }, 'Modo avanzado'),
      h('p', { class: 'muted' }, 'Activa "Avanzado" arriba a la derecha para ver cotas manuales, líneas libres, vanos, coordenadas exactas, todas las capas, altura de muros y opciones de ajuste.')),
    h('div', null,
      h('h3', { class: 'sub' }, 'Atajos de teclado'),
      k('V', 'Seleccionar'), k('M', 'Muro'), k('H', 'Habitación'), k('P', 'Puerta'), k('N', 'Ventana'), k('T', 'Texto'), k('D', 'Medir distancia'),
      k('C / L', 'Cota / Línea (avanzado)'), k('R', 'Girar mueble 90°'), k('F', 'Encuadrar todo'),
      k('Supr', 'Borrar selección'), k('Ctrl + Z / Y', 'Deshacer / Rehacer'), k('Ctrl + C / V / D', 'Copiar / Pegar / Duplicar'),
      k('Mayús', 'Forzar ángulos de 45° · sumar a la selección'), k('Alt', 'Desactivar el ajuste automático'),
      k('Espacio', 'Mover la vista arrastrando'), k('Esc', 'Terminar o cancelar')),
  );
  modal('Ayuda', body, [{ label: 'Entendido', primary: true, value: true }], { wide: true });
}
