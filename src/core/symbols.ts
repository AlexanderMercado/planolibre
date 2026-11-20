// Biblioteca de mobiliario y símbolos. Cada símbolo se dibuja de forma
// paramétrica dentro de su caja (0..w, 0..h en metros), así se adapta al
// tamaño sin deformar detalles como almohadas o quemadores.

export type Cmd =
  | { c: 'rect'; x: number; y: number; w: number; h: number; r?: number; fill?: 0 | 1 | 2 }
  | { c: 'ell'; cx: number; cy: number; rx: number; ry: number; fill?: 0 | 1 | 2 }
  | { c: 'poly'; pts: number[]; closed?: boolean; fill?: 0 | 1 | 2; dash?: boolean }
  | { c: 'arc'; cx: number; cy: number; r: number; a0: number; a1: number };

export interface SymbolDef {
  type: string; name: string; cat: string;
  w: number; h: number;
  /** altura para la vista 3D (m) y elevación de la base */
  z: number; base?: number;
  draw: (w: number, h: number) => Cmd[];
}

const R = (x: number, y: number, w: number, h: number, r = 0, fill: 0 | 1 | 2 = 0): Cmd => ({ c: 'rect', x, y, w, h, r, fill });
const E = (cx: number, cy: number, rx: number, ry: number, fill: 0 | 1 | 2 = 0): Cmd => ({ c: 'ell', cx, cy, rx, ry, fill });
const P = (pts: number[], closed = false, fill: 0 | 1 | 2 = 0, dash = false): Cmd => ({ c: 'poly', pts, closed, fill, dash });
const m = Math.min;

function bed(w: number, h: number, pillows: number): Cmd[] {
  const out: Cmd[] = [R(0, 0, w, h, 0.04, 1)];
  const ph = m(0.38, h * 0.22), gap = 0.08, pw = (w - gap * (pillows + 1)) / pillows;
  for (let i = 0; i < pillows; i++) out.push(R(gap + i * (pw + gap), 0.08, pw, ph, 0.06, 2));
  const fold = m(h * 0.42, ph + 0.3);
  out.push(P([0, fold, w, fold]));
  out.push(P([w * 0.55, fold, w, fold + m(0.35, h * 0.2)]));
  return out;
}

function sofa(w: number, h: number, seats: number): Cmd[] {
  const arm = m(0.18, w * 0.14), back = m(0.2, h * 0.28);
  const out: Cmd[] = [R(0, 0, w, h, 0.06, 1), R(0, 0, w, back, 0.05, 2), R(0, back * 0.6, arm, h - back * 0.6, 0.05, 2), R(w - arm, back * 0.6, arm, h - back * 0.6, 0.05, 2)];
  const sw = (w - arm * 2) / seats;
  for (let i = 1; i < seats; i++) out.push(P([arm + i * sw, back, arm + i * sw, h]));
  return out;
}

function chairAt(cx: number, cy: number, s: number, ang: number): Cmd[] {
  // silla pequeña orientada: 0 = respaldo arriba
  const c = Math.cos(ang), sn = Math.sin(ang), hs = s / 2;
  const tr = (x: number, y: number) => [cx + x * c - y * sn, cy + x * sn + y * c];
  const body = [...tr(-hs, -hs), ...tr(hs, -hs), ...tr(hs, hs), ...tr(-hs, hs)];
  const back = [...tr(-hs, -hs), ...tr(hs, -hs), ...tr(hs, -hs + s * 0.22), ...tr(-hs, -hs + s * 0.22)];
  return [P(body, true, 1), P(back, true, 2)];
}

function tableChairs(w: number, h: number, perSide: number, ends: boolean): Cmd[] {
  const cs = 0.42, inset = cs * 0.55;
  const out: Cmd[] = [];
  const tx = ends ? inset : 0, tw = w - tx * 2, ty = inset, th = h - inset * 2;
  for (let i = 0; i < perSide; i++) {
    const cx = tx + (tw * (i + 0.5)) / perSide;
    out.push(...chairAt(cx, cs / 2, cs, 0), ...chairAt(cx, h - cs / 2, cs, Math.PI));
  }
  if (ends) out.push(...chairAt(cs / 2, h / 2, cs, -Math.PI / 2), ...chairAt(w - cs / 2, h / 2, cs, Math.PI / 2));
  out.push(R(tx, ty, tw, th, 0.03, 1));
  return out;
}

function stairs(w: number, h: number): Cmd[] {
  const out: Cmd[] = [R(0, 0, w, h, 0, 1)];
  const n = Math.max(3, Math.round(h / 0.28));
  for (let i = 1; i < n; i++) out.push(P([0, (h * i) / n, w, (h * i) / n]));
  out.push(P([w / 2, h - 0.12, w / 2, 0.15]), P([w / 2 - 0.12, 0.33, w / 2, 0.15, w / 2 + 0.12, 0.33]));
  return out;
}

function car(w: number, h: number): Cmd[] {
  return [
    R(0, 0, w, h, m(w, h) * 0.22, 1),
    R(w * 0.12, h * 0.22, w * 0.76, h * 0.16, 0.08, 2),
    R(w * 0.12, h * 0.7, w * 0.76, h * 0.12, 0.08, 2),
    P([w * 0.12, h * 0.38, w * 0.12, h * 0.7]), P([w * 0.88, h * 0.38, w * 0.88, h * 0.7]),
  ];
}

function tree(w: number, h: number): Cmd[] {
  const cx = w / 2, cy = h / 2, out: Cmd[] = [E(cx, cy, w / 2, h / 2, 1)];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    out.push(E(cx + Math.cos(a) * w * 0.24, cy + Math.sin(a) * h * 0.24, w * 0.17, h * 0.17));
  }
  out.push(E(cx, cy, w * 0.05, h * 0.05, 2));
  return out;
}

function north(w: number, h: number): Cmd[] {
  const cx = w / 2;
  return [E(cx, h / 2, w / 2, h / 2), P([cx, h * 0.08, w * 0.72, h * 0.8, cx, h * 0.62], true, 2), P([cx, h * 0.08, w * 0.28, h * 0.8, cx, h * 0.62], true)];
}

export const SYMBOLS: SymbolDef[] = [
  // Dormitorio
  { type: 'bed2', name: 'Cama 2 plazas', cat: 'Dormitorio', w: 1.6, h: 2.0, z: 0.5, draw: (w, h) => bed(w, h, 2) },
  { type: 'bed1', name: 'Cama 1 plaza', cat: 'Dormitorio', w: 0.9, h: 1.9, z: 0.5, draw: (w, h) => bed(w, h, 1) },
  { type: 'nightstand', name: 'Velador', cat: 'Dormitorio', w: 0.45, h: 0.4, z: 0.5, draw: (w, h) => [R(0, 0, w, h, 0.02, 1), E(w / 2, h / 2, m(w, h) * 0.22, m(w, h) * 0.22)] },
  { type: 'wardrobe', name: 'Clóset', cat: 'Dormitorio', w: 1.4, h: 0.6, z: 2.1, draw: (w, h) => [R(0, 0, w, h, 0, 1), P([0, h / 2, w, h / 2], false, 0, true), P([w / 2, 0, w / 2, h])] },
  { type: 'crib', name: 'Cuna', cat: 'Dormitorio', w: 0.7, h: 1.3, z: 0.9, draw: (w, h) => [R(0, 0, w, h, 0.03, 1), R(0.06, 0.06, w - 0.12, h - 0.12, 0.03), R(0.14, 0.12, w - 0.28, 0.25, 0.05, 2)] },
  // Living
  { type: 'sofa3', name: 'Sofá 3 cuerpos', cat: 'Living', w: 2.1, h: 0.9, z: 0.8, draw: (w, h) => sofa(w, h, 3) },
  { type: 'sofa2', name: 'Sofá 2 cuerpos', cat: 'Living', w: 1.5, h: 0.9, z: 0.8, draw: (w, h) => sofa(w, h, 2) },
  { type: 'armchair', name: 'Sillón', cat: 'Living', w: 0.85, h: 0.85, z: 0.8, draw: (w, h) => sofa(w, h, 1) },
  { type: 'coffee', name: 'Mesa de centro', cat: 'Living', w: 1.0, h: 0.6, z: 0.4, draw: (w, h) => [R(0, 0, w, h, 0.05, 1), R(0.06, 0.06, w - 0.12, h - 0.12, 0.03)] },
  { type: 'tv', name: 'Mueble TV', cat: 'Living', w: 1.5, h: 0.4, z: 0.5, draw: (w, h) => [R(0, 0, w, h, 0.02, 1), R(w * 0.15, h * 0.35, w * 0.7, h * 0.14, 0, 2)] },
  { type: 'shelf', name: 'Estante', cat: 'Living', w: 1.0, h: 0.35, z: 1.8, draw: (w, h) => [R(0, 0, w, h, 0, 1), P([0, 0, w, h]), P([w, 0, 0, h])] },
  { type: 'plant', name: 'Planta', cat: 'Living', w: 0.5, h: 0.5, z: 1.0, draw: (w, h) => tree(w, h) },
  { type: 'rug', name: 'Alfombra', cat: 'Living', w: 2.0, h: 1.4, z: 0.02, draw: (w, h) => [R(0, 0, w, h, 0.03, 1), R(0.1, 0.1, w - 0.2, h - 0.2, 0, 0)] },
  { type: 'fireplace', name: 'Chimenea', cat: 'Living', w: 1.2, h: 0.5, z: 1.1, draw: (w, h) => [R(0, 0, w, h, 0, 1), R(w * 0.2, h * 0.3, w * 0.6, h * 0.7, 0, 2)] },
  // Comedor
  { type: 'table6', name: 'Comedor 6 sillas', cat: 'Comedor', w: 2.0, h: 1.4, z: 0.75, draw: (w, h) => tableChairs(w, h, 2, true) },
  { type: 'table4', name: 'Comedor 4 sillas', cat: 'Comedor', w: 1.2, h: 1.3, z: 0.75, draw: (w, h) => tableChairs(w, h, 2, false) },
  { type: 'tableR', name: 'Mesa redonda', cat: 'Comedor', w: 1.5, h: 1.5, z: 0.75, draw: (w, h) => {
    const cs = 0.42, out: Cmd[] = [];
    for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2; out.push(...chairAt(w / 2 + Math.sin(a) * (w / 2 - cs / 2), h / 2 - Math.cos(a) * (h / 2 - cs / 2), cs, a)); }
    out.push(E(w / 2, h / 2, w / 2 - cs * 0.55, h / 2 - cs * 0.55, 1));
    return out;
  } },
  { type: 'table', name: 'Mesa', cat: 'Comedor', w: 1.4, h: 0.8, z: 0.75, draw: (w, h) => [R(0, 0, w, h, 0.03, 1)] },
  { type: 'chair', name: 'Silla', cat: 'Comedor', w: 0.45, h: 0.45, z: 0.85, draw: (w, h) => [R(0, 0, w, h, 0.04, 1), R(0, 0, w, h * 0.22, 0.03, 2)] },
  // Cocina
  { type: 'counter', name: 'Mesón', cat: 'Cocina', w: 1.2, h: 0.6, z: 0.9, draw: (w, h) => [R(0, 0, w, h, 0, 1)] },
  { type: 'sink', name: 'Lavaplatos', cat: 'Cocina', w: 0.8, h: 0.6, z: 0.9, draw: (w, h) => [R(0, 0, w, h, 0, 1), R(0.08, 0.12, w - 0.16, h - 0.2, 0.05, 2), E(w / 2, 0.07, 0.03, 0.03), E(w / 2, h / 2 + 0.02, 0.03, 0.03)] },
  { type: 'stove', name: 'Cocina 4 platos', cat: 'Cocina', w: 0.6, h: 0.6, z: 0.9, draw: (w, h) => {
    const out: Cmd[] = [R(0, 0, w, h, 0.02, 1)];
    for (const [fx, fy] of [[0.28, 0.3], [0.72, 0.3], [0.28, 0.72], [0.72, 0.72]]) { const r = m(w, h) * 0.13; out.push(E(w * fx, h * fy, r, r, 2), E(w * fx, h * fy, r * 0.45, r * 0.45)); }
    return out;
  } },
  { type: 'fridge', name: 'Refrigerador', cat: 'Cocina', w: 0.7, h: 0.7, z: 1.8, draw: (w, h) => [R(0, 0, w, h, 0.03, 1), P([0, h * 0.86, w, h * 0.86]), P([w * 0.12, h * 0.93, w * 0.3, h * 0.93])] },
  { type: 'washer', name: 'Lavadora', cat: 'Cocina', w: 0.6, h: 0.6, z: 0.85, draw: (w, h) => [R(0, 0, w, h, 0.03, 1), E(w / 2, h * 0.55, m(w, h) * 0.3, m(w, h) * 0.3, 2), P([0, h * 0.14, w, h * 0.14])] },
  { type: 'island', name: 'Isla de cocina', cat: 'Cocina', w: 1.8, h: 0.9, z: 0.9, draw: (w, h) => [R(0, 0, w, h, 0.03, 1), R(0.05, 0.05, w - 0.1, h - 0.1, 0.02)] },
  // Baño
  { type: 'toilet', name: 'WC', cat: 'Baño', w: 0.4, h: 0.7, z: 0.45, draw: (w, h) => [R(0, 0, w, h * 0.27, 0.03, 1), E(w / 2, h * 0.63, w * 0.46, h * 0.36, 1), E(w / 2, h * 0.63, w * 0.3, h * 0.25, 2)] },
  { type: 'basin', name: 'Lavamanos', cat: 'Baño', w: 0.55, h: 0.45, z: 0.85, draw: (w, h) => [R(0, 0, w, h, 0.05, 1), E(w / 2, h * 0.55, w * 0.36, h * 0.32, 2), E(w / 2, h * 0.14, 0.025, 0.025)] },
  { type: 'bathtub', name: 'Tina', cat: 'Baño', w: 1.5, h: 0.7, z: 0.55, draw: (w, h) => [R(0, 0, w, h, 0.03, 1), R(0.06, 0.06, w - 0.12, h - 0.12, m(w, h) * 0.3, 2), E(0.2, h / 2, 0.03, 0.03)] },
  { type: 'shower', name: 'Ducha', cat: 'Baño', w: 0.8, h: 0.8, z: 0.08, draw: (w, h) => [R(0, 0, w, h, 0, 1), P([0, 0, w, h]), P([w, 0, 0, h]), E(w / 2, h / 2, 0.05, 0.05, 2)] },
  { type: 'vanity', name: 'Vanitorio doble', cat: 'Baño', w: 1.2, h: 0.5, z: 0.85, draw: (w, h) => [R(0, 0, w, h, 0.02, 1), E(w * 0.27, h * 0.55, w * 0.17, h * 0.3, 2), E(w * 0.73, h * 0.55, w * 0.17, h * 0.3, 2)] },
  // Oficina
  { type: 'desk', name: 'Escritorio', cat: 'Oficina', w: 1.3, h: 0.65, z: 0.75, draw: (w, h) => [R(0, 0, w, h, 0.02, 1), R(w * 0.32, h * 0.12, w * 0.36, h * 0.1, 0, 2)] },
  { type: 'officeChair', name: 'Silla de oficina', cat: 'Oficina', w: 0.55, h: 0.55, z: 0.9, draw: (w, h) => [E(w / 2, h / 2, w / 2, h / 2, 1), R(w * 0.12, 0, w * 0.76, h * 0.2, 0.05, 2)] },
  { type: 'meeting', name: 'Mesa de reunión', cat: 'Oficina', w: 2.4, h: 1.5, z: 0.75, draw: (w, h) => tableChairs(w, h, 3, true) },
  { type: 'cabinet', name: 'Archivador', cat: 'Oficina', w: 0.5, h: 0.6, z: 1.3, draw: (w, h) => [R(0, 0, w, h, 0, 1), P([0, h * 0.88, w, h * 0.88])] },
  // Estructura y exterior
  { type: 'stairs', name: 'Escalera', cat: 'Estructura y exterior', w: 1.0, h: 2.8, z: 2.4, draw: stairs },
  { type: 'column', name: 'Pilar', cat: 'Estructura y exterior', w: 0.3, h: 0.3, z: 2.4, draw: (w, h) => [R(0, 0, w, h, 0, 2), P([0, 0, w, h]), P([w, 0, 0, h])] },
  { type: 'columnR', name: 'Pilar redondo', cat: 'Estructura y exterior', w: 0.35, h: 0.35, z: 2.4, draw: (w, h) => [E(w / 2, h / 2, w / 2, h / 2, 2)] },
  { type: 'car', name: 'Automóvil', cat: 'Estructura y exterior', w: 1.8, h: 4.5, z: 1.45, draw: car },
  { type: 'tree', name: 'Árbol', cat: 'Estructura y exterior', w: 2.2, h: 2.2, z: 3.2, draw: tree },
  { type: 'pool', name: 'Piscina', cat: 'Estructura y exterior', w: 3.5, h: 7.0, z: 0.05, draw: (w, h) => [R(0, 0, w, h, 0.3, 1), R(0.25, 0.25, w - 0.5, h - 0.5, 0.2, 2)] },
  { type: 'north', name: 'Norte', cat: 'Estructura y exterior', w: 1.0, h: 1.0, z: 0, draw: north },
  { type: 'box', name: 'Bloque genérico', cat: 'Estructura y exterior', w: 1.0, h: 1.0, z: 1.0, draw: (w, h) => [R(0, 0, w, h, 0, 1)] },
];

const byType = new Map(SYMBOLS.map(s => [s.type, s]));
export function symbolDef(type: string): SymbolDef {
  return byType.get(type) || byType.get('box')!;
}
export const SYMBOL_CATS = Array.from(new Set(SYMBOLS.map(s => s.cat)));
