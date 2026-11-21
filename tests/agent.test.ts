import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Project } from '../src/core/model';
import * as cmd from '../src/agent/commands';
import { exportar, guardarProyecto, importarCad, leerProyecto, vistaSvg } from '../src/agent/io';
import { crearServidor, type Almacen } from '../src/agent/mcp';
import { parseDxf } from '../src/io/dxf';
import pruebaDxf from './fixtures/prueba.dxf?raw';

describe('operaciones para agentes', () => {
  it('dos habitaciones contiguas comparten el muro (medidas interiores)', () => {
    const p = cmd.crearPlano({ nombre: 'Casa' });
    cmd.agregarHabitacion(p, { x: 0, y: 0, ancho: 4, largo: 3, nombre: 'Living' });
    // la siguiente empieza donde termina la anterior más el grosor del muro
    cmd.agregarHabitacion(p, { x: 4.15, y: 0, ancho: 3, largo: 3, nombre: 'Dormitorio' });
    const r = cmd.resumen(p);
    expect(r.recintos.length).toBe(2);
    expect(r.muros.cantidad).toBe(7); // 4 + 4 - 1 compartido
    const living = r.recintos.find(x => x.nombre === 'Living')!, dorm = r.recintos.find(x => x.nombre === 'Dormitorio')!;
    expect(living.superficie).toBeCloseTo(12, 2); expect(dorm.superficie).toBeCloseTo(9, 2);
    expect(living.ancho_interior).toBeCloseTo(4, 2); expect(living.largo_interior).toBeCloseTo(3, 2);
    expect(r.superficie_util_total).toBeCloseTo(21, 2);
  });

  it('habitaciones de distinto largo, por ejes, parten el muro común y cierran bien', () => {
    const p = cmd.crearPlano();
    cmd.agregarHabitacion(p, { x: 0, y: 0, ancho: 4, largo: 3, medidas: 'ejes' });
    cmd.agregarHabitacion(p, { x: 4, y: 0, ancho: 3, largo: 5, medidas: 'ejes' });
    const r = cmd.resumen(p);
    expect(r.recintos.length).toBe(2);
    expect(r.advertencias.some(a => a.includes('sin unir'))).toBe(false);
    expect(r.superficie_util_total).toBeCloseTo((4 - 0.15) * (3 - 0.15) + (3 - 0.15) * (5 - 0.15), 1);
  });

  it('coloca puertas y ventanas sobre el muro más cercano y explica los errores', () => {
    const p = cmd.crearPlano();
    cmd.agregarHabitacion(p, { x: 0, y: 0, ancho: 4, largo: 3, nombre: 'Cocina' });
    const puerta = cmd.agregarAbertura(p, { tipo: 'puerta', x: 2, y: 3.1, abre_hacia: { x: 2, y: 1.5 } });
    expect(puerta.ancho).toBe(0.8);
    expect(puerta.centro.y).toBeCloseTo(3.08, 1);
    cmd.agregarAbertura(p, { tipo: 'ventana', x: 2, y: -0.07, ancho: 1.5, estilo: 'corredera' });
    const r = cmd.resumen(p);
    expect(r.aberturas.map(a => a.tipo).sort()).toEqual(['puerta', 'ventana']);
    expect(() => cmd.agregarAbertura(p, { tipo: 'puerta', x: 2, y: 1.5 })).toThrow(/menos de 60 cm/);
    expect(() => cmd.agregarAbertura(p, { tipo: 'ventana', x: 2, y: 0, ancho: 9 })).toThrow(/no cabe/);
    expect(() => cmd.agregarMueble(p, { tipo: 'nave-espacial', x: 1, y: 1 })).toThrow(/listar_muebles/);
    expect(() => cmd.nombrarRecinto(p, { x: 50, y: 50, nombre: 'Patio' })).toThrow(/ningún recinto/);
  });

  it('el resumen avisa de lo que falta y eliminar deshace', () => {
    const p = cmd.crearPlano();
    cmd.agregarHabitacion(p, { x: 0, y: 0, ancho: 4, largo: 3 });
    cmd.agregarMuro(p, { x1: 2, y1: 1, x2: 2, y2: 2 }); // tabique suelto en medio
    cmd.agregarMueble(p, { tipo: cmd.listarMuebles().muebles[0].tipo, x: 20, y: 20 });
    let r = cmd.resumen(p);
    expect(r.advertencias.join(' ')).toMatch(/sin unir/);
    expect(r.advertencias.join(' ')).toMatch(/no tienen nombre/);
    expect(r.advertencias.join(' ')).toMatch(/fuera de todo recinto/);
    expect(r.advertencias.join(' ')).toMatch(/Sin puerta ni vano/);
    cmd.eliminar(p, { tipo: 'muro', x: 2, y: 1.5 });
    cmd.eliminar(p, { tipo: 'mueble', x: 20, y: 20 });
    cmd.nombrarRecinto(p, { x: 2, y: 1.5, nombre: 'Baño' });
    cmd.nombrarRecinto(p, { x: 2, y: 1.5, nombre: 'Baño principal' }); // renombra, no duplica
    r = cmd.resumen(p);
    expect(r.muros.cantidad).toBe(4);
    expect(r.recintos[0].nombre).toBe('Baño principal');
    expect(p.levels[0].rooms.length).toBe(1);
    expect(r.advertencias.join(' ')).not.toMatch(/sin unir|fuera de todo/);
  });

  it('importa un DXF como muros y exporta a todos los formatos', async () => {
    const { proyecto, info } = importarCad(parseDxf(pruebaDxf), 'prueba', {});
    expect(info.muros).toBe(4);
    expect(cmd.resumen(proyecto).superficie_util_total).toBeCloseTo(22.31, 2);
    const ida = leerProyecto(guardarProyecto(proyecto));
    expect(ida.levels[0].walls.length).toBe(4);
    const txt = (b: Uint8Array) => new TextDecoder('latin1').decode(b);
    expect(txt((await exportar(proyecto, 'dxf')).bytes)).toContain('MUROS');
    expect(txt((await exportar(proyecto, 'svg')).bytes)).toContain('<svg');
    expect(vistaSvg(proyecto)).toContain('<svg');
    const pdf = await exportar(proyecto, 'pdf', { papel: 'A4' });
    expect(txt(pdf.bytes).startsWith('%PDF')).toBe(true);
    expect(pdf.info.escala).toBe('1:50');
    const hojas = await exportar(proyecto, 'pdf_hojas', { hojas_ancho: 2, hojas_alto: 2 });
    expect(hojas.info.hojas).toBeLessThanOrEqual(4);
    expect(hojas.info.hojas).toBeGreaterThan(1);
    await expect(exportar(proyecto, 'pdf', { papel: 'A9' })).rejects.toThrow(/papel/);
    expect(() => leerProyecto('{"no":"es un plano"}')).toThrow();
  });
});

describe('lo que pidió el agente de prueba', () => {
  const casa = () => {
    const p = cmd.crearPlano({ nombre: 'Casa' });
    cmd.agregarHabitacion(p, { x: 0, y: 0, ancho: 4, largo: 3, nombre: 'Living' });
    cmd.agregarHabitacion(p, { x: 4.15, y: 0, ancho: 3, largo: 3, nombre: 'Dormitorio' });
    return p;
  };

  it('los límites son los de la construcción, sin contar muebles', () => {
    const p = casa();
    cmd.agregarMueble(p, { tipo: 'bed2', x: 5.6, y: 1.5 });
    const r = cmd.resumen(p);
    expect(r.limites!.ancho).toBeCloseTo(7.45, 3);   // 4 + 3 interiores + 3 muros de 0,15
    expect(r.limites!.largo).toBeCloseTo(3.3, 3);
    expect(r.muros.ejes.length).toBe(7);
    expect(r.recintos.find(x => x.nombre === 'Living')!.interior).toEqual({ x1: 0, y1: 0, x2: 4, y2: 3 });
  });

  it('avisa recinto por recinto cuál no tiene puerta, y el vano no tiene estilo', () => {
    const p = casa();
    expect(cmd.resumen(p).advertencias.join(' ')).toMatch(/Sin puerta ni vano: Living; Dormitorio/);
    cmd.agregarAbertura(p, { tipo: 'puerta', recinto: 'Living', lado: 'sur' });
    let r = cmd.resumen(p);
    // el Living ya tiene puerta; el Dormitorio sigue sin ninguna
    expect(r.advertencias.join(' ')).toMatch(/Sin puerta ni vano: Dormitorio\./);
    expect(r.recintos.find(x => x.nombre === 'Living')!.puertas).toBe(1);
    cmd.agregarAbertura(p, { tipo: 'vano', recinto: 'Dormitorio', lado: 'oeste' }); // muro compartido
    r = cmd.resumen(p);
    expect(r.advertencias.join(' ')).not.toMatch(/Sin puerta/);
    expect(r.aberturas.find(a => a.tipo === 'vano')!.estilo).toBeNull();
    expect(r.recintos.find(x => x.nombre === 'Living')!.puertas).toBe(2);
  });

  it('ubica aberturas por recinto y lado, sin calcular ejes, y devuelve coordenadas exactas', () => {
    const p = casa();
    const v = cmd.agregarAbertura(p, { tipo: 'ventana', recinto: 'living', lado: 'norte', posicion: 0.25, ancho: 1 });
    expect(v.centro).toEqual({ x: 1, y: -0.075 });   // eje del muro norte, al milímetro
    const d = cmd.agregarAbertura(p, { tipo: 'puerta', recinto: 'Dormitorio', lado: 'sur' });
    expect(d.centro).toEqual({ x: 5.65, y: 3.075 });
    // por defecto abre hacia dentro del recinto indicado
    const lv = p.levels[0], op = lv.openings[lv.openings.length - 1];
    const w = lv.walls.find(x => x.id === op.wall)!, a = lv.nodes.find(n => n.id === w.a)!, b = lv.nodes.find(n => n.id === w.b)!;
    const haciaAdentro = (-(b.y - a.y) * 0 + (b.x - a.x) * (1.5 - 3.075)) * (op.flipV ? -1 : 1) > 0; // normal (−dy, dx) · (centro − puerta)
    expect(haciaAdentro).toBe(true);
    expect(() => cmd.agregarAbertura(p, { tipo: 'puerta', recinto: 'Cocina', lado: 'sur' })).toThrow(/Recintos: Living, Dormitorio/);
    expect(() => cmd.agregarAbertura(p, { tipo: 'puerta' })).toThrow(/recinto.*lado/);
  });

  it('apoya los muebles en el muro, con el respaldo contra él, y los mueve sin borrarlos', () => {
    const p = casa();
    // cerca del muro norte del Dormitorio: la cabecera queda al norte y la cama pegada al muro
    const cama = cmd.agregarMueble(p, { tipo: 'bed2', x: 5.6, y: 0.6, apoyar_en_muro: true });
    expect(cama.rotacion).toBe(0);
    expect(cama.y).toBeCloseTo(1.0, 3);                // cara interior en y = 0, fondo de 2 m
    // cerca del muro este: el respaldo queda al este
    const closet = cmd.agregarMueble(p, { tipo: 'wardrobe', x: 6.8, y: 2.2, apoyar_en_muro: true });
    expect(closet.rotacion).toBe(90);
    expect(closet.x).toBeCloseTo(7.15 - 0.3, 3);
    expect(cmd.agregarMueble(p, { tipo: 'sofa3', x: 2, y: 2, respaldo_hacia: 'sur' }).rotacion).toBe(180);
    const m = cmd.moverMueble(p, { x: 2, y: 2, nuevo_y: 1.5, respaldo_hacia: 'oeste' });
    expect(m).toEqual({ tipo: 'sofa3', x: 2, y: 1.5, rotacion: 270 });
    expect(p.levels[0].items.length).toBe(3);
    expect(cmd.eliminar(p, { tipo: 'mueble', x: 2, y: 1.5 })).toEqual({ eliminado: 'sofa3', x: 2, y: 1.5 });
    expect(cmd.listarMuebles().orientacion).toMatch(/respaldo.*norte/);
  });

  it('avisa de muebles encimados, metidos en un muro o que estorban una puerta', () => {
    const p = casa();
    cmd.agregarAbertura(p, { tipo: 'puerta', recinto: 'Living', lado: 'sur' });
    cmd.agregarAbertura(p, { tipo: 'vano', recinto: 'Dormitorio', lado: 'oeste' });
    cmd.agregarMueble(p, { tipo: 'bed2', x: 5.6, y: 0.6, apoyar_en_muro: true });
    cmd.agregarMueble(p, { tipo: 'nightstand', x: 4.5, y: 0.25 });          // al lado de la cama, sin tocarla
    expect(cmd.resumen(p).advertencias).toEqual([]);
    cmd.agregarMueble(p, { tipo: 'bed1', x: 5.9, y: 1.2 });                 // encima de la otra cama
    cmd.agregarMueble(p, { tipo: 'wardrobe', x: 6.2, y: 3.05 });            // atravesando el muro sur
    cmd.agregarMueble(p, { tipo: 'armchair', x: 2, y: 2.5 });               // justo delante de la puerta del Living
    const adv = cmd.resumen(p).advertencias.join(' | ');
    expect(adv).toMatch(/se enciman: bed2 .* con bed1/);
    expect(adv).toMatch(/dentro de un muro: wardrobe/);
    expect(adv).toMatch(/barrido de una puerta: armchair/);
  });

  it('explica la guía de armado al exportar en varias hojas', async () => {
    const { proyecto } = importarCad(parseDxf(pruebaDxf), 'prueba', {});
    const hojas = await exportar(proyecto, 'pdf_hojas', { escala: 20 });
    expect(hojas.info.paginas).toBe((hojas.info.hojas as number) + 1);
    expect(hojas.info.guia_de_armado).toBe(true);
    expect(hojas.info.nota).toMatch(/primera página es la guía de armado/);
  });
});

describe('servidor MCP', () => {
  /** Almacén en memoria: lo mismo que la carpeta real, sin tocar el disco. */
  const memoria = () => {
    const archivos = new Map<string, Uint8Array>();
    const enc = new TextEncoder(), dec = new TextDecoder();
    const plano = (f: string) => (/\.plano$/.test(f) ? f : f + '.plano');
    const a: Almacen = {
      leer: async f => { const b = archivos.get(plano(f)); if (!b) throw new cmd.ComandoError(`No existe el plano "${plano(f)}".`); return leerProyecto(dec.decode(b)); },
      guardar: async (f, p: Project) => { archivos.set(plano(f), enc.encode(guardarProyecto(p))); return plano(f); },
      leerBytes: async f => { const b = archivos.get(f); if (!b) throw new cmd.ComandoError(`No existe "${f}".`); return b; },
      escribir: async (f, b) => { archivos.set(f, b); return f; },
      leerCad: async b => parseDxf(dec.decode(b)),
      svgAPng: async () => null,
    };
    return { a, archivos, enc };
  };
  const conectar = async (a: Almacen) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await crearServidor(a).connect(s);
    const client = new Client({ name: 'prueba', version: '1.0.0' });
    await client.connect(c);
    return client;
  };
  const llamar = async (client: Client, name: string, args: Record<string, unknown>) => {
    const r: any = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text as string;
    return { error: !!r.isError, text, data: r.isError ? null : JSON.parse(text) };
  };

  it('publica sus herramientas con descripción y esquema', async () => {
    const client = await conectar(memoria().a);
    const { tools } = await client.listTools();
    const nombres = tools.map(t => t.name).sort();
    expect(nombres).toEqual(['agregar_abertura', 'agregar_habitacion', 'agregar_mueble', 'agregar_muro', 'agregar_texto', 'crear_plano', 'eliminar', 'exportar', 'importar', 'listar_muebles', 'mover_mueble', 'nombrar_recinto', 'resumen', 'vista_previa']);
    for (const t of tools) { expect((t.description || '').length).toBeGreaterThan(30); expect(t.inputSchema.type).toBe('object'); }
    const hab = tools.find(t => t.name === 'agregar_habitacion')!;
    expect(hab.inputSchema.required).toEqual(expect.arrayContaining(['archivo', 'x', 'y', 'ancho', 'largo']));
    expect(client.getInstructions()).toContain('METROS');
  });

  it('un agente dibuja un plano paso a paso y lo exporta', async () => {
    const { a, archivos } = memoria();
    const client = await conectar(a);
    expect((await llamar(client, 'crear_plano', { archivo: 'depto', nombre: 'Depto' })).data.ok).toBe(true);
    await llamar(client, 'agregar_habitacion', { archivo: 'depto', x: 0, y: 0, ancho: 4, largo: 3.5, nombre: 'Living' });
    const r2 = await llamar(client, 'agregar_habitacion', { archivo: 'depto', x: 4.15, y: 0, ancho: 3, largo: 3.5, nombre: 'Dormitorio' });
    expect(r2.data.estado.recintos).toBe(2);
    // las respuestas a cada cambio son cortas: no repiten el plano entero
    expect(r2.text.length).toBeLessThan(400);
    const puerta = await llamar(client, 'agregar_abertura', { archivo: 'depto', tipo: 'puerta', x: 4.07, y: 1.75, abre_hacia: { x: 5.5, y: 1.75 } });
    expect(puerta.data.resultado.ancho).toBe(0.8);
    const muebles = await llamar(client, 'listar_muebles', {});
    expect(muebles.data.muebles.length).toBeGreaterThan(30);
    expect(muebles.data.orientacion).toMatch(/norte/);
    await llamar(client, 'agregar_mueble', { archivo: 'depto', tipo: 'sofa3', x: 2, y: 0.5, apoyar_en_muro: true });
    const movido = await llamar(client, 'mover_mueble', { archivo: 'depto', x: 2, y: 0.5, nuevo_x: 2, nuevo_y: 3, apoyar_en_muro: true });
    expect(movido.data.resultado.rotacion).toBe(180); // ahora el respaldo va contra el muro sur
    const res = await llamar(client, 'resumen', { archivo: 'depto' });
    expect(res.data.superficie_util_total).toBeCloseTo(4 * 3.5 + 3 * 3.5, 1);
    expect(res.data.aberturas.length).toBe(1);
    const exp = await llamar(client, 'exportar', { archivo: 'depto', formato: 'pdf_hojas', escala: 25 });
    expect(exp.data.archivo).toBe('depto-hojas.pdf');
    expect(new TextDecoder('latin1').decode(archivos.get('depto-hojas.pdf')!).startsWith('%PDF')).toBe(true);
    const dxf = await llamar(client, 'exportar', { archivo: 'depto', formato: 'dxf', salida: 'salida/depto.dxf' });
    expect(dxf.data.archivo).toBe('salida/depto.dxf');
  });

  it('los errores vuelven como texto legible, sin romper el servidor', async () => {
    const { a, archivos, enc } = memoria();
    const client = await conectar(a);
    const falta = await llamar(client, 'resumen', { archivo: 'no-existe' });
    expect(falta.error).toBe(true); expect(falta.text).toMatch(/No existe el plano/);
    await llamar(client, 'crear_plano', { archivo: 'x' });
    const lejos = await llamar(client, 'agregar_abertura', { archivo: 'x', tipo: 'puerta', x: 5, y: 5 });
    expect(lejos.error).toBe(true); expect(lejos.text).toMatch(/muro/);
    // argumentos mal formados: los rechaza el esquema
    const mal: any = await client.callTool({ name: 'agregar_habitacion', arguments: { archivo: 'x', x: 'cero', y: 0, ancho: 4, largo: 3 } }).catch(e => ({ isError: true, content: [{ text: String(e) }] }));
    expect(mal.isError).toBe(true);
    // importar un DXF que está en la carpeta
    archivos.set('prueba.dxf', enc.encode(pruebaDxf));
    const imp = await llamar(client, 'importar', { origen: 'prueba.dxf', archivo: 'importado' });
    expect(imp.data.importacion.muros).toBe(4);
    expect(imp.data.estado.superficie_util_total).toBeCloseTo(22.31, 2);
    expect(imp.data.importacion.nota).toMatch(/cotas y superficies/);
    expect(imp.data.importacion.elementos_por_capa.MUROS).toBe(8);
    const vista: any = await client.callTool({ name: 'vista_previa', arguments: { archivo: 'importado' } });
    expect(vista.content[0].type).toBe('text'); // sin rasterizador en esta prueba
  });
});
