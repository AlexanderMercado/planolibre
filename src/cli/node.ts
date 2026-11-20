// Lo que sólo existe fuera del navegador: carpeta de trabajo, lectura de DWG con
// el WebAssembly tomado de node_modules y rasterizado de SVG a PNG.

import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Project } from '../core/model';
import { ComandoError } from '../agent/commands';
import { guardarProyecto, leerProyecto } from '../agent/io';
import type { CadDoc } from '../io/cad';
import { parseDxf } from '../io/dxf';
import { readDwgWith } from '../io/dwg';

const require = createRequire(import.meta.url);

/** Acceso a archivos limitado a una carpeta: nada se lee ni escribe fuera de ella. */
export class Carpeta {
  readonly raiz: string;
  constructor(raiz: string) { this.raiz = path.resolve(raiz); }
  ruta(rel: string): string {
    if (typeof rel !== 'string' || !rel.trim()) throw new ComandoError('Falta el nombre del archivo.');
    const abs = path.resolve(this.raiz, rel);
    const r = path.relative(this.raiz, abs);
    if (r.startsWith('..') || path.isAbsolute(r)) throw new ComandoError(`"${rel}" queda fuera de la carpeta de trabajo. Usa una ruta relativa dentro de ella.`);
    return abs;
  }
  /** Los proyectos siempre terminan en .plano */
  plano(rel: string): string { return this.ruta(/\.(plano|json)$/i.test(rel) ? rel : rel + '.plano'); }
  async leer(rel: string): Promise<Project> {
    const f = this.plano(rel);
    let txt: string;
    try { txt = await readFile(f, 'utf8'); } catch { throw new ComandoError(`No existe el plano "${path.relative(this.raiz, f)}". Créalo con crear_plano o impórtalo.`); }
    return leerProyecto(txt);
  }
  async guardar(rel: string, p: Project): Promise<string> {
    const f = this.plano(rel);
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, guardarProyecto(p));
    return path.relative(this.raiz, f);
  }
  async leerBytes(rel: string): Promise<Buffer> {
    const f = this.ruta(rel);
    try { return await readFile(f); } catch { throw new ComandoError(`No existe el archivo "${rel}" en la carpeta de trabajo.`); }
  }
  async escribir(rel: string, bytes: Uint8Array): Promise<string> {
    const f = this.ruta(rel);
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, bytes);
    return path.relative(this.raiz, f);
  }
}

let dwgLib: Promise<{ mod: any; lib: any }> | null = null;

/** Lee un dibujo CAD desde sus bytes, según la extensión. */
export async function leerCad(bytes: Buffer, nombre: string): Promise<CadDoc> {
  const ext = path.extname(nombre).toLowerCase();
  if (ext === '.dxf') {
    let txt: string;
    try { txt = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { txt = new TextDecoder('windows-1252').decode(bytes); }
    return parseDxf(txt);
  }
  if (ext === '.dwg') {
    if (!dwgLib) dwgLib = (async () => {
      const mod: any = await import('@mlightcad/libredwg-web');
      // el paquete no publica la ruta del .wasm: se ubica a partir de su archivo principal
      const wasm = path.join(path.dirname(require.resolve('@mlightcad/libredwg-web')), '..', 'wasm', 'libredwg-web.wasm');
      const inst = await mod.createModule({ wasmBinary: await readFile(wasm), locateFile: (n: string) => (n.endsWith('.wasm') ? wasm : n) });
      return { mod, lib: mod.LibreDwg.createByWasmInstance(inst) };
    })();
    const { mod, lib } = await dwgLib;
    return readDwgWith(mod, lib, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  }
  throw new ComandoError('Sólo se importan archivos .dxf y .dwg.');
}

/** Convierte un SVG en PNG. Devuelve null si el rasterizador opcional no está instalado. */
export async function svgAPng(svg: string, anchoPx: number): Promise<Uint8Array | null> {
  let Resvg: any;
  try { ({ Resvg } = await import('@resvg/resvg-js')); } catch { return null; }
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: Math.round(anchoPx) }, background: '#ffffff', font: { loadSystemFonts: true, defaultFontFamily: 'Arial' } });
  return r.render().asPng();
}
