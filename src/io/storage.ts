// Guardado local: los proyectos viven en el navegador (IndexedDB) y también
// se pueden guardar/abrir como archivos .plano (JSON) en el disco.

import type { Project } from '../core/model';
import { normalizeProject } from '../core/model';

const DB = 'planolibre', STORE = 'projects';

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(db => new Promise<T>((res, rej) => {
    const t = db.transaction(STORE, mode);
    const rq = fn(t.objectStore(STORE));
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
    t.oncomplete = () => db.close();
  }));
}

export async function saveLocal(p: Project): Promise<void> {
  await tx('readwrite', s => s.put(JSON.parse(JSON.stringify(p))));
  try { localStorage.setItem('planolibre:last', p.id); } catch { /* ignore */ }
}

export interface LocalEntry { id: string; name: string; modified: number; levels: number; walls: number }

export async function listLocal(): Promise<LocalEntry[]> {
  const all = (await tx<any[]>('readonly', s => s.getAll())) || [];
  return all.map(p => ({ id: p.id, name: p.name, modified: p.modified || 0, levels: p.levels?.length || 0, walls: (p.levels || []).reduce((n: number, l: any) => n + (l.walls?.length || 0), 0) }))
    .sort((a, b) => b.modified - a.modified);
}

export async function loadLocal(id: string): Promise<Project | null> {
  const raw = await tx<any>('readonly', s => s.get(id));
  return raw ? normalizeProject(raw) : null;
}

export async function deleteLocal(id: string): Promise<void> {
  await tx('readwrite', s => s.delete(id));
}

export function lastProjectId(): string | null {
  try { return localStorage.getItem('planolibre:last'); } catch { return null; }
}

export function download(name: string, data: Blob | string, mime = 'application/octet-stream') {
  const blob = typeof data === 'string' ? new Blob([data], { type: mime }) : data;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise(res => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = accept; inp.style.display = 'none';
    inp.onchange = () => { res(inp.files && inp.files[0] ? inp.files[0] : null); inp.remove(); };
    inp.addEventListener('cancel', () => { res(null); inp.remove(); });
    document.body.appendChild(inp);
    inp.click();
  });
}

export const safeName = (s: string) => (s || 'plano').replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 80) || 'plano';

let fileHandle: any = null;
export function forgetFileHandle() { fileHandle = null; }

/** Guarda el proyecto como archivo. Si el navegador lo permite, sobrescribe el mismo archivo. */
export async function saveProjectFile(p: Project, saveAs = false): Promise<'saved' | 'downloaded' | 'cancelled'> {
  const json = JSON.stringify(p);
  const w = window as any;
  if (w.showSaveFilePicker) {
    try {
      if (!fileHandle || saveAs) {
        fileHandle = await w.showSaveFilePicker({ suggestedName: safeName(p.name) + '.plano', types: [{ description: 'Proyecto PlanoLibre', accept: { 'application/json': ['.plano'] } }] });
      }
      const ws = await fileHandle.createWritable();
      await ws.write(json);
      await ws.close();
      return 'saved';
    } catch (e: any) {
      if (e && e.name === 'AbortError') return 'cancelled';
      fileHandle = null;
    }
  }
  download(safeName(p.name) + '.plano', json, 'application/json');
  return 'downloaded';
}
