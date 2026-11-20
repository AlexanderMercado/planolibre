// Modelo de datos del proyecto. Todas las longitudes internas están en METROS
// y el eje Y crece hacia abajo (como la pantalla). Al exportar a DXF se invierte.

export type ID = string;
export interface Pt { x: number; y: number }

export interface PNode { id: ID; x: number; y: number }

export interface Wall { id: ID; a: ID; b: ID; thickness: number; height: number }

export type OpeningKind = 'door' | 'window' | 'gap';
export type OpeningStyle = 'single' | 'double' | 'sliding' | 'fixed';

export interface Opening {
  id: ID; wall: ID;
  /** posición del centro a lo largo del muro, 0..1 */
  t: number;
  width: number; kind: OpeningKind; style: OpeningStyle;
  flipH: boolean; flipV: boolean;
  height: number; sill: number;
}

export interface Item { id: ID; type: string; x: number; y: number; w: number; h: number; rot: number; name?: string }

export interface Dim { id: ID; x1: number; y1: number; x2: number; y2: number; offset: number }

export interface Label { id: ID; x: number; y: number; text: string; size: number; rot: number }

/** Geometría libre: líneas dibujadas a mano o entidades importadas de DXF/DWG. */
export interface Shape {
  id: ID; kind: 'poly' | 'circle' | 'arc' | 'text';
  pts: number[]; closed?: boolean;
  r?: number; a0?: number; a1?: number;
  text?: string; h?: number; rot?: number; align?: 'l' | 'c' | 'r';
  layer: string; dash?: boolean; group?: ID;
}

export interface RoomMeta { id: ID; x: number; y: number; name: string; type: string }

export interface Background { asset: ID; x: number; y: number; w: number; h: number; opacity: number; locked: boolean }

export interface Level {
  id: ID; name: string; elevation: number;
  nodes: PNode[]; walls: Wall[]; openings: Opening[];
  items: Item[]; dims: Dim[]; labels: Label[]; shapes: Shape[];
  rooms: RoomMeta[]; background: Background | null;
  /** capas del dibujo importado que están ocultas (se usa en el visor) */
  hiddenLayers?: string[];
}

export type Units = 'm' | 'cm' | 'mm' | 'ft';

export type LayerKey = 'walls' | 'openings' | 'items' | 'dims' | 'rooms' | 'labels' | 'shapes' | 'background' | 'grid';

export const LAYERS: { key: LayerKey; name: string }[] = [
  { key: 'walls', name: 'Muros' },
  { key: 'openings', name: 'Puertas y ventanas' },
  { key: 'items', name: 'Mobiliario' },
  { key: 'dims', name: 'Cotas' },
  { key: 'rooms', name: 'Recintos y áreas' },
  { key: 'labels', name: 'Textos' },
  { key: 'shapes', name: 'Líneas e importados' },
  { key: 'background', name: 'Imagen de fondo' },
  { key: 'grid', name: 'Cuadrícula' },
];

export interface Settings {
  gridStep: number;
  snapGrid: boolean; snapAngle: boolean; snapObjects: boolean;
  wallThickness: number; wallHeight: number;
  showRoomDims: boolean; showAreas: boolean; showOverallDims: boolean;
  layers: Record<LayerKey, boolean>;
  /** modo sólo visualización: el proyecto es un dibujo importado que se mira e imprime, sin editar */
  viewer?: { file: string } | null;
}

export interface Project {
  app: 'planolibre'; version: 1;
  id: ID; name: string; author: string;
  units: Units; scale: number;
  levels: Level[]; activeLevel: number;
  assets: Record<ID, string>;
  settings: Settings;
  modified: number;
}

export type SelType = 'node' | 'wall' | 'opening' | 'item' | 'dim' | 'label' | 'shape' | 'room' | 'background';
export interface Sel { type: SelType; id: ID }

let counter = 0;
export function uid(prefix = ''): ID {
  counter = (counter + 1) % 1e6;
  return prefix + Date.now().toString(36).slice(-5) + counter.toString(36) + Math.random().toString(36).slice(2, 6);
}

export function newLevel(name = 'Planta baja', elevation = 0): Level {
  return { id: uid('L'), name, elevation, nodes: [], walls: [], openings: [], items: [], dims: [], labels: [], shapes: [], rooms: [], background: null };
}

export function defaultSettings(): Settings {
  return {
    gridStep: 0.05, snapGrid: true, snapAngle: true, snapObjects: true,
    wallThickness: 0.15, wallHeight: 2.4,
    showRoomDims: true, showAreas: true, showOverallDims: true,
    layers: { walls: true, openings: true, items: true, dims: true, rooms: true, labels: true, shapes: true, background: true, grid: true },
  };
}

export function newProject(name = 'Plano sin título'): Project {
  return {
    app: 'planolibre', version: 1, id: uid('P'), name, author: '',
    units: 'm', scale: 100, levels: [newLevel()], activeLevel: 0,
    assets: {}, settings: defaultSettings(), modified: Date.now(),
  };
}

/** Acepta un objeto leído de archivo y lo completa con valores por defecto. */
export function normalizeProject(raw: any): Project {
  if (!raw || raw.app !== 'planolibre' || !Array.isArray(raw.levels)) throw new Error('El archivo no es un proyecto de PlanoLibre válido.');
  const base = newProject(raw.name || 'Plano');
  const p: Project = { ...base, ...raw, settings: { ...base.settings, ...(raw.settings || {}) } };
  p.settings.layers = { ...base.settings.layers, ...((raw.settings && raw.settings.layers) || {}) };
  p.levels = raw.levels.map((l: any, i: number) => ({ ...newLevel(l.name || `Nivel ${i + 1}`), ...l }));
  if (!p.levels.length) p.levels = [newLevel()];
  p.activeLevel = Math.min(Math.max(0, p.activeLevel | 0), p.levels.length - 1);
  p.assets = raw.assets || {};
  return p;
}
