import type { ID, Level, Project, Sel } from './model';
import { newProject } from './model';
import { computeRooms, syncRoomMetas, wallGeoms, type Room, type WallGeom } from './topology';
import type { ViewMode } from './themes';

export type Ev = 'change' | 'select' | 'tool' | 'view' | 'project';
type Listener = (ev: Ev) => void;

const HISTORY_LIMIT = 80;

/** Estado central de la aplicación, con historial para deshacer/rehacer. */
export class Store {
  project: Project = newProject();
  selection: Sel[] = [];
  tool = 'select';
  /** símbolo que se está colocando con la herramienta de mobiliario */
  placing: string | null = null;
  viewMode: ViewMode = 'color';
  advanced = false;
  version = 0;

  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private listeners: Listener[] = [];
  private cache: { v: number; level: ID; rooms: Room[]; geoms: Map<ID, WallGeom> } | null = null;

  on(fn: Listener) { this.listeners.push(fn); }
  emit(ev: Ev) { for (const fn of this.listeners) fn(ev); }

  get level(): Level { return this.project.levels[this.project.activeLevel]; }
  /** ¿el proyecto está abierto en modo sólo visualización? */
  get viewer(): boolean { return !!this.project.settings.viewer; }

  /** Recintos y geometría de muros del nivel activo (con caché por versión). */
  derived(): { rooms: Room[]; geoms: Map<ID, WallGeom> } {
    const lv = this.level;
    if (!this.cache || this.cache.v !== this.version || this.cache.level !== lv.id) {
      const rooms = computeRooms(lv);
      syncRoomMetas(rooms);
      this.cache = { v: this.version, level: lv.id, rooms, geoms: wallGeoms(lv) };
    }
    return this.cache;
  }

  private snapshot(): string {
    return JSON.stringify({ levels: this.project.levels, activeLevel: this.project.activeLevel });
  }
  private restore(s: string) {
    const d = JSON.parse(s);
    this.project.levels = d.levels;
    this.project.activeLevel = Math.min(d.activeLevel, d.levels.length - 1);
    this.selection = [];
    this.touch();
    this.emit('select');
  }

  /** Guarda el estado actual en el historial. Llamar ANTES de modificar el modelo. */
  checkpoint() {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
  }
  /** Avisa que el modelo cambió. */
  touch() {
    this.version++;
    this.project.modified = Date.now();
    this.emit('change');
  }
  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }
  undo() {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(this.snapshot());
    this.restore(s);
  }
  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(this.snapshot());
    this.restore(s);
  }
  /** Descarta el último punto de control (cuando una acción no cambió nada). */
  dropCheckpoint() { this.undoStack.pop(); }

  setProject(p: Project) {
    this.project = p;
    this.undoStack = []; this.redoStack = [];
    this.selection = [];
    this.cache = null;
    this.version++;
    this.emit('project');
    this.emit('change');
    this.emit('select');
  }

  select(sel: Sel[], additive = false) {
    if (this.viewer) sel = [];
    if (additive) {
      const cur = this.selection.slice();
      for (const s of sel) {
        const i = cur.findIndex(c => c.type === s.type && c.id === s.id);
        if (i >= 0) cur.splice(i, 1); else cur.push(s);
      }
      this.selection = cur;
    } else this.selection = sel;
    this.emit('select');
  }
  isSelected(type: Sel['type'], id: ID) { return this.selection.some(s => s.type === type && s.id === id); }

  setTool(tool: string, placing: string | null = null) {
    // en el visor sólo se puede mover la vista y medir
    if (this.viewer && tool !== 'hand' && tool !== 'measure') { tool = 'hand'; placing = null; }
    this.tool = tool; this.placing = placing;
    this.emit('tool');
  }
  setViewMode(m: ViewMode) { this.viewMode = m; this.emit('view'); }
  setAdvanced(v: boolean) { this.advanced = v; this.emit('view'); }
}

export const store = new Store();
