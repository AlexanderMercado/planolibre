// Servidor MCP de PlanoLibre: expone las operaciones de alto nivel como
// herramientas para agentes. Trabaja sobre archivos .plano de una carpeta; el
// acceso a archivos se recibe ya limitado a esa carpeta (ver `Almacen`).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Project } from '../core/model';
import type { CadDoc } from '../io/cad';
import * as cmd from './commands';
import { ComandoError } from './commands';
import { exportar, importarCad, vistaSvg, type ExportOpts, type Formato } from './io';

/** Lo que el servidor necesita del exterior. La implementación real limita todo a una carpeta. */
export interface Almacen {
  leer(archivo: string): Promise<Project>;
  guardar(archivo: string, p: Project): Promise<string>;
  leerBytes(archivo: string): Promise<Uint8Array>;
  escribir(archivo: string, bytes: Uint8Array): Promise<string>;
  leerCad(bytes: Uint8Array, nombre: string): Promise<CadDoc>;
  /** null si no hay rasterizador disponible */
  svgAPng(svg: string, anchoPx: number): Promise<Uint8Array | null>;
}

export const INSTRUCCIONES = `PlanoLibre dibuja planos de planta. Cada herramienta trabaja sobre un archivo .plano dentro de la carpeta de trabajo, que después se abre y edita en la app.

Convenciones:
- Todas las medidas y coordenadas van en METROS.
- X crece hacia la derecha e Y hacia ABAJO, como en pantalla. El norte del plano es arriba (Y menor).
- En agregar_habitacion, por defecto x, y, ancho y largo son del espacio interior útil. Entre dos habitaciones contiguas deja el grosor del muro: si una termina en x = 4 y el muro mide 0,15, la siguiente empieza en x = 4,15. Así comparten el muro.
- Los muros se unen y se parten solos donde se tocan o se cruzan; los recintos y sus superficies se calculan solos.

- Para puertas y ventanas no hace falta calcular coordenadas: indica "recinto" y "lado" (norte, sur, este u oeste) y, si quieres, "posicion" de 0 a 1 a lo largo de ese lado.
- Muebles: con rotación 0 el respaldo o la cabecera mira al norte. Lo más simple es "apoyar_en_muro", que lo pega al muro más cercano con el respaldo contra él, o "respaldo_hacia".

Forma de trabajar: crea el plano, agrega las habitaciones, luego puertas y ventanas, después los muebles, y revisa con "resumen" y "vista_previa" antes de exportar. Cada herramienta que modifica el plano responde con un estado corto: cuántos recintos hay, la superficie total y las advertencias (muros sin unir, recintos sin puerta, muebles encimados, metidos en un muro o que estorban una puerta). Léelas y corrígelas. "resumen" da el detalle completo, con el rectángulo interior de cada recinto y los ejes de todos los muros.`;

const archivo = z.string().min(1).describe('Archivo del plano dentro de la carpeta de trabajo, por ejemplo "casa.plano".');
const X = z.number().describe('Coordenada X en metros (crece hacia la derecha).');
const Y = z.number().describe('Coordenada Y en metros (crece hacia abajo).');
const punto = z.object({ x: z.number(), y: z.number() });

export function crearServidor(a: Almacen, version = '0.1.0'): McpServer {
  const server = new McpServer({ name: 'planolibre', version }, { instructions: INSTRUCCIONES });
  const texto = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v) }] });
  /** Ejecuta un manejador y convierte los errores esperables en una respuesta que el agente puede leer. */
  const seguro = <T>(fn: (args: T) => Promise<ReturnType<typeof texto> | { content: any[] }>) => async (args: T) => {
    try { return await fn(args); }
    catch (e: any) {
      if (e instanceof ComandoError) return { isError: true, ...texto(e.message) };
      return { isError: true, ...texto('Error inesperado: ' + (e?.message || String(e))) };
    }
  };
  /** Abre el plano, aplica el cambio, lo guarda y responde con el resultado y el resumen. */
  const cambio = <T extends { archivo: string }>(fn: (p: Project, args: T) => unknown) => seguro<T>(async args => {
    const p = await a.leer(args.archivo);
    const resultado = fn(p, args);
    await a.guardar(args.archivo, p);
    return texto({ ok: true, resultado, estado: cmd.estado(p) });
  });
  const modifica = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
  const lectura = { readOnlyHint: true, openWorldHint: false };

  server.registerTool('crear_plano', {
    title: 'Crear plano',
    description: 'Crea un plano vacío y lo guarda. Si el archivo ya existe lo reemplaza, así que úsalo sólo para empezar uno nuevo.',
    inputSchema: { archivo, nombre: z.string().optional().describe('Nombre del proyecto, por ejemplo "Casa de la playa".'), escala: z.number().optional().describe('Denominador de la escala del plano (100 = 1:100). Define el tamaño de textos y cotas.'), unidades: z.enum(['m', 'cm', 'mm', 'ft']).optional().describe('Unidad en que se muestran las medidas en el plano. Las herramientas siempre reciben metros.') },
    annotations: { ...modifica, destructiveHint: true },
  }, seguro(async args => {
    const p = cmd.crearPlano(args);
    const ruta = await a.guardar(args.archivo, p);
    return texto({ ok: true, archivo: ruta, estado: cmd.estado(p) });
  }));

  server.registerTool('agregar_habitacion', {
    title: 'Agregar habitación',
    description: 'Agrega una habitación rectangular completa (sus cuatro muros), unida a los muros que ya existan. Es la forma normal de dibujar: úsala en vez de muros sueltos.',
    inputSchema: {
      archivo, x: X.describe('X de la esquina superior izquierda, en metros.'), y: Y.describe('Y de la esquina superior izquierda, en metros.'),
      ancho: z.number().describe('Medida en X, en metros.'), largo: z.number().describe('Medida en Y, en metros.'),
      nombre: z.string().optional().describe('Nombre del recinto: "Cocina", "Dormitorio 2", "Baño"… Define también su color.'),
      grosor: z.number().optional().describe('Grosor de los muros en metros. Por defecto 0,15. Típico: 0,10 tabique, 0,20 muro exterior.'),
      medidas: z.enum(['interiores', 'ejes']).optional().describe('"interiores" (por defecto): x, y, ancho y largo son del espacio útil. "ejes": son de los ejes de los muros.'),
    },
    annotations: modifica,
  }, cambio((p, args) => cmd.agregarHabitacion(p, args)));

  server.registerTool('agregar_muro', {
    title: 'Agregar muro',
    description: 'Agrega un muro recto entre dos puntos (por su eje). Sirve para tabiques que dividen una habitación o para formas que no son rectangulares.',
    inputSchema: { archivo, x1: X, y1: Y, x2: X, y2: Y, grosor: z.number().optional().describe('Grosor en metros. Por defecto 0,15.') },
    annotations: modifica,
  }, cambio((p, args) => cmd.agregarMuro(p, args)));

  server.registerTool('agregar_abertura', {
    title: 'Agregar puerta, ventana o vano',
    description: 'Coloca una puerta, ventana o vano (paso sin puerta) sobre un muro. Hay dos formas de decir dónde: "recinto" y "lado" (la más simple), o un punto (x, y) sobre el muro o a menos de 60 cm de él.',
    inputSchema: {
      archivo, tipo: z.enum(['puerta', 'ventana', 'vano']),
      recinto: z.string().optional().describe('Nombre del recinto en cuyo muro va, por ejemplo "Cocina". Úsalo junto con "lado".'),
      lado: z.enum(['norte', 'sur', 'este', 'oeste']).optional().describe('Lado del recinto: norte es arriba (Y menor), sur abajo, oeste izquierda, este derecha.'),
      posicion: z.number().optional().describe('Con recinto y lado: posición a lo largo de ese lado, de 0 a 1. 0,5 (por defecto) la centra. Se mide desde el oeste en los lados norte y sur, y desde el norte en los lados este y oeste.'),
      x: X.optional().describe('Alternativa a recinto y lado: X del centro de la abertura, sobre el muro.'), y: Y.optional().describe('Alternativa a recinto y lado: Y del centro de la abertura, sobre el muro.'),
      ancho: z.number().optional().describe('Ancho en metros. Por defecto: puerta 0,80; ventana 1,20; vano 1,00.'),
      estilo: z.enum(['abatible', 'doble', 'corredera', 'fija']).optional().describe('Puertas: abatible, doble o corredera. Ventanas: corredera, abatible o fija.'),
      abre_hacia: punto.optional().describe('Puertas: un punto del lado hacia donde abre. Con recinto y lado, por defecto abre hacia dentro de ese recinto.'),
      bisagra_cerca_de: punto.optional().describe('Puertas: un punto cercano al extremo del vano donde va la bisagra.'),
    },
    annotations: modifica,
  }, cambio((p, args) => cmd.agregarAbertura(p, args)));

  server.registerTool('listar_muebles', {
    title: 'Listar muebles',
    description: 'Devuelve el catálogo de muebles y símbolos (camas, sofás, artefactos de baño y cocina…) con su tipo y medidas, y explica hacia dónde mira cada uno. Consúltalo antes de agregar_mueble.',
    inputSchema: {},
    annotations: lectura,
  }, seguro(async () => texto(cmd.listarMuebles())));

  server.registerTool('agregar_mueble', {
    title: 'Agregar mueble',
    description: 'Coloca un mueble o símbolo del catálogo. x, y son su centro; con "apoyar_en_muro" basta un punto aproximado y el mueble queda pegado al muro más cercano, con el respaldo contra él.',
    inputSchema: {
      archivo, tipo: z.string().describe('Tipo del catálogo, tal como lo entrega listar_muebles.'), x: X.describe('X del centro del mueble.'), y: Y.describe('Y del centro del mueble.'),
      apoyar_en_muro: z.boolean().optional().describe('Pega el mueble al muro más cercano al punto (hasta 2,5 m) y lo gira para que el respaldo o la cabecera quede contra ese muro. Ideal para camas, sofás, clósets y artefactos.'),
      respaldo_hacia: z.enum(['norte', 'sur', 'este', 'oeste']).optional().describe('Hacia dónde queda el respaldo o la cabecera. El frente queda al lado opuesto.'),
      rotacion: z.number().optional().describe('Giro en grados, sentido horario. 0 = respaldo al norte, 90 al este, 180 al sur, 270 al oeste. Se ignora si se usa apoyar_en_muro o respaldo_hacia.'),
      ancho: z.number().optional().describe('Ancho en metros, si no se quiere el del catálogo.'), fondo: z.number().optional().describe('Fondo en metros, si no se quiere el del catálogo.'),
    },
    annotations: modifica,
  }, cambio((p, args) => cmd.agregarMueble(p, args)));

  server.registerTool('mover_mueble', {
    title: 'Mover o girar mueble',
    description: 'Mueve o gira el mueble más cercano a un punto, sin borrarlo. Lo que no se indique se conserva.',
    inputSchema: {
      archivo, x: X.describe('X de un punto cercano al mueble que se quiere mover.'), y: Y.describe('Y de un punto cercano al mueble que se quiere mover.'),
      nuevo_x: z.number().optional().describe('Nueva X del centro.'), nuevo_y: z.number().optional().describe('Nueva Y del centro.'),
      apoyar_en_muro: z.boolean().optional().describe('Pega el mueble al muro más cercano a su nueva posición, con el respaldo contra él.'),
      respaldo_hacia: z.enum(['norte', 'sur', 'este', 'oeste']).optional(),
      rotacion: z.number().optional().describe('Giro en grados, sentido horario. 0 = respaldo al norte.'),
    },
    annotations: modifica,
  }, cambio((p, args) => cmd.moverMueble(p, args)));

  server.registerTool('nombrar_recinto', {
    title: 'Nombrar recinto',
    description: 'Pone o cambia el nombre del recinto cerrado que contiene el punto.',
    inputSchema: { archivo, x: X, y: Y, nombre: z.string() },
    annotations: { ...modifica, idempotentHint: true },
  }, cambio((p, args) => cmd.nombrarRecinto(p, args)));

  server.registerTool('agregar_texto', {
    title: 'Agregar texto',
    description: 'Agrega una nota de texto libre al plano. Para nombrar habitaciones usa nombrar_recinto.',
    inputSchema: { archivo, x: X, y: Y, texto: z.string(), tamano_mm: z.number().optional().describe('Altura del texto en milímetros de papel. Por defecto 3,5.'), rotacion: z.number().optional() },
    annotations: modifica,
  }, cambio((p, args) => cmd.agregarTexto(p, args)));

  server.registerTool('eliminar', {
    title: 'Eliminar elemento',
    description: 'Elimina el muro, abertura, mueble o texto más cercano al punto, y responde qué borró y dónde estaba. Al borrar un muro se van también sus puertas y ventanas. Para corregir un mueble usa mover_mueble.',
    inputSchema: { archivo, tipo: z.enum(['muro', 'abertura', 'mueble', 'texto']), x: X, y: Y },
    annotations: { ...modifica, destructiveHint: true },
  }, cambio((p, args) => cmd.eliminar(p, args)));

  server.registerTool('resumen', {
    title: 'Resumen del plano',
    description: 'Devuelve el plano completo en datos: cada recinto con su superficie, su rectángulo interior y cuántas puertas y ventanas tiene; los ejes de todos los muros; aberturas y muebles con su posición; el tamaño de la construcción y las advertencias. Úsalo para comprobar el trabajo o cuando necesites coordenadas exactas.',
    inputSchema: { archivo },
    annotations: lectura,
  }, seguro(async args => texto(cmd.resumen(await a.leer(args.archivo)))));

  server.registerTool('vista_previa', {
    title: 'Vista previa',
    description: 'Devuelve una imagen del plano para revisarlo visualmente.',
    inputSchema: { archivo, ancho_px: z.number().optional().describe('Ancho de la imagen en píxeles. Por defecto 1000.'), tema: z.enum(['tecnico', 'color', 'blueprint']).optional() },
    annotations: lectura,
  }, seguro(async args => {
    const p = await a.leer(args.archivo);
    const svg = vistaSvg(p, args.tema || 'color');
    const png = await a.svgAPng(svg, Math.max(300, Math.min(2400, args.ancho_px || 1000)));
    if (png) return { content: [{ type: 'image' as const, data: Buffer.from(png).toString('base64'), mimeType: 'image/png' }] };
    return texto('No hay rasterizador de imágenes instalado, así que no se puede generar la imagen. Usa "resumen" para revisar el plano, o exporta a svg o pdf.');
  }));

  server.registerTool('importar', {
    title: 'Importar DXF o DWG',
    description: 'Lee un dibujo DXF o DWG de la carpeta de trabajo y crea un plano a partir de él. En modo "muros" reconoce muros, puertas y ventanas; siempre conviene revisar el resultado.',
    inputSchema: {
      origen: z.string().describe('Archivo .dxf o .dwg dentro de la carpeta de trabajo.'), archivo: archivo.describe('Plano que se creará (se reemplaza si existe).'),
      modo: z.enum(['muros', 'calco', 'visor']).optional().describe('"muros" (por defecto): muros editables. "calco": líneas de referencia. "visor": sólo para ver e imprimir.'),
      unidad: z.enum(['mm', 'cm', 'm', 'in', 'ft']).optional().describe('Unidad del dibujo. Si falta se toma del archivo o se estima por su tamaño: revisa el tamaño que se informa.'),
    },
    annotations: { ...modifica, destructiveHint: true },
  }, seguro(async args => {
    const doc = await a.leerCad(await a.leerBytes(args.origen), args.origen);
    const nombre = args.origen.replace(/^.*[\\/]/, '').replace(/\.(dxf|dwg)$/i, '');
    const { proyecto, info } = importarCad(doc, nombre, { modo: args.modo, unidad: args.unidad });
    const ruta = await a.guardar(args.archivo, proyecto);
    return texto({ ok: true, archivo: ruta, importacion: info, estado: cmd.estado(proyecto) });
  }));

  server.registerTool('exportar', {
    title: 'Exportar',
    description: 'Exporta el plano a PDF a escala (una hoja), PDF repartido en varias hojas, DXF para AutoCAD o SVG, y lo guarda en la carpeta de trabajo. No existe exportación directa a DWG.',
    inputSchema: {
      archivo, formato: z.enum(['pdf', 'pdf_hojas', 'dxf', 'svg']).describe('"pdf": una hoja. "pdf_hojas": plano grande repartido en varias hojas para juntarlas.'),
      salida: z.string().optional().describe('Archivo de salida. Por defecto, el nombre del plano con la extensión del formato.'),
      escala: z.number().optional().describe('Denominador de la escala (50 = 1:50). En "pdf", si falta, se usa la mayor que quepa en la hoja.'),
      papel: z.enum(['A4', 'A3', 'A2', 'A1', 'A0', 'Carta', 'Oficio']).optional(), horizontal: z.boolean().optional().describe('Hoja horizontal (por defecto) o vertical.'),
      tema: z.enum(['tecnico', 'color', 'blueprint']).optional(),
      cajetin: z.boolean().optional().describe('"pdf": incluir el cajetín con nombre, escala y superficie. Por defecto sí.'),
      cuadro_superficies: z.boolean().optional().describe('"pdf": agregar una página con el cuadro de superficies.'),
      hojas_ancho: z.number().optional().describe('"pdf_hojas": en vez de una escala, que entre en este número de hojas a lo ancho.'),
      hojas_alto: z.number().optional().describe('"pdf_hojas": y en este número de hojas a lo alto.'),
      unidad_dxf: z.enum(['m', 'cm', 'mm']).optional(),
    },
    annotations: modifica,
  }, seguro(async args => {
    const p = await a.leer(args.archivo);
    const { archivo: arch, formato, salida, ...opts } = args;
    const r = await exportar(p, formato as Formato, opts as ExportOpts);
    const ruta = await a.escribir(salida || arch.replace(/\.(plano|json)$/i, '') + (formato === 'pdf_hojas' ? '-hojas' : '') + '.' + r.ext, r.bytes);
    return texto({ ok: true, archivo: ruta, bytes: r.bytes.length, ...r.info });
  }));

  return server;
}
