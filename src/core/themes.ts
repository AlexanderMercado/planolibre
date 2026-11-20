export type ViewMode = 'tech' | 'color' | 'blue' | '3d';

export interface Theme {
  id: ViewMode; name: string;
  bg: string; grid: string; gridMajor: string;
  wallFill: string; wallStroke: string;
  line: string; dim: string; text: string; muted: string;
  glass: string | null; furnFill: string | null; furnAccent: string | null; furnStroke: string;
  roomFills: boolean; accent: string; halo: string;
}

export const ROOM_TYPES: { key: string; name: string; color: string; match: RegExp }[] = [
  { key: 'living', name: 'Living / Estar', color: '#FBEFD5', match: /living|estar|sala/ },
  { key: 'dining', name: 'Comedor', color: '#FCE4D2', match: /comedor/ },
  { key: 'kitchen', name: 'Cocina', color: '#DDEFD9', match: /cocina|kitchen/ },
  { key: 'bed', name: 'Dormitorio', color: '#DCE8F7', match: /dorm|pieza|habitaci|suite|cuarto/ },
  { key: 'bath', name: 'Baño', color: '#D5EEF0', match: /ba[ñn]o|toilet|wc|aseo/ },
  { key: 'hall', name: 'Pasillo / Acceso', color: '#EEEDEA', match: /pasillo|hall|acceso|recibidor|entrada/ },
  { key: 'outdoor', name: 'Terraza / Exterior', color: '#E3F0CF', match: /terraza|balc|patio|jard|logia|quincho/ },
  { key: 'storage', name: 'Bodega / Clóset', color: '#E9E3DA', match: /bodega|cl[oó]set|despensa|lavander/ },
  { key: 'office', name: 'Oficina', color: '#E8E0F4', match: /oficina|escritorio|estudio/ },
  { key: 'garage', name: 'Estacionamiento', color: '#E2E4E8', match: /estacion|garage|garaje|cochera/ },
  { key: 'other', name: 'Otro', color: '#F3F1EC', match: /^$/ },
];

export const ROOM_NAMES = ['Living', 'Comedor', 'Living comedor', 'Cocina', 'Dormitorio', 'Dormitorio principal', 'Baño', 'Pasillo', 'Hall de acceso', 'Terraza', 'Logia', 'Bodega', 'Clóset', 'Oficina', 'Estacionamiento'];

export function roomTypeFromName(name: string): string {
  const s = name.toLowerCase();
  for (const t of ROOM_TYPES) if (t.key !== 'other' && t.match.test(s)) return t.key;
  return 'other';
}

export function roomColor(type: string): string {
  return (ROOM_TYPES.find(t => t.key === type) || ROOM_TYPES[ROOM_TYPES.length - 1]).color;
}

export const THEMES: Record<Exclude<ViewMode, '3d'>, Theme> = {
  tech: {
    id: 'tech', name: 'Técnico', bg: '#ffffff', grid: '#eef0f3', gridMajor: '#dfe3e8',
    wallFill: '#2b2f36', wallStroke: '#14171c', line: '#1c2026', dim: '#3d4654', text: '#14171c', muted: '#6b7482',
    glass: null, furnFill: '#ffffff', furnAccent: '#ffffff', furnStroke: '#59616e', roomFills: false, accent: '#1f6feb', halo: '#ffffff',
  },
  color: {
    id: 'color', name: 'Color', bg: '#fbfaf7', grid: '#f0eee9', gridMajor: '#e4e1da',
    wallFill: '#3c4350', wallStroke: '#232830', line: '#2b3038', dim: '#566070', text: '#1f242c', muted: '#727b89',
    glass: '#bfe0f5', furnFill: '#ffffff', furnAccent: '#e9e4da', furnStroke: '#6f6a60', roomFills: true, accent: '#1f6feb', halo: '#fbfaf7',
  },
  blue: {
    id: 'blue', name: 'Blueprint', bg: '#14457a', grid: '#1a4f89', gridMajor: '#215b9a',
    wallFill: '#3f6da3', wallStroke: '#ffffff', line: '#f1f6fc', dim: '#cfe1f5', text: '#ffffff', muted: '#b9d0ea',
    glass: null, furnFill: null, furnAccent: null, furnStroke: '#d5e4f5', roomFills: false, accent: '#ffd666', halo: '#14457a',
  },
};
