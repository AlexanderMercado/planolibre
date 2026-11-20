// Operaciones de alto nivel sobre un proyecto, pensadas para que las use un
// agente (o un script) sin interfaz: se piden habitaciones, puertas o muebles
// y la topología (uniones, cruces, recintos) la resuelve el núcleo de la app.
//
// No dependen del navegador ni del sistema de archivos. Todas las medidas van
// en METROS, con X hacia la derecha e Y hacia ABAJO (como en pantalla): el
// "norte" del plano es Y menor.

import type { Label, Level, OpeningKind, OpeningStyle, Project, Units } from '../core/model';
import { newProject, uid } from '../core/model';
import { dist, dot, perp, pointInPoly, sub, unit } from '../core/geom';
import { addItem, addOpeningAt, nameRoomAt, nearestWall, OPENING_DEFAULTS } from '../core/ops';
import { SYMBOLS } from '../core/symbols';
import { roomTypeFromName } from '../core/themes';
import { addWall, computeRooms, levelBounds, nodeMap, removeWalls } from '../core/topology';

/** Error con un mensaje pensado para que el agente lo lea y corrija su llamada. */
export class ComandoError extends Error {}

const r2 = (v: number) => Math.round(v * 100) / 100;
const num = (v: unknown, nombre: string, min = -1e6, max = 1e6): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ComandoError(`"${nombre}" debe ser un número.`);
  if (v < min || v > max) throw new ComandoError(`"${nombre}" debe estar entre ${min} y ${max} (se recibió ${v}).`);
  return v;
};
const nivel = (p: Project): Level => p.levels[p.activeLevel];

// ───────────────────────── crear ─────────────────────────

export function crearPlano(o: { nombre?: string; unidades?: Units; escala?: number } = {}): Project {
  const p = newProject(o.nombre?.trim() || 'Plano sin título');
  if (o.unidades) p.units = o.unidades;
  if (o.escala) p.scale = num(o.escala, 'escala', 1, 5000);
  return p;
}

export interface HabitacionOpts {
  /** esquina superior izquierda */
  x: number; y: number;
  ancho: number; largo: number;
  nombre?: string;
  grosor?: number;
  /** 'interiores': x, y, ancho y largo son del espacio útil (por defecto). 'ejes': son de los ejes de los muros. */
  medidas?: 'interiores' | 'ejes';
}

/** Agrega una habitación rectangular completa (cuatro muros), unida a lo que ya exista. */
export function agregarHabitacion(p: Project, o: HabitacionOpts): { ejes: { x1: number; y1: number; x2: number; y2: number }; grosor: number } {
  const lv = nivel(p), st = p.settings;
  const t = o.grosor === undefined ? st.wallThickness : num(o.grosor, 'grosor', 0.03, 1.5);
  const w = num(o.ancho, 'ancho', 0.3, 500), h = num(o.largo, 'largo', 0.3, 500);
  const x = num(o.x, 'x'), y = num(o.y, 'y');
  const k = o.medidas === 'ejes' ? 0 : t / 2;
  const x1 = x - k, y1 = y - k, x2 = x + w + k, y2 = y + h + k;
  const c = [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }];
  for (let i = 0; i < 4; i++) addWall(lv, c[i], c[(i + 1) % 4], t, st.wallHeight);
  if (o.nombre?.trim()) nombrarRecinto(p, { x: (x1 + x2) / 2, y: (y1 + y2) / 2, nombre: o.nombre });
  return { ejes: { x1: r2(x1), y1: r2(y1), x2: r2(x2), y2: r2(y2) }, grosor: t };
}

export function agregarMuro(p: Project, o: { x1: number; y1: number; x2: number; y2: number; grosor?: number }): { largo: number } {
  const lv = nivel(p), st = p.settings;
  const a = { x: num(o.x1, 'x1'), y: num(o.y1, 'y1') }, b = { x: num(o.x2, 'x2'), y: num(o.y2, 'y2') };
  if (dist(a, b) < 0.05) throw new ComandoError('El muro es demasiado corto: sus dos puntos casi coinciden.');
  addWall(lv, a, b, o.grosor === undefined ? st.wallThickness : num(o.grosor, 'grosor', 0.03, 1.5), st.wallHeight);
  return { largo: r2(dist(a, b)) };
}

const TIPOS: Record<string, OpeningKind> = { puerta: 'door', ventana: 'window', vano: 'gap' };
const ESTILOS: Record<string, OpeningStyle> = { abatible: 'single', doble: 'double', corredera: 'sliding', fija: 'fixed' };

export interface AberturaOpts {
  tipo: 'puerta' | 'ventana' | 'vano';
  /** punto sobre el muro (o cerca de él) donde va el centro de la abertura */
  x: number; y: number;
  ancho?: number;
  estilo?: 'abatible' | 'doble' | 'corredera' | 'fija';
  /** puertas: un punto del lado hacia donde abre (por ejemplo, el centro del recinto) */
  abre_hacia?: { x: number; y: number };
  /** puertas: un punto cercano al extremo donde va la bisagra */
  bisagra_cerca_de?: { x: number; y: number };
}

/** Coloca una puerta, ventana o vano sobre el muro más cercano al punto dado. */
export function agregarAbertura(p: Project, o: AberturaOpts): { centro: { x: number; y: number }; ancho: number; largo_muro: number; distancia_a_extremos: [number, number] } {
  const lv = nivel(p);
  const kind = TIPOS[o.tipo];
  if (!kind) throw new ComandoError(`"tipo" debe ser puerta, ventana o vano.`);
  const pt = { x: num(o.x, 'x'), y: num(o.y, 'y') };
  const near = nearestWall(lv, pt, 0.6);
  if (!near) throw new ComandoError(`No hay ningún muro a menos de 60 cm de (${pt.x}, ${pt.y}). Usa "resumen" para ver dónde están los muros.`);
  const wall = lv.walls.find(w => w.id === near.id)!, nm = nodeMap(lv);
  const a = nm.get(wall.a)!, b = nm.get(wall.b)!, L = dist(a, b);
  const d = OPENING_DEFAULTS[kind];
  const width = o.ancho === undefined ? d.width : num(o.ancho, 'ancho', 0.3, 12);
  if (width > L - 0.1) throw new ComandoError(`La abertura de ${width} m no cabe: ese tramo de muro mide ${r2(L)} m.`);
  const style = o.estilo ? ESTILOS[o.estilo] : d.style;
  if (!style) throw new ComandoError('"estilo" debe ser abatible, doble, corredera o fija.');
  const made = addOpeningAt(lv, near.proj, kind, width, style);
  if (!made) throw new ComandoError('No se pudo colocar la abertura sobre ese muro.');
  const dir = unit(sub(b, a)), n = perp(dir);
  if (o.abre_hacia) made.flipV = dot(sub(o.abre_hacia, near.proj), n) < 0;
  if (o.bisagra_cerca_de) made.flipH = dot(sub(o.bisagra_cerca_de, near.proj), dir) > 0;
  const s = near.t * L;
  return { centro: { x: r2(near.proj.x), y: r2(near.proj.y) }, ancho: width, largo_muro: r2(L), distancia_a_extremos: [r2(s - width / 2), r2(L - s - width / 2)] };
}

/** Catálogo de muebles y símbolos disponibles. */
export function listarMuebles(): { tipo: string; nombre: string; categoria: string; ancho: number; fondo: number }[] {
  return SYMBOLS.map(s => ({ tipo: s.type, nombre: s.name, categoria: s.cat, ancho: s.w, fondo: s.h }));
}

export function agregarMueble(p: Project, o: { tipo: string; x: number; y: number; rotacion?: number; ancho?: number; fondo?: number }): { tipo: string; nombre: string; ancho: number; fondo: number } {
  const def = SYMBOLS.find(s => s.type === o.tipo);
  if (!def) throw new ComandoError(`No existe el mueble "${o.tipo}". Usa "listar_muebles" para ver los tipos válidos (por ejemplo: ${SYMBOLS.slice(0, 6).map(s => s.type).join(', ')}).`);
  const it = addItem(nivel(p), def.type, num(o.x, 'x'), num(o.y, 'y'), o.rotacion === undefined ? 0 : num(o.rotacion, 'rotacion', -360, 360),
    o.ancho === undefined ? undefined : num(o.ancho, 'ancho', 0.05, 30), o.fondo === undefined ? undefined : num(o.fondo, 'fondo', 0.05, 30));
  return { tipo: def.type, nombre: def.name, ancho: it.w, fondo: it.h };
}

/** Pone o cambia el nombre del recinto que contiene el punto. */
export function nombrarRecinto(p: Project, o: { x: number; y: number; nombre: string }): { nombre: string; superficie: number } {
  const lv = nivel(p), pt = { x: num(o.x, 'x'), y: num(o.y, 'y') };
  const nombre = (o.nombre || '').trim();
  if (!nombre) throw new ComandoError('"nombre" no puede estar vacío.');
  const room = computeRooms(lv).find(r => pointInPoly(pt, r.poly));
  if (!room) throw new ComandoError(`El punto (${pt.x}, ${pt.y}) no está dentro de ningún recinto cerrado.`);
  const meta = lv.rooms.find(m => pointInPoly(m, room.poly));
  if (meta) { meta.name = nombre; meta.type = roomTypeFromName(nombre); } else nameRoomAt(lv, room.center, nombre);
  return { nombre, superficie: r2(room.area) };
}

export function agregarTexto(p: Project, o: { x: number; y: number; texto: string; tamano_mm?: number; rotacion?: number }): { texto: string } {
  const texto = (o.texto || '').trim();
  if (!texto) throw new ComandoError('"texto" no puede estar vacío.');
  const l: Label = { id: uid('t'), x: num(o.x, 'x'), y: num(o.y, 'y'), text: texto, size: o.tamano_mm === undefined ? 3.5 : num(o.tamano_mm, 'tamano_mm', 1, 50), rot: o.rotacion === undefined ? 0 : num(o.rotacion, 'rotacion', -360, 360) };
  nivel(p).labels.push(l);
  return { texto };
}

// ───────────────────────── eliminar ─────────────────────────

/** Elimina el elemento del tipo indicado más cercano al punto. */
export function eliminar(p: Project, o: { tipo: 'muro' | 'abertura' | 'mueble' | 'texto'; x: number; y: number }): { eliminado: string } {
  const lv = nivel(p), pt = { x: num(o.x, 'x'), y: num(o.y, 'y') };
  if (o.tipo === 'muro') {
    const near = nearestWall(lv, pt, 0.4);
    if (!near) throw new ComandoError(`No hay ningún muro a menos de 40 cm de (${pt.x}, ${pt.y}).`);
    removeWalls(lv, [near.id]);
    return { eliminado: 'muro' };
  }
  if (o.tipo === 'abertura') {
    const nm = nodeMap(lv);
    let best: { id: string; d: number; kind: string } | null = null;
    for (const op of lv.openings) {
      const w = lv.walls.find(x => x.id === op.wall); if (!w) continue;
      const a = nm.get(w.a)!, b = nm.get(w.b)!;
      const c = { x: a.x + (b.x - a.x) * op.t, y: a.y + (b.y - a.y) * op.t }, d = dist(c, pt);
      if (d < Math.max(0.6, op.width / 2) && (!best || d < best.d)) best = { id: op.id, d, kind: op.kind };
    }
    if (!best) throw new ComandoError(`No hay ninguna puerta, ventana o vano cerca de (${pt.x}, ${pt.y}).`);
    const id = best.id; lv.openings = lv.openings.filter(x => x.id !== id);
    return { eliminado: best.kind === 'door' ? 'puerta' : best.kind === 'window' ? 'ventana' : 'vano' };
  }
  if (o.tipo === 'mueble') {
    let best: { id: string; d: number; type: string } | null = null;
    for (const it of lv.items) { const d = dist(it, pt); if (d < Math.max(0.6, Math.max(it.w, it.h) / 2) && (!best || d < best.d)) best = { id: it.id, d, type: it.type }; }
    if (!best) throw new ComandoError(`No hay ningún mueble cerca de (${pt.x}, ${pt.y}).`);
    const id = best.id; lv.items = lv.items.filter(x => x.id !== id);
    return { eliminado: best.type };
  }
  if (o.tipo === 'texto') {
    let best: { id: string; d: number } | null = null;
    for (const l of lv.labels) { const d = dist(l, pt); if (d < 1 && (!best || d < best.d)) best = { id: l.id, d }; }
    if (!best) throw new ComandoError(`No hay ningún texto a menos de 1 m de (${pt.x}, ${pt.y}).`);
    const id = best.id; lv.labels = lv.labels.filter(x => x.id !== id);
    return { eliminado: 'texto' };
  }
  throw new ComandoError('"tipo" debe ser muro, abertura, mueble o texto.');
}

// ───────────────────────── resumen ─────────────────────────

export interface Resumen {
  nombre: string; unidades: Units; escala: number; nivel: string;
  limites: { x1: number; y1: number; x2: number; y2: number; ancho: number; largo: number } | null;
  superficie_util_total: number;
  recintos: { nombre: string | null; superficie: number; perimetro: number; ancho_interior: number; largo_interior: number; centro: { x: number; y: number } }[];
  muros: { cantidad: number; largo_total: number; grosores: number[] };
  aberturas: { tipo: string; estilo: string; ancho: number; x: number; y: number }[];
  muebles: { tipo: string; x: number; y: number; rotacion: number }[];
  textos: number;
  calco: number;
  advertencias: string[];
}

const KIND_ES: Record<string, string> = { door: 'puerta', window: 'ventana', gap: 'vano' };
const STYLE_ES: Record<string, string> = { single: 'abatible', double: 'doble', sliding: 'corredera', fixed: 'fija' };

/** Estado del plano en datos: lo que un agente necesita para comprobar su trabajo. */
export function resumen(p: Project): Resumen {
  const lv = nivel(p), nm = nodeMap(lv), rooms = computeRooms(lv), b = levelBounds(lv);
  const adv: string[] = [];
  const grado = new Map<string, number>();
  let largo = 0;
  for (const w of lv.walls) {
    grado.set(w.a, (grado.get(w.a) || 0) + 1); grado.set(w.b, (grado.get(w.b) || 0) + 1);
    const a = nm.get(w.a), c = nm.get(w.b); if (a && c) largo += dist(a, c);
  }
  const sueltos = lv.nodes.filter(n => grado.get(n.id) === 1);
  if (sueltos.length) adv.push(`Hay ${sueltos.length} extremo(s) de muro sin unir, en ${sueltos.slice(0, 6).map(n => `(${r2(n.x)}, ${r2(n.y)})`).join(', ')}: ahí los recintos no cierran.`);
  if (lv.walls.length && !rooms.length) adv.push('Hay muros pero ningún recinto cerrado: no se puede calcular superficie.');
  const sinNombre = rooms.filter(r => !r.meta).length;
  if (sinNombre) adv.push(`${sinNombre} recinto(s) no tienen nombre.`);
  if (rooms.length) {
    const fuera = lv.items.filter(it => !rooms.some(r => pointInPoly(it, r.poly)));
    if (fuera.length) adv.push(`${fuera.length} mueble(s) quedaron fuera de todo recinto: ${fuera.slice(0, 5).map(it => `${it.type} en (${r2(it.x)}, ${r2(it.y)})`).join(', ')}.`);
  }
  const aberturas = lv.openings.map(op => {
    const w = lv.walls.find(x => x.id === op.wall)!, a = nm.get(w.a)!, c = nm.get(w.b)!;
    if (op.width > dist(a, c) - 0.05) adv.push(`Una ${KIND_ES[op.kind]} de ${op.width} m no cabe en su muro de ${r2(dist(a, c))} m.`);
    return { tipo: KIND_ES[op.kind], estilo: STYLE_ES[op.style] || op.style, ancho: r2(op.width), x: r2(a.x + (c.x - a.x) * op.t), y: r2(a.y + (c.y - a.y) * op.t) };
  });
  const conPuerta = aberturas.some(a => a.tipo !== 'ventana');
  if (rooms.length && !conPuerta) adv.push('Ningún recinto tiene puerta ni vano.');
  return {
    nombre: p.name, unidades: p.units, escala: p.scale, nivel: lv.name,
    limites: b ? { x1: r2(b.minX), y1: r2(b.minY), x2: r2(b.maxX), y2: r2(b.maxY), ancho: r2(b.maxX - b.minX), largo: r2(b.maxY - b.minY) } : null,
    superficie_util_total: r2(rooms.reduce((s, r) => s + r.area, 0)),
    recintos: rooms.map(r => {
      const xs = r.inner.map(q => q.x), ys = r.inner.map(q => q.y);
      return { nombre: r.meta?.name || null, superficie: r2(r.area), perimetro: r2(r.perimeter), ancho_interior: r2(Math.max(...xs) - Math.min(...xs)), largo_interior: r2(Math.max(...ys) - Math.min(...ys)), centro: { x: r2(r.center.x), y: r2(r.center.y) } };
    }),
    muros: { cantidad: lv.walls.length, largo_total: r2(largo), grosores: [...new Set(lv.walls.map(w => w.thickness))].sort() },
    aberturas,
    muebles: lv.items.map(it => ({ tipo: it.type, x: r2(it.x), y: r2(it.y), rotacion: it.rot })),
    textos: lv.labels.length,
    calco: lv.shapes.length,
    advertencias: adv,
  };
}
