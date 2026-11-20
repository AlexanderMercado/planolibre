// Línea de comandos de PlanoLibre: convertir archivos, ver el resumen de un
// plano y arrancar el servidor MCP para agentes.

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ComandoError, resumen } from '../agent/commands';
import { exportar, importarCad, vistaSvg, type ExportOpts, type Formato } from '../agent/io';
import { crearServidor, type Almacen } from '../agent/mcp';
import { Carpeta, leerCad, svgAPng } from './node';

const AYUDA = `PlanoLibre: planos de planta desde la terminal

Uso:
  planolibre info <plano.plano> [--json]
      Muestra recintos, superficies y advertencias de un plano.

  planolibre convertir <entrada> <salida> [opciones]
      Convierte entre formatos. La entrada puede ser .plano, .dxf o .dwg;
      la salida, .plano, .pdf, .dxf, .svg o .png.
        --escala N        escala 1:N (PDF: si falta, la mayor que quepa)
        --papel A4        A4, A3, A2, A1, A0, Carta u Oficio
        --vertical        hoja vertical (por defecto horizontal)
        --hojas           PDF repartido en varias hojas a la escala dada
        --en AxB          con --hojas: que entre en A hojas de ancho por B de alto
        --tema T          tecnico (por defecto), color o blueprint
        --modo M          al leer DXF/DWG: muros (por defecto), calco o visor
        --unidad U        unidad del DXF/DWG de entrada: mm, cm, m, in o ft
        --ancho PX        ancho de la imagen PNG (por defecto 1600)

  planolibre mcp [--carpeta <dir>]
      Arranca el servidor MCP (stdio) para que un agente dibuje planos.
      Sólo lee y escribe dentro de la carpeta indicada (por defecto, la actual).

Ejemplos:
  planolibre convertir casa.dxf casa.pdf --escala 50 --papel A3
  planolibre convertir casa.plano casa-hojas.pdf --hojas --escala 25
  planolibre info casa.plano
`;

function opciones(args: string[]): { pos: string[]; o: Record<string, string | true> } {
  const pos: string[] = [], o: Record<string, string | true> = {};
  const sinValor = new Set(['json', 'vertical', 'hojas', 'ayuda', 'help', 'version']);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const [k, v] = a.slice(2).split('=');
    if (v !== undefined) o[k] = v;
    else if (sinValor.has(k) || i + 1 >= args.length || args[i + 1].startsWith('--')) o[k] = true;
    else o[k] = args[++i];
  }
  return { pos, o };
}

function version(): string {
  // la ruta se arma por partes para que el empaquetador no la trate como un recurso
  try { return JSON.parse(readFileSync(new URL(['..', 'package.json'].join('/'), import.meta.url), 'utf8')).version; } catch { return '0.0.0'; }
}

async function abrir(c: Carpeta, entrada: string, o: Record<string, string | true>) {
  if (/\.(plano|json)$/i.test(entrada)) return { proyecto: await c.leer(entrada), info: {} as Record<string, unknown> };
  const doc = await leerCad(await c.leerBytes(entrada), entrada);
  return importarCad(doc, path.basename(entrada).replace(/\.(dxf|dwg)$/i, ''), { modo: o.modo as any, unidad: o.unidad as any });
}

async function main() {
  const [comando, ...resto] = process.argv.slice(2);
  const { pos, o } = opciones(resto);
  if (!comando || comando === 'ayuda' || comando === '--help' || comando === '-h' || o.ayuda || o.help) { process.stdout.write(AYUDA); return; }
  if (comando === '--version' || comando === 'version') { console.log(version()); return; }
  // en la terminal las rutas son las del usuario: la "carpeta" es la raíz del disco
  const libre = new Carpeta(path.parse(process.cwd()).root);
  const abs = (f: string) => path.resolve(process.cwd(), f);

  if (comando === 'info') {
    if (!pos[0]) throw new ComandoError('Falta el archivo. Uso: planolibre info <plano.plano>');
    const { proyecto } = await abrir(libre, abs(pos[0]), o);
    const r = resumen(proyecto);
    if (o.json) { console.log(JSON.stringify(r, null, 2)); return; }
    console.log(`${r.nombre} · ${r.nivel} · escala 1:${r.escala}`);
    if (r.limites) console.log(`Tamaño: ${r.limites.ancho} × ${r.limites.largo} m`);
    console.log(`Muros: ${r.muros.cantidad} (${r.muros.largo_total} m) · Aberturas: ${r.aberturas.length} · Muebles: ${r.muebles.length}`);
    console.log(`Superficie útil: ${r.superficie_util_total} m² en ${r.recintos.length} recinto(s)`);
    for (const x of r.recintos) console.log(`  ${(x.nombre || '(sin nombre)').padEnd(24)} ${String(x.superficie).padStart(7)} m²   ${x.ancho_interior} × ${x.largo_interior} m`);
    for (const a of r.advertencias) console.log(`  ! ${a}`);
    return;
  }

  if (comando === 'convertir') {
    if (pos.length < 2) throw new ComandoError('Faltan archivos. Uso: planolibre convertir <entrada> <salida> [opciones]');
    const entrada = abs(pos[0]), salida = abs(pos[1]);
    const { proyecto, info } = await abrir(libre, entrada, o);
    const ext = path.extname(salida).toLowerCase().slice(1);
    const ex: ExportOpts = {
      escala: o.escala ? Number(o.escala) : undefined, papel: typeof o.papel === 'string' ? o.papel : undefined,
      horizontal: !o.vertical, tema: (typeof o.tema === 'string' ? o.tema : undefined) as ExportOpts['tema'],
    };
    if (typeof o.en === 'string') { const m = /^(\d+)\s*[xX×]\s*(\d+)$/.exec(o.en); if (!m) throw new ComandoError('--en debe tener la forma AxB, por ejemplo 3x2.'); ex.hojas_ancho = +m[1]; ex.hojas_alto = +m[2]; }
    let bytes: Uint8Array, detalle: Record<string, unknown> = {};
    if (ext === 'png') {
      const png = await svgAPng(vistaSvg(proyecto, ex.tema || 'color'), o.ancho ? Number(o.ancho) : 1600);
      if (!png) throw new ComandoError('Para exportar PNG falta el paquete opcional @resvg/resvg-js. Instálalo o exporta a svg o pdf.');
      bytes = png;
    } else {
      const formato = (ext === 'pdf' ? (o.hojas || o.en ? 'pdf_hojas' : 'pdf') : ext === 'json' ? 'plano' : ext) as Formato;
      if (!['plano', 'dxf', 'svg', 'pdf', 'pdf_hojas'].includes(formato)) throw new ComandoError(`No se puede exportar a ".${ext}". Formatos: .plano, .pdf, .dxf, .svg, .png.`);
      const r = await exportar(proyecto, formato, ex);
      bytes = r.bytes; detalle = r.info;
    }
    await libre.escribir(salida, bytes);
    const extra = Object.entries({ ...info, ...detalle }).filter(([k]) => k !== 'nota' && k !== 'aviso').map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ');
    console.log(`${path.relative(process.cwd(), salida)} (${(bytes.length / 1024).toFixed(1)} kB)${extra ? '\n  ' + extra : ''}`);
    for (const k of ['aviso', 'nota']) { const v = (info as any)[k] ?? (detalle as any)[k]; if (v) console.log(`  ${v}`); }
    return;
  }

  if (comando === 'mcp') {
    const carpeta = new Carpeta(typeof o.carpeta === 'string' ? o.carpeta : process.cwd());
    const almacen: Almacen = {
      leer: f => carpeta.leer(f), guardar: (f, p) => carpeta.guardar(f, p), leerBytes: f => carpeta.leerBytes(f), escribir: (f, b) => carpeta.escribir(f, b),
      leerCad: (b, n) => leerCad(Buffer.from(b), n), svgAPng,
    };
    await crearServidor(almacen, version()).connect(new StdioServerTransport());
    // stdout es el canal del protocolo: los avisos van por stderr
    console.error(`PlanoLibre MCP ${version()} · carpeta de trabajo: ${carpeta.raiz}`);
    return;
  }

  throw new ComandoError(`Comando desconocido: "${comando}". Usa "planolibre ayuda".`);
}

main().catch(e => {
  console.error(e instanceof ComandoError ? `Error: ${e.message}` : e);
  process.exit(1);
});
