// Operaciones de alto nivel sobre un proyecto, pensadas para que las use un
// agente (o un script) sin interfaz: se piden habitaciones, puertas o muebles
// y la topología (uniones, cruces, recintos) la resuelve el núcleo de la app.
//
// No dependen del navegador ni del sistema de archivos. Todas las medidas van
// en METROS, con X hacia la derecha e Y hacia ABAJO (como en pantalla): el
// "norte" del plano es Y menor.

import type { Item, Label, Level, OpeningKind, OpeningStyle, Project, Pt, Units } from '../core/model';
import { newProject, uid } from '../core/model';
import { dist, dot, perp, pointInPoly, sub, unit } from '../core/geom';
import { addItem, addOpeningAt, nameRoomAt, nearestWall, OPENING_DEFAULTS } from '../core/ops';
import { SYMBOLS } from '../core/symbols';
import { itemCorners } from '../core/scene';
import { roomTypeFromName } from '../core/themes';
import { addWall, computeRooms, levelBounds, nodeMap, openingFrames, removeWalls, wallGeoms, type Room } from '../core/topology';

/** Error con un mensaje pensado para que el agente lo lea y corrija su llamada. */
export class ComandoError extends Error {}

const r2 = (v: number) => Math.round(v * 100) / 100;
/** coordenadas: al milímetro, para que se puedan reutilizar sin perder el eje del muro */
const r3 = (v: number) => Math.round(v * 1000) / 1000;
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
  return { ejes: { x1: r3(x1), y1: r3(y1), x2: r3(x2), y2: r3(y2) }, grosor: t };
}

export function agregarMuro(p: Project, o: { x1: number; y1: number; x2: number; y2: number; grosor?: number }): { largo: number } {
  const lv = nivel(p), st = p.settings;
  const a = { x: num(o.x1, 'x1'), y: num(o.y1, 'y1') }, b = { x: num(o.x2, 'x2'), y: num(o.y2, 'y2') };
  if (dist(a, b) < 0.05) throw new ComandoError('El muro es demasiado corto: sus dos puntos casi coinciden.');
  addWall(lv, a, b, o.grosor === undefined ? st.wallThickness : num(o.grosor, 'grosor', 0.03, 1.5), st.wallHeight);
  return { largo: r3(dist(a, b)) };
}

const TIPOS: Record<string, OpeningKind> = { puerta: 'door', ventana: 'window', vano: 'gap' };
const ESTILOS: Record<string, OpeningStyle> = { abatible: 'single', doble: 'double', corredera: 'sliding', fija: 'fixed' };

export type Lado = 'norte' | 'sur' | 'este' | 'oeste';

export interface AberturaOpts {
  tipo: 'puerta' | 'ventana' | 'vano';
  /** opción 1: punto sobre el muro (o cerca de él) donde va el centro de la abertura */
  x?: number; y?: number;
  /** opción 2: nombre del recinto y el lado en que va, sin calcular coordenadas */
  recinto?: string; lado?: Lado;
  /** con recinto + lado: posición a lo largo de ese lado, de 0 a 1 (0,5 = centrada). Se mide desde el oeste o desde el norte. */
  posicion?: number;
  ancho?: number;
  estilo?: 'abatible' | 'doble' | 'corredera' | 'fija';
  /** puertas: un punto del lado hacia donde abre. Con recinto + lado, por defecto abre hacia dentro de ese recinto. */
  abre_hacia?: { x: number; y: number };
  /** puertas: un punto cercano al extremo donde va la bisagra */
  bisagra_cerca_de?: { x: number; y: number };
}

const plano = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

/** Busca un recinto por su nombre (sin distinguir mayúsculas ni acentos). */
function recintoPorNombre(lv: Level, nombre: string): Room {
  const rooms = computeRooms(lv), q = plano(nombre);
  const exact = rooms.filter(r => r.meta && plano(r.meta.name) === q);
  const hits = exact.length ? exact : rooms.filter(r => r.meta && plano(r.meta.name).includes(q));
  const nombres = rooms.map(r => r.meta?.name).filter(Boolean).join(', ') || '(ninguno tiene nombre)';
  if (!hits.length) throw new ComandoError(`No hay ningún recinto llamado "${nombre}". Recintos: ${nombres}.`);
  if (hits.length > 1) throw new ComandoError(`Hay ${hits.length} recintos que coinciden con "${nombre}": ${hits.map(r => r.meta!.name).join(', ')}. Usa el nombre exacto o da un punto (x, y).`);
  return hits[0];
}

/** Coloca una puerta, ventana o vano sobre un muro: por un punto, o por recinto y lado. */
export function agregarAbertura(p: Project, o: AberturaOpts): { centro: { x: number; y: number }; ancho: number; largo_muro: number; distancia_a_extremos: [number, number] } {
  const lv = nivel(p);
  const kind = TIPOS[o.tipo];
  if (!kind) throw new ComandoError(`"tipo" debe ser puerta, ventana o vano.`);
  let pt: Pt, hacia = o.abre_hacia;
  if (o.recinto !== undefined || o.lado !== undefined) {
    if (!o.recinto || !o.lado) throw new ComandoError('Para ubicar por recinto se necesitan "recinto" y "lado" (norte, sur, este u oeste).');
    const room = recintoPorNombre(lv, o.recinto);
    const xs = room.inner.map(q => q.x), ys = room.inner.map(q => q.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const f = o.posicion === undefined ? 0.5 : num(o.posicion, 'posicion', 0, 1);
    // un punto apenas afuera de la cara interior de ese lado: el muro más cercano es el de ese lado
    const e = 0.02;
    if (o.lado === 'norte') pt = { x: x0 + (x1 - x0) * f, y: y0 - e };
    else if (o.lado === 'sur') pt = { x: x0 + (x1 - x0) * f, y: y1 + e };
    else if (o.lado === 'oeste') pt = { x: x0 - e, y: y0 + (y1 - y0) * f };
    else if (o.lado === 'este') pt = { x: x1 + e, y: y0 + (y1 - y0) * f };
    else throw new ComandoError('"lado" debe ser norte, sur, este u oeste.');
    if (!hacia && kind === 'door') hacia = room.center;
  } else {
    if (o.x === undefined || o.y === undefined) throw new ComandoError('Indica dónde va: un punto (x, y) sobre el muro, o "recinto" y "lado".');
    pt = { x: num(o.x, 'x'), y: num(o.y, 'y') };
  }
  const near = nearestWall(lv, pt, 0.6);
  if (!near) throw new ComandoError(`No hay ningún muro a menos de 60 cm de (${r3(pt.x)}, ${r3(pt.y)}). En "resumen" están los ejes de todos los muros; también puedes ubicar la abertura con "recinto" y "lado".`);
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
  if (hacia) made.flipV = dot(sub(hacia, near.proj), n) < 0;
  if (o.bisagra_cerca_de) made.flipH = dot(sub(o.bisagra_cerca_de, near.proj), dir) > 0;
  const sPos = near.t * L;
  return { centro: { x: r3(near.proj.x), y: r3(near.proj.y) }, ancho: width, largo_muro: r3(L), distancia_a_extremos: [r3(sPos - width / 2), r3(L - sPos - width / 2)] };
}

/** Catálogo de muebles y símbolos disponibles. */
export function listarMuebles(): { orientacion: string; muebles: { tipo: string; nombre: string; categoria: string; ancho: number; fondo: number }[] } {
  return {
    orientacion: 'Con rotación 0, el respaldo, la cabecera o el lado que va contra el muro mira al norte (arriba, Y menor) y el frente al sur. "ancho" va en X y "fondo" en Y. La rotación es en sentido horario: 90 deja el respaldo al este, 180 al sur y 270 al oeste. Es más simple usar "respaldo_hacia" o "apoyar_en_muro".',
    muebles: SYMBOLS.map(s => ({ tipo: s.type, nombre: s.name, categoria: s.cat, ancho: s.w, fondo: s.h })),
  };
}

const GIRO: Record<Lado, number> = { norte: 0, este: 90, sur: 180, oeste: 270 };

export interface MuebleOpts {
  x: number; y: number;
  /** giro en grados, sentido horario; 0 = respaldo al norte */
  rotacion?: number;
  /** alternativa a rotacion: hacia dónde queda el respaldo o la cabecera */
  respaldo_hacia?: Lado;
  /** pega el mueble al muro más cercano al punto, con el respaldo contra él */
  apoyar_en_muro?: boolean;
  ancho?: number; fondo?: number;
}

/** Calcula centro y giro de un mueble según las opciones de orientación. */
function ubicar(lv: Level, o: MuebleOpts, fondo: number, actual?: number): { x: number; y: number; rot: number } {
  const x = num(o.x, 'x'), y = num(o.y, 'y');
  if (o.apoyar_en_muro) {
    const near = nearestWall(lv, { x, y }, 2.5);
    if (!near) throw new ComandoError(`No hay ningún muro a menos de 2,5 m de (${x}, ${y}) donde apoyar el mueble.`);
    if (near.d < 1e-6) throw new ComandoError('El punto está justo sobre el eje del muro: muévelo hacia el lado del recinto donde va el mueble.');
    const wall = lv.walls.find(w => w.id === near.id)!;
    const n = unit(sub({ x, y }, near.proj));           // del muro hacia el recinto
    const k = wall.thickness / 2 + fondo / 2;
    // el respaldo apunta al muro: (sin r, -cos r) = -n
    const rot = ((Math.atan2(-n.x, n.y) * 180) / Math.PI + 360) % 360;
    return { x: near.proj.x + n.x * k, y: near.proj.y + n.y * k, rot: Math.round(rot * 100) / 100 };
  }
  if (o.respaldo_hacia !== undefined) {
    if (GIRO[o.respaldo_hacia] === undefined) throw new ComandoError('"respaldo_hacia" debe ser norte, sur, este u oeste.');
    return { x, y, rot: GIRO[o.respaldo_hacia] };
  }
  return { x, y, rot: o.rotacion === undefined ? actual ?? 0 : num(o.rotacion, 'rotacion', -360, 360) };
}

export function agregarMueble(p: Project, o: MuebleOpts & { tipo: string }): { tipo: string; nombre: string; x: number; y: number; rotacion: number; ancho: number; fondo: number } {
  const def = SYMBOLS.find(s => s.type === o.tipo);
  if (!def) throw new ComandoError(`No existe el mueble "${o.tipo}". Usa "listar_muebles" para ver los tipos válidos (por ejemplo: ${SYMBOLS.slice(0, 6).map(s => s.type).join(', ')}).`);
  const lv = nivel(p);
  const w = o.ancho === undefined ? undefined : num(o.ancho, 'ancho', 0.05, 30), h = o.fondo === undefined ? undefined : num(o.fondo, 'fondo', 0.05, 30);
  const u = ubicar(lv, o, h ?? def.h);
  const it = addItem(lv, def.type, u.x, u.y, u.rot, w, h);
  return { tipo: def.type, nombre: def.name, x: r3(it.x), y: r3(it.y), rotacion: it.rot, ancho: it.w, fondo: it.h };
}

function muebleCerca(lv: Level, pt: Pt): Item {
  let best: { it: Item; d: number } | null = null;
  for (const it of lv.items) { const d = dist(it, pt); if (d < Math.max(0.6, Math.max(it.w, it.h) / 2) && (!best || d < best.d)) best = { it, d }; }
  if (!best) throw new ComandoError(`No hay ningún mueble cerca de (${pt.x}, ${pt.y}). En "resumen" está la posición de cada uno.`);
  return best.it;
}

/** Mueve o gira el mueble más cercano al punto, sin tener que borrarlo y volver a ponerlo. */
export function moverMueble(p: Project, o: { x: number; y: number; nuevo_x?: number; nuevo_y?: number; rotacion?: number; respaldo_hacia?: Lado; apoyar_en_muro?: boolean }): { tipo: string; x: number; y: number; rotacion: number } {
  const lv = nivel(p), it = muebleCerca(lv, { x: num(o.x, 'x'), y: num(o.y, 'y') });
  const u = ubicar(lv, { x: o.nuevo_x ?? it.x, y: o.nuevo_y ?? it.y, rotacion: o.rotacion, respaldo_hacia: o.respaldo_hacia, apoyar_en_muro: o.apoyar_en_muro }, it.h, it.rot);
  it.x = u.x; it.y = u.y; it.rot = u.rot;
  return { tipo: it.type, x: r3(it.x), y: r3(it.y), rotacion: it.rot };
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
export function eliminar(p: Project, o: { tipo: 'muro' | 'abertura' | 'mueble' | 'texto'; x: number; y: number }): { eliminado: string; x: number; y: number } {
  const lv = nivel(p), pt = { x: num(o.x, 'x'), y: num(o.y, 'y') };
  if (o.tipo === 'muro') {
    const near = nearestWall(lv, pt, 0.4);
    if (!near) throw new ComandoError(`No hay ningún muro a menos de 40 cm de (${pt.x}, ${pt.y}).`);
    removeWalls(lv, [near.id]);
    return { eliminado: 'muro', x: r3(near.proj.x), y: r3(near.proj.y) };
  }
  if (o.tipo === 'abertura') {
    const nm = nodeMap(lv);
    let best: { id: string; d: number; kind: string; c: Pt } | null = null;
    for (const op of lv.openings) {
      const w = lv.walls.find(x => x.id === op.wall); if (!w) continue;
      const a = nm.get(w.a)!, b = nm.get(w.b)!;
      const c = { x: a.x + (b.x - a.x) * op.t, y: a.y + (b.y - a.y) * op.t }, d = dist(c, pt);
      if (d < Math.max(0.6, op.width / 2) && (!best || d < best.d)) best = { id: op.id, d, kind: op.kind, c };
    }
    if (!best) throw new ComandoError(`No hay ninguna puerta, ventana o vano cerca de (${pt.x}, ${pt.y}).`);
    const id = best.id; lv.openings = lv.openings.filter(x => x.id !== id);
    return { eliminado: best.kind === 'door' ? 'puerta' : best.kind === 'window' ? 'ventana' : 'vano', x: r3(best.c.x), y: r3(best.c.y) };
  }
  if (o.tipo === 'mueble') {
    const it = muebleCerca(lv, pt);
    lv.items = lv.items.filter(x => x.id !== it.id);
    return { eliminado: it.type, x: r3(it.x), y: r3(it.y) };
  }
  if (o.tipo === 'texto') {
    let best: { id: string; d: number; x: number; y: number } | null = null;
    for (const l of lv.labels) { const d = dist(l, pt); if (d < 1 && (!best || d < best.d)) best = { id: l.id, d, x: l.x, y: l.y }; }
    if (!best) throw new ComandoError(`No hay ningún texto a menos de 1 m de (${pt.x}, ${pt.y}).`);
    const id = best.id; lv.labels = lv.labels.filter(x => x.id !== id);
    return { eliminado: 'texto', x: r3(best.x), y: r3(best.y) };
  }
  throw new ComandoError('"tipo" debe ser muro, abertura, mueble o texto.');
}

// ───────────────────────── resumen ─────────────────────────

export interface Resumen {
  nombre: string; unidades: Units; escala: number; nivel: string;
  /** tamaño de la construcción, por las caras exteriores de los muros */
  limites: { x1: number; y1: number; x2: number; y2: number; ancho: number; largo: number } | null;
  superficie_util_total: number;
  recintos: { nombre: string | null; superficie: number; perimetro: number; ancho_interior: number; largo_interior: number; interior: { x1: number; y1: number; x2: number; y2: number }; centro: { x: number; y: number }; puertas: number; ventanas: number }[];
  muros: { cantidad: number; largo_total: number; grosores: number[]; ejes: { x1: number; y1: number; x2: number; y2: number; grosor: number }[] };
  aberturas: { tipo: string; estilo: string | null; ancho: number; x: number; y: number }[];
  muebles: { tipo: string; x: number; y: number; rotacion: number }[];
  textos: number;
  calco: number;
  advertencias: string[];
}

const KIND_ES: Record<string, string> = { door: 'puerta', window: 'ventana', gap: 'vano' };
const STYLE_ES: Record<string, string> = { single: 'abatible', double: 'doble', sliding: 'corredera', fixed: 'fija' };

/** ¿Se solapan dos polígonos convexos? (teorema del eje separador) */
function seSolapan(A: Pt[], B: Pt[]): boolean {
  for (const poly of [A, B]) {
    for (let i = 0; i < poly.length; i++) {
      const p1 = poly[i], p2 = poly[(i + 1) % poly.length], nx = p2.y - p1.y, ny = p1.x - p2.x;
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const q of A) { const v = q.x * nx + q.y * ny; if (v < a0) a0 = v; if (v > a1) a1 = v; }
      for (const q of B) { const v = q.x * nx + q.y * ny; if (v < b0) b0 = v; if (v > b1) b1 = v; }
      if (a1 <= b0 || b1 <= a0) return false;
    }
  }
  return true;
}
/** Rectángulo del mueble, algo encogido para no avisar por simples contactos. */
const caja = (it: Item, margen = 0.03): Pt[] => itemCorners({ ...it, w: Math.max(0.02, it.w - margen * 2), h: Math.max(0.02, it.h - margen * 2) });
const lista = (xs: string[], max = 5) => xs.slice(0, max).join('; ') + (xs.length > max ? `; y ${xs.length - max} más` : '');

/** Estado del plano en datos: lo que un agente necesita para comprobar su trabajo. */
export function resumen(p: Project): Resumen {
  const lv = nivel(p), nm = nodeMap(lv), rooms = computeRooms(lv), geoms = wallGeoms(lv);
  const adv: string[] = [];
  const grado = new Map<string, number>();
  let largo = 0;
  for (const w of lv.walls) {
    grado.set(w.a, (grado.get(w.a) || 0) + 1); grado.set(w.b, (grado.get(w.b) || 0) + 1);
    const a = nm.get(w.a), c = nm.get(w.b); if (a && c) largo += dist(a, c);
  }
  // límites: por las caras exteriores de los muros (los muebles y las cotas no cuentan)
  let b: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  for (const g of geoms.values()) for (const q of [g.aL, g.aR, g.bL, g.bR]) {
    b = b ? { minX: Math.min(b.minX, q.x), minY: Math.min(b.minY, q.y), maxX: Math.max(b.maxX, q.x), maxY: Math.max(b.maxY, q.y) } : { minX: q.x, minY: q.y, maxX: q.x, maxY: q.y };
  }
  if (!b) b = levelBounds(lv);

  const sueltos = lv.nodes.filter(n => grado.get(n.id) === 1);
  if (sueltos.length) adv.push(`Hay ${sueltos.length} extremo(s) de muro sin unir, en ${sueltos.slice(0, 6).map(n => `(${r3(n.x)}, ${r3(n.y)})`).join(', ')}: ahí los recintos no cierran.`);
  if (lv.walls.length && !rooms.length) adv.push('Hay muros pero ningún recinto cerrado: no se puede calcular superficie.');
  const sinNombre = rooms.filter(r => !r.meta).length;
  if (sinNombre) adv.push(`${sinNombre} recinto(s) no tienen nombre.`);

  const frames = openingFrames(lv, geoms);
  const aberturas = lv.openings.map(op => {
    const w = lv.walls.find(x => x.id === op.wall)!, a = nm.get(w.a)!, c = nm.get(w.b)!;
    if (op.width > dist(a, c) - 0.05) adv.push(`Una ${KIND_ES[op.kind]} de ${op.width} m no cabe en su muro de ${r2(dist(a, c))} m.`);
    return { tipo: KIND_ES[op.kind], estilo: op.kind === 'gap' ? null : STYLE_ES[op.style] || op.style, ancho: r2(op.width), x: r3(a.x + (c.x - a.x) * op.t), y: r3(a.y + (c.y - a.y) * op.t) };
  });
  // puertas y ventanas de cada recinto: las que están en alguno de sus muros
  const cuenta = (r: Room, pasos: boolean) => lv.openings.filter(op => r.wallIds.includes(op.wall) && (op.kind === 'window') !== pasos).length;
  const sinPuerta = rooms.filter(r => cuenta(r, true) === 0);
  if (sinPuerta.length) adv.push(`Sin puerta ni vano: ${lista(sinPuerta.map(r => r.meta?.name || `recinto en (${r2(r.center.x)}, ${r2(r.center.y)})`))}.`);

  // muebles: fuera de todo recinto, metidos en un muro, encimados o en el barrido de una puerta
  const nombre = (it: Item) => `${it.type} en (${r2(it.x)}, ${r2(it.y)})`;
  if (rooms.length) {
    const fuera = lv.items.filter(it => !rooms.some(r => pointInPoly(it, r.poly)));
    if (fuera.length) adv.push(`${fuera.length} mueble(s) quedaron fuera de todo recinto: ${lista(fuera.map(nombre))}.`);
  }
  const muros = [...geoms.values()].map(g => {
    const h = Math.max(0.01, g.wall.thickness / 2 - 0.02), n = g.nrm;
    return [{ x: g.a.x + n.x * h, y: g.a.y + n.y * h }, { x: g.b.x + n.x * h, y: g.b.y + n.y * h }, { x: g.b.x - n.x * h, y: g.b.y - n.y * h }, { x: g.a.x - n.x * h, y: g.a.y - n.y * h }];
  });
  const cajas = lv.items.map(it => caja(it));
  const enMuro = lv.items.filter((_, i) => muros.some(m => seSolapan(cajas[i], m)));
  if (enMuro.length) adv.push(`${enMuro.length} mueble(s) se meten dentro de un muro: ${lista(enMuro.map(nombre))}.`);
  const encima: string[] = [];
  for (let i = 0; i < lv.items.length; i++) for (let j = i + 1; j < lv.items.length; j++) {
    const A = lv.items[i], B = lv.items[j];
    if (A.type === 'rug' || B.type === 'rug') continue; // una alfombra va debajo de otros muebles
    if (seSolapan(cajas[i], cajas[j])) encima.push(`${nombre(A)} con ${nombre(B)}`);
  }
  if (encima.length) adv.push(`${encima.length} par(es) de muebles se enciman: ${lista(encima)}.`);
  const barrido: string[] = [];
  for (const f of frames) {
    if (f.o.kind !== 'door' || f.o.style === 'sliding') continue;
    const n = f.g.nrm, sv = f.o.flipV ? -1 : 1, h = f.thick / 2, W = f.width;
    const at = (q: Pt, k: number) => ({ x: q.x + n.x * sv * k, y: q.y + n.y * sv * k });
    const zona = [at(f.p0, h + 0.03), at(f.p1, h + 0.03), at(f.p1, h + W - 0.03), at(f.p0, h + W - 0.03)];
    lv.items.forEach((it, i) => { if (it.type !== 'rug' && seSolapan(cajas[i], zona)) barrido.push(`${nombre(it)} con la puerta en (${r2(f.c.x)}, ${r2(f.c.y)})`); });
  }
  if (barrido.length) adv.push(`${barrido.length} mueble(s) estorban el barrido de una puerta: ${lista(barrido)}.`);

  return {
    nombre: p.name, unidades: p.units, escala: p.scale, nivel: lv.name,
    limites: b ? { x1: r3(b.minX), y1: r3(b.minY), x2: r3(b.maxX), y2: r3(b.maxY), ancho: r3(b.maxX - b.minX), largo: r3(b.maxY - b.minY) } : null,
    superficie_util_total: r2(rooms.reduce((s, r) => s + r.area, 0)),
    recintos: rooms.map(r => {
      const xs = r.inner.map(q => q.x), ys = r.inner.map(q => q.y);
      const x1 = Math.min(...xs), x2 = Math.max(...xs), y1 = Math.min(...ys), y2 = Math.max(...ys);
      return { nombre: r.meta?.name || null, superficie: r2(r.area), perimetro: r2(r.perimeter), ancho_interior: r3(x2 - x1), largo_interior: r3(y2 - y1), interior: { x1: r3(x1), y1: r3(y1), x2: r3(x2), y2: r3(y2) }, centro: { x: r3(r.center.x), y: r3(r.center.y) }, puertas: cuenta(r, true), ventanas: cuenta(r, false) };
    }),
    muros: {
      cantidad: lv.walls.length, largo_total: r2(largo), grosores: [...new Set(lv.walls.map(w => w.thickness))].sort(),
      ejes: [...geoms.values()].map(g => ({ x1: r3(g.a.x), y1: r3(g.a.y), x2: r3(g.b.x), y2: r3(g.b.y), grosor: g.wall.thickness })),
    },
    aberturas,
    muebles: lv.items.map(it => ({ tipo: it.type, x: r3(it.x), y: r3(it.y), rotacion: it.rot })),
    textos: lv.labels.length,
    calco: lv.shapes.length,
    advertencias: adv,
  };
}

/** Versión corta del resumen, para responder después de cada cambio sin repetir todo el plano. */
export function estado(p: Project): { recintos: number; superficie_util_total: number; muros: number; aberturas: number; muebles: number; advertencias: string[] } {
  const r = resumen(p);
  return { recintos: r.recintos.length, superficie_util_total: r.superficie_util_total, muros: r.muros.cantidad, aberturas: r.aberturas.length, muebles: r.muebles.length, advertencias: r.advertencias };
}
