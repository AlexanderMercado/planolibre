// Lectura de archivos DWG mediante LibreDWG compilado a WebAssembly
// (@mlightcad/libredwg-web, GPL-3.0). Se carga sólo cuando se necesita,
// porque el módulo pesa ~8 MB. Todo ocurre en el navegador: el archivo
// nunca sale del computador.

import { bulgePoints, cleanMText, ellipsePoints, splinePoints, type CadDoc, type CadEnt } from './cad';

function convert(e: any): CadEnt | null {
  if (!e || e.isInPaperSpace || e.isVisible === false) return null;
  const layer = String(e.layer || '0');
  const dash = /DASH|HIDDEN|OCULT|TRAZO|CENTER|DOT/i.test(String(e.lineType || '')) || undefined;
  const poly = (vs: { x: number; y: number; bulge?: number }[], closed: boolean): CadEnt | null => {
    if (!vs || vs.length < 2) return null;
    const pts: number[] = [vs[0].x, vs[0].y];
    for (let i = 1; i < vs.length; i++) bulgePoints(vs[i - 1].x, vs[i - 1].y, vs[i].x, vs[i].y, vs[i - 1].bulge || 0, pts);
    const last = vs[vs.length - 1];
    if (closed && Math.abs(last.bulge || 0) > 1e-9) { bulgePoints(last.x, last.y, vs[0].x, vs[0].y, last.bulge || 0, pts); pts.length -= 2; }
    return { k: 'poly', pts, closed, layer, dash };
  };
  switch (e.type) {
    case 'LINE': return { k: 'poly', pts: [e.startPoint.x, e.startPoint.y, e.endPoint.x, e.endPoint.y], layer, dash };
    case 'CIRCLE': return { k: 'circle', x: e.center.x, y: e.center.y, r: e.radius, layer };
    case 'ARC': return { k: 'arc', x: e.center.x, y: e.center.y, r: e.radius, a0: e.startAngle, a1: e.endAngle, layer };
    case 'LWPOLYLINE': return poly(e.vertices, (e.flag & 1) === 1 || (e.flag & 512) === 512);
    case 'POLYLINE2D': case 'POLYLINE3D': case 'POLYLINE': return e.vertices ? poly(e.vertices, (e.flag & 1) === 1) : null;
    case 'ELLIPSE': {
      const r = ellipsePoints(e.center.x, e.center.y, e.majorAxisEndPoint.x, e.majorAxisEndPoint.y, e.axisRatio || 1, e.startAngle || 0, e.endAngle ?? Math.PI * 2);
      return { k: 'poly', pts: r.pts, closed: r.closed, layer, dash };
    }
    case 'SPLINE': {
      const ctrl: number[] = (e.controlPoints || []).flatMap((p: any) => [p.x, p.y]);
      const fit: number[] = (e.fitPoints || []).flatMap((p: any) => [p.x, p.y]);
      const pts = ctrl.length >= 4 ? splinePoints(ctrl, e.knots || [], e.degree || 3) : fit;
      return pts.length >= 4 ? { k: 'poly', pts, closed: (e.flag & 1) === 1, layer, dash } : null;
    }
    case 'TEXT': case 'ATTRIB': {
      const t = e.text && typeof e.text === 'object' ? e.text : e;
      const ha = t.halign || 0, va = t.valign || 0;
      const aligned = (ha === 1 || ha === 2 || ha === 4 || va > 0) && !!t.endPoint;
      const p = aligned ? t.endPoint : t.startPoint || e.startPoint;
      if (!p) return null;
      return {
        k: 'text', x: p.x, y: p.y, h: t.textHeight || 1, rot: t.rotation || 0, text: cleanMText(String(t.text ?? '')), layer,
        align: aligned ? (ha === 1 || ha === 4 ? 'c' : ha === 2 ? 'r' : 'l') : 'l', mid: aligned && (va === 2 || ha === 4),
      };
    }
    case 'MTEXT': {
      const h = e.textHeight || 1, clean = cleanMText(String(e.text || ''));
      let rot = e.rotation || 0;
      if (e.direction && (Math.abs(e.direction.x) > 1e-9 || Math.abs(e.direction.y) > 1e-9)) rot = Math.atan2(e.direction.y, e.direction.x);
      const att = e.attachmentPoint || 1, col = (att - 1) % 3, row = Math.floor((att - 1) / 3);
      const w = clean.length * h * 0.6;
      const dx = col === 1 ? -w / 2 : col === 2 ? -w : 0, dy = row === 0 ? -h : row === 1 ? -h / 2 : 0;
      const c = Math.cos(rot), s = Math.sin(rot);
      return { k: 'text', x: e.insertionPoint.x + dx * c - dy * s, y: e.insertionPoint.y + dx * s + dy * c, h, rot, text: clean, layer };
    }
    case 'INSERT': return { k: 'insert', name: e.name, x: e.insertionPoint.x, y: e.insertionPoint.y, sx: e.xScale || 1, sy: e.yScale || 1, rot: e.rotation || 0, layer };
    case 'DIMENSION': return e.name ? { k: 'insert', name: e.name, x: 0, y: 0, sx: 1, sy: 1, rot: 0, layer } : null;
    case 'SOLID': case 'TRACE': {
      const c = [e.corner1, e.corner2, e.corner4 || e.corner3, e.corner3].filter(Boolean);
      return c.length >= 3 ? { k: 'poly', pts: c.flatMap((p: any) => [p.x, p.y]), closed: true, layer } : null;
    }
    default: return null;
  }
}

let libPromise: Promise<any> | null = null;

/** Convierte lo que entrega LibreDWG en el documento CAD común. `mod` es el paquete y `lib` la instancia ya creada. */
export function readDwgWith(mod: any, lib: any, data: ArrayBuffer | string, asDxf = false): CadDoc {
  const ptr = lib.dwg_read_data(data, asDxf ? mod.Dwg_File_Type.DXF : mod.Dwg_File_Type.DWG);
  if (!ptr) throw new Error('No se pudo leer el DWG. Puede estar dañado o ser de una versión no soportada.');
  let db: any;
  try { db = lib.convert(ptr); } finally { try { lib.dwg_free(ptr); } catch { /* ignore */ } }
  const doc: CadDoc = { ents: [], blocks: new Map(), insUnits: db?.header?.INSUNITS ?? null };
  for (const b of db?.tables?.BLOCK_RECORD?.entries || []) {
    const name = String(b.name || '');
    if (/^\*(MODEL|PAPER)_SPACE/i.test(name)) continue;
    const ents: CadEnt[] = [];
    for (const e of b.entities || []) { const c = convert(e); if (c) ents.push(c); }
    doc.blocks.set(name, { bx: b.basePoint?.x || 0, by: b.basePoint?.y || 0, ents });
  }
  for (const e of db?.entities || []) { const c = convert(e); if (c) doc.ents.push(c); }
  return doc;
}

export async function parseDwg(data: ArrayBuffer | string, asDxf = false): Promise<CadDoc> {
  const mod = await import('@mlightcad/libredwg-web');
  if (!libPromise) {
    // el .wasm se sirve como recurso estático junto a la app
    const wasmUrl = new URL('../../node_modules/@mlightcad/libredwg-web/wasm/libredwg-web.wasm', import.meta.url).href;
    libPromise = (mod as any).createModule({ locateFile: (name: string) => (name.endsWith('.wasm') ? wasmUrl : name) }).then((w: any) => mod.LibreDwg.createByWasmInstance(w));
  }
  return readDwgWith(mod, await libPromise, data, asDxf);
}
