// Entrada y salida para agentes y línea de comandos: leer y guardar proyectos,
// importar dibujos CAD y exportar a los formatos de la app. Trabaja con texto y
// bytes; no toca el sistema de archivos (eso lo hace quien llama).

import type { Project } from '../core/model';
import { newProject, normalizeProject } from '../core/model';
import { convertShapes } from '../core/convert';
import { buildScene } from '../core/scene';
import { THEMES } from '../core/themes';
import { cadBounds, cadToShapes, flatten, guessUnitFactor, type CadDoc } from '../io/cad';
import { writeDxf } from '../io/dxf';
import { exportPdf, PAPERS, resolveScale, sceneFor } from '../io/pdf';
import { centerOffset, exportPosterPdf, fitPosterScale, fmtScale, posterLayout, type PosterOpts } from '../io/poster';
import { exportSvg } from '../io/raster';
import { ComandoError } from './commands';

export const leerProyecto = (texto: string): Project => {
  let raw: unknown;
  try { raw = JSON.parse(texto); } catch { throw new ComandoError('El archivo no es un proyecto .plano válido (no es JSON).'); }
  try { return normalizeProject(raw); } catch (e: any) { throw new ComandoError(e?.message || 'El archivo no es un proyecto de PlanoLibre.'); }
};
export const guardarProyecto = (p: Project): string => { p.modified = Date.now(); return JSON.stringify(p); };

const TEMAS = { tecnico: 'tech', color: 'color', blueprint: 'blue' } as const;
export type Tema = keyof typeof TEMAS;
const UNIDAD_M: Record<string, number> = { mm: 0.001, cm: 0.01, m: 1, in: 0.0254, ft: 0.3048 };

// ───────────────────────── importar ─────────────────────────

export interface ImportOpts { modo?: 'muros' | 'calco' | 'visor'; unidad?: 'mm' | 'cm' | 'm' | 'in' | 'ft' }

/** Convierte un dibujo CAD ya leído (DXF o DWG) en un proyecto nuevo. */
export function importarCad(doc: CadDoc, nombre: string, o: ImportOpts = {}): { proyecto: Project; info: Record<string, unknown> } {
  const ents = flatten(doc), b = cadBounds(ents);
  if (!ents.length || !b) throw new ComandoError('El archivo no contiene geometría 2D que se pueda importar.');
  if (o.unidad && !UNIDAD_M[o.unidad]) throw new ComandoError('"unidad" debe ser mm, cm, m, in o ft.');
  const factor = o.unidad ? UNIDAD_M[o.unidad] : guessUnitFactor(doc, ents);
  const p = newProject(nombre), lv = p.levels[0];
  const shapes = cadToShapes(ents, factor, { x: 0, y: 0 });
  const modo = o.modo || 'muros';
  const porCapa: Record<string, number> = {};
  for (const s of shapes) porCapa[s.layer || '0'] = (porCapa[s.layer || '0'] || 0) + 1;
  const info: Record<string, unknown> = {
    elementos: ents.length,
    elementos_por_capa: porCapa,
    unidad_usada: Object.keys(UNIDAD_M).find(k => Math.abs(UNIDAD_M[k] - factor) < 1e-9) || factor,
    unidad_declarada_en_el_archivo: !!doc.insUnits,
    // todo el dibujo original, con sus cotas y textos; el tamaño de la construcción está en resumen.limites
    tamano_dibujo_original_m: { ancho: Math.round((b.maxX - b.minX) * factor * 100) / 100, largo: Math.round((b.maxY - b.minY) * factor * 100) / 100 },
    modo,
  };
  if (modo === 'muros') {
    const res = convertShapes(lv, shapes, { height: p.settings.wallHeight, keepRest: true });
    if (res.walls) {
      lv.shapes = res.rest;
      Object.assign(info, {
        muros: res.walls, puertas: res.doors, ventanas: res.windows, vanos: res.gaps, recintos_con_nombre: res.named, resto_como_calco: res.rest.length,
        nota: `De ${shapes.length} elementos, las líneas de muros, puertas y ventanas pasaron a ser elementos editables y ${res.rest.length} quedaron como calco. Las cotas y superficies que traía el dibujo no se conservan: el plano las calcula solo.`,
      });
    } else {
      lv.shapes = shapes;
      Object.assign(info, { muros: 0, aviso: 'No se reconocieron muros (se buscan dos líneas paralelas separadas entre 5 y 45 cm). El dibujo quedó como calco; revisa la unidad.' });
    }
  } else {
    lv.shapes = shapes;
    if (modo === 'visor') { p.settings.viewer = { file: nombre }; p.settings.layers.grid = false; }
  }
  return { proyecto: p, info };
}

// ───────────────────────── exportar ─────────────────────────

export type Formato = 'plano' | 'dxf' | 'svg' | 'pdf' | 'pdf_hojas';
export interface ExportOpts {
  tema?: Tema;
  /** denominador de la escala (50 = 1:50). Si falta: PDF usa la mayor que quepa en la hoja; el resto, la del plano. */
  escala?: number;
  papel?: string;
  horizontal?: boolean;
  cajetin?: boolean;
  cuadro_superficies?: boolean;
  unidad_dxf?: 'm' | 'cm' | 'mm';
  /** pdf_hojas: en lugar de una escala, que el plano entre en estas hojas a lo ancho y a lo alto */
  hojas_ancho?: number; hojas_alto?: number;
  margen_mm?: number; traslape_mm?: number;
}

export async function exportar(p: Project, formato: Formato, o: ExportOpts = {}): Promise<{ bytes: Uint8Array; ext: string; info: Record<string, unknown> }> {
  const enc = (s: string) => new TextEncoder().encode(s);
  const tema = TEMAS[o.tema || 'tecnico'];
  if (!tema) throw new ComandoError('"tema" debe ser tecnico, color o blueprint.');
  const papel = o.papel || 'A4';
  if (!PAPERS[papel]) throw new ComandoError(`"papel" debe ser uno de: ${Object.keys(PAPERS).join(', ')}.`);
  const landscape = o.horizontal !== false;
  if (o.escala !== undefined && !(o.escala >= 1 && o.escala <= 5000)) throw new ComandoError('"escala" debe estar entre 1 y 5000.');
  const lv = p.levels[p.activeLevel], st = p.settings;

  if (formato === 'plano') return { bytes: enc(guardarProyecto(p)), ext: 'plano', info: {} };
  if (formato === 'dxf') {
    const u = o.unidad_dxf || 'm';
    const k = u === 'm' ? 1 : u === 'cm' ? 100 : u === 'mm' ? 1000 : 0;
    if (!k) throw new ComandoError('"unidad_dxf" debe ser m, cm o mm.');
    const prims = buildScene(lv, { theme: THEMES.tech, annot: (o.escala || p.scale) / 1000, units: p.units, layers: { ...st.layers, grid: false, background: false }, showRoomDims: st.showRoomDims, showAreas: st.showAreas, showOverallDims: st.showOverallDims });
    return { bytes: enc(writeDxf(prims, k)), ext: 'dxf', info: { unidad: u, nota: 'Para DWG: abre este DXF en AutoCAD u ODA File Converter y guárdalo como DWG.' } };
  }
  if (formato === 'svg') {
    const q = o.escala ? { ...p, scale: o.escala } : p;
    return { bytes: enc(exportSvg(q, tema)), ext: 'svg', info: { escala: `1:${fmtScale(q.scale)}` } };
  }
  if (formato === 'pdf') {
    const opts = { paper: papel, landscape, scale: o.escala ?? ('fit' as const), titleBlock: o.cajetin !== false, allLevels: false, includeBackground: false, schedule: !!o.cuadro_superficies, theme: tema };
    const blob = await exportPdf(p, opts);
    return { bytes: new Uint8Array(await blob.arrayBuffer()), ext: 'pdf', info: { papel, escala: `1:${resolveScale(p, lv, opts)}`, paginas: 1 + (opts.schedule ? 1 : 0), nota: o.escala ? 'Si el plano no cabe en la hoja a esa escala, queda recortado: usa pdf_hojas.' : 'Se usó la mayor escala estándar que cabe en la hoja.' } };
  }
  if (formato === 'pdf_hojas') {
    const po: PosterOpts = { paper: papel, landscape, scale: o.escala || p.scale, margin: o.margen_mm ?? 10, overlap: o.traslape_mm ?? 10, region: null, offsetX: 0, offsetY: 0, skipEmpty: true, marks: true, index: true, theme: tema };
    const escena = () => sceneFor(p, lv, THEMES[tema], po.scale);
    if (o.hojas_ancho || o.hojas_alto) {
      const c = Math.max(1, Math.round(o.hojas_ancho || 1)), r = Math.max(1, Math.round(o.hojas_alto || 1));
      // el tamaño de cotas y textos depende de la escala: se afina en un par de pasadas
      for (let i = 0; i < 4; i++) {
        const L = posterLayout(escena(), po);
        if (i > 0 && L.cols <= c && L.rows <= r) break;
        po.scale = i < 3 ? fitPosterScale(L.content, po, c, r) : Math.ceil(po.scale * 1.03 * 10) / 10;
      }
    }
    Object.assign(po, centerOffset(escena(), po));
    const L = posterLayout(escena(), po);
    const blob = await exportPosterPdf(p, po);
    const guia = L.count > 1;
    return { bytes: new Uint8Array(await blob.arrayBuffer()), ext: 'pdf', info: { papel, escala: `1:${fmtScale(po.scale)}`, hojas: L.count, filas: L.rows, columnas: L.cols, paginas: L.count + (guia ? 1 : 0), guia_de_armado: guia, nota: `${guia ? 'La primera página es la guía de armado y las siguientes son las hojas del plano. ' : ''}Imprimir al 100 %, sin "ajustar a la página".` } };
  }
  throw new ComandoError('"formato" debe ser plano, dxf, svg, pdf o pdf_hojas.');
}

/** SVG del plano para una vista previa (se rasteriza aparte si hace falta una imagen). */
export function vistaSvg(p: Project, tema: Tema = 'color'): string {
  return exportSvg(p, TEMAS[tema] || 'color');
}
