/**
 * Light TMS - Herramientas TIPADAS del chat de datos.
 *
 * Cada herramienta: nombre, página/módulo que la autoriza (la MISMA regla que protege las pantallas: tienePagina), esquema
 * zod `.strict()` de sus argumentos, y UNA consulta fija con columnas enumeradas, parámetros enlazados y LIMIT. El modelo
 * nunca escribe SQL. Al modelo solo se le envían las herramientas que el usuario puede usar, y se vuelve a comprobar
 * al ejecutar con el mismo contexto: una llamada inventada o de otra página no ejecuta ninguna consulta.
 *
 * Las tablas con secretos o administración (staff_users, maestro_empresa, auditoria, login_intentos, push_subscriptions,
 * incidentes…) no están en ninguna herramienta, ni lo estarán sin una revisión explícita.
 */

import { z } from 'zod';
import { tienePagina } from '../auth/auth.middleware.js';
import type { Pagina, Rol } from '../auth/auth.repo.js';
import { consultarSoloLectura, escaparLike } from './chat.repo.js';

/** Identidad del usuario que pregunta. SIEMPRE se arma en el servidor (req.user, releído de la base en cada petición). */
export interface ContextoChat {
  userId: number;
  rol: Rol;
  paginas: Pagina[] | null;
}

export function contextoDe(u: { sub: number; rol: Rol; paginas: Pagina[] | null }): ContextoChat {
  return { userId: u.sub, rol: u.rol, paginas: u.paginas };
}

type Valor = string | number;

interface Herramienta {
  nombre: string;
  descripcion: string;
  /** Página que autoriza la herramienta; null = dato de catálogo que usan todos los formularios. */
  pagina: Pagina | null;
  /** JSON Schema que ve el modelo (debe coincidir con las llaves del esquema zod; una prueba lo comprueba). */
  parametros: { type: 'object'; properties: Record<string, unknown>; additionalProperties: false; required?: string[] };
  schema: z.ZodTypeAny;
  tablas: string[];
  ejecutar: (args: any) => Promise<Record<string, unknown>[]>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha YYYY-MM-DD.').refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'Fecha inválida.');
const limite = z.coerce.number().int().min(1).max(50).default(20);
const texto = (max = 60) => z.string().trim().min(1).max(max);

const ESTADOS_SOLICITUD = ['borrador', 'confirmada', 'despachada', 'anulada'] as const;
const ESTADOS_RNDC = ['pendiente', 'enviado', 'aceptado', 'rechazado', 'anulacion_pendiente', 'anulado', 'interno'] as const;
const ESTADOS_CUMPLIDO = ['pendiente', 'aceptado'] as const;
const ESTADOS_TERCERO = ['borrador', 'pendiente', 'registrado', 'error'] as const;
const ESTADOS_COLA = ['pendiente', 'enviando', 'enviado', 'error'] as const;
const TIPOS_COLA = ['tercero', 'vehiculo', 'remesa', 'manifiesto', 'cumplido_remesa', 'cumplido_manifiesto'] as const;

const DESC_FECHA = 'Formato YYYY-MM-DD.';
const pFecha = (d: string) => ({ type: 'string', description: `${d} ${DESC_FECHA}` });
const pEnum = (v: readonly string[], d: string) => ({ type: 'string', enum: [...v], description: d });
const pLimite = { type: 'integer', minimum: 1, maximum: 50, description: 'Máximo de filas (por defecto 20).' };
const pTexto = (d: string) => ({ type: 'string', maxLength: 60, description: d });

/** Condiciones OPCIONALES con valores enlazados: los fragmentos SQL son constantes; lo que cambia viaja como parámetro. */
function donde(partes: [string, Valor | undefined][]): { sql: string; valores: Valor[] } {
  const usadas = partes.filter(([, v]) => v !== undefined);
  return { sql: usadas.length ? `WHERE ${usadas.map(([c]) => c).join(' AND ')}` : '', valores: usadas.map(([, v]) => v as Valor) };
}
const desde = (col: string, v?: string): [string, string | undefined] => [`${col} >= ?`, v];
const hasta = (col: string, v?: string): [string, string | undefined] => [`${col} < DATE_ADD(?, INTERVAL 1 DAY)`, v];

export const HERRAMIENTAS: Herramienta[] = [
  {
    nombre: 'resumen_solicitudes', pagina: 'solicitudes', tablas: ['solicitud_servicio'],
    descripcion: 'Cuenta las solicitudes de servicio por estado (borrador, confirmada, despachada, anulada), con rango de fechas opcional.',
    parametros: { type: 'object', properties: { desde: pFecha('Desde (fecha de creación).'), hasta: pFecha('Hasta (inclusive).') }, additionalProperties: false },
    schema: z.object({ desde: fecha.optional(), hasta: fecha.optional() }).strict(),
    ejecutar: async (a) => {
      const w = donde([desde('created_at', a.desde), hasta('created_at', a.hasta)]);
      return consultarSoloLectura(`SELECT estado, COUNT(*) AS total FROM solicitud_servicio ${w.sql} GROUP BY estado ORDER BY estado`, w.valores);
    },
  },
  {
    nombre: 'buscar_solicitudes', pagina: 'solicitudes', tablas: ['solicitud_servicio'],
    descripcion: 'Lista solicitudes de servicio (las más recientes primero) filtrando por estado, si son internas y fechas.',
    parametros: { type: 'object', properties: { estado: pEnum(ESTADOS_SOLICITUD, 'Estado.'), interna: { type: 'boolean', description: 'true = solo internas (no viajan al RNDC).' }, desde: pFecha('Desde.'), hasta: pFecha('Hasta.'), limite: pLimite }, additionalProperties: false },
    schema: z.object({ estado: z.enum(ESTADOS_SOLICITUD).optional(), interna: z.boolean().optional(), desde: fecha.optional(), hasta: fecha.optional(), limite }).strict(),
    ejecutar: async (a) => {
      const w = donde([['estado = ?', a.estado], ['interna = ?', a.interna === undefined ? undefined : a.interna ? 1 : 0], desde('created_at', a.desde), hasta('created_at', a.hasta)]);
      return consultarSoloLectura(`SELECT id, consecutivo, estado, cantidad_vehiculos, interna, created_at FROM solicitud_servicio ${w.sql} ORDER BY id DESC LIMIT ?`, [...w.valores, a.limite]);
    },
  },
  {
    nombre: 'resumen_manifiestos', pagina: 'despachos', tablas: ['manifiesto'],
    descripcion: 'Cuenta manifiestos por estado ante el RNDC y por estado del cumplido, con filtros y rango de fechas opcionales. Úsala para "¿cuántos manifiestos…?" y "¿qué falta por cumplir?".',
    parametros: { type: 'object', properties: { estado_rndc: pEnum(ESTADOS_RNDC, 'Estado ante el RNDC.'), cumplido_estado_rndc: pEnum(ESTADOS_CUMPLIDO, 'Estado del cumplido.'), desde: pFecha('Desde.'), hasta: pFecha('Hasta.') }, additionalProperties: false },
    schema: z.object({ estado_rndc: z.enum(ESTADOS_RNDC).optional(), cumplido_estado_rndc: z.enum(ESTADOS_CUMPLIDO).optional(), desde: fecha.optional(), hasta: fecha.optional() }).strict(),
    ejecutar: async (a) => {
      const w = donde([['estado_rndc = ?', a.estado_rndc], ['cumplido_estado_rndc = ?', a.cumplido_estado_rndc], desde('created_at', a.desde), hasta('created_at', a.hasta)]);
      return consultarSoloLectura(`SELECT estado_rndc, cumplido_estado_rndc, COUNT(*) AS total FROM manifiesto ${w.sql} GROUP BY estado_rndc, cumplido_estado_rndc ORDER BY estado_rndc`, w.valores);
    },
  },
  {
    nombre: 'buscar_manifiestos', pagina: 'despachos', tablas: ['manifiesto'],
    descripcion: 'Lista manifiestos (los más recientes primero) por número, placa, estado ante el RNDC, estado del cumplido o fechas.',
    parametros: { type: 'object', properties: { numero: pTexto('Número de manifiesto (o su inicio).'), placa: pTexto('Placa del vehículo.'), estado_rndc: pEnum(ESTADOS_RNDC, 'Estado ante el RNDC.'), cumplido_estado_rndc: pEnum(ESTADOS_CUMPLIDO, 'Estado del cumplido.'), desde: pFecha('Desde.'), hasta: pFecha('Hasta.'), limite: pLimite }, additionalProperties: false },
    schema: z.object({ numero: texto().optional(), placa: texto(12).optional(), estado_rndc: z.enum(ESTADOS_RNDC).optional(), cumplido_estado_rndc: z.enum(ESTADOS_CUMPLIDO).optional(), desde: fecha.optional(), hasta: fecha.optional(), limite }).strict(),
    ejecutar: async (a) => {
      const w = donde([['num_manifiesto LIKE ?', a.numero === undefined ? undefined : `${escaparLike(a.numero)}%`], ['placa_vehiculo = ?', a.placa?.toUpperCase()], ['estado_rndc = ?', a.estado_rndc], ['cumplido_estado_rndc = ?', a.cumplido_estado_rndc], desde('created_at', a.desde), hasta('created_at', a.hasta)]);
      return consultarSoloLectura(`SELECT id, solicitud_id, num_manifiesto, placa_vehiculo, estado_rndc, cumplido_estado_rndc, valor_flete_pactado, fecha_expedicion, created_at FROM manifiesto ${w.sql} ORDER BY id DESC LIMIT ?`, [...w.valores, a.limite]);
    },
  },
  {
    nombre: 'buscar_remesas', pagina: 'despachos', tablas: ['remesa'],
    descripcion: 'Lista remesas (las más recientes primero) por número, estado ante el RNDC o fechas.',
    parametros: { type: 'object', properties: { numero: pTexto('Número de remesa (o su inicio).'), estado_rndc: pEnum(ESTADOS_RNDC, 'Estado ante el RNDC.'), desde: pFecha('Desde.'), hasta: pFecha('Hasta.'), limite: pLimite }, additionalProperties: false },
    schema: z.object({ numero: texto().optional(), estado_rndc: z.enum(ESTADOS_RNDC).optional(), desde: fecha.optional(), hasta: fecha.optional(), limite }).strict(),
    ejecutar: async (a) => {
      const w = donde([['num_remesa LIKE ?', a.numero === undefined ? undefined : `${escaparLike(a.numero)}%`], ['estado_rndc = ?', a.estado_rndc], desde('created_at', a.desde), hasta('created_at', a.hasta)]);
      return consultarSoloLectura(`SELECT id, solicitud_id, num_remesa, descripcion_producto, cantidad_cargada, unidad_medida, estado_rndc, created_at FROM remesa ${w.sql} ORDER BY id DESC LIMIT ?`, [...w.valores, a.limite]);
    },
  },
  {
    nombre: 'cumplidos_pendientes', pagina: 'cumplido', tablas: ['manifiesto'],
    descripcion: 'Manifiestos con el cumplido pendiente ("¿qué falta por cumplir?"): total y los más antiguos.',
    parametros: { type: 'object', properties: { limite: pLimite }, additionalProperties: false },
    schema: z.object({ limite }).strict(),
    ejecutar: async (a) => consultarSoloLectura(
      `SELECT id, num_manifiesto, placa_vehiculo, fecha_expedicion, (SELECT COUNT(*) FROM manifiesto WHERE cumplido_estado_rndc = 'pendiente') AS total_pendientes
       FROM manifiesto WHERE cumplido_estado_rndc = 'pendiente' ORDER BY id ASC LIMIT ?`, [a.limite]),
  },
  {
    nombre: 'resumen_cola', pagina: 'cola', tablas: ['cola_envios'],
    descripcion: 'Cuenta los envíos de la cola hacia el RNDC por tipo de documento y estado (pendiente, enviando, enviado, error).',
    parametros: { type: 'object', properties: {}, additionalProperties: false },
    schema: z.object({}).strict(),
    ejecutar: async () => consultarSoloLectura('SELECT tipo_documento, estado, COUNT(*) AS total FROM cola_envios GROUP BY tipo_documento, estado ORDER BY tipo_documento, estado', []),
  },
  {
    nombre: 'buscar_envios_cola', pagina: 'cola', tablas: ['cola_envios'],
    descripcion: 'Lista envíos de la cola (los más recientes primero) por estado o tipo de documento. No incluye el contenido enviado.',
    parametros: { type: 'object', properties: { estado: pEnum(ESTADOS_COLA, 'Estado.'), tipo_documento: pEnum(TIPOS_COLA, 'Tipo de documento.'), limite: pLimite }, additionalProperties: false },
    schema: z.object({ estado: z.enum(ESTADOS_COLA).optional(), tipo_documento: z.enum(TIPOS_COLA).optional(), limite }).strict(),
    ejecutar: async (a) => {
      const w = donde([['estado = ?', a.estado], ['tipo_documento = ?', a.tipo_documento]]);
      return consultarSoloLectura(`SELECT id, solicitud_id, manifiesto_id, tipo_documento, estado, intentos, created_at FROM cola_envios ${w.sql} ORDER BY id DESC LIMIT ?`, [...w.valores, a.limite]);
    },
  },
  {
    nombre: 'buscar_terceros', pagina: 'terceros', tablas: ['tercero'],
    descripcion: 'Busca terceros (clientes, conductores, propietarios) por nombre o identificación, estado ante el RNDC o si son conductores.',
    parametros: { type: 'object', properties: { texto: pTexto('Parte del nombre o de la identificación.'), estado_rndc: pEnum(ESTADOS_TERCERO, 'Estado ante el RNDC.'), es_conductor: { type: 'boolean', description: 'true = solo conductores.' }, limite: pLimite }, additionalProperties: false },
    schema: z.object({ texto: texto().optional(), estado_rndc: z.enum(ESTADOS_TERCERO).optional(), es_conductor: z.boolean().optional(), limite }).strict(),
    ejecutar: async (a) => {
      const like = a.texto === undefined ? undefined : `%${escaparLike(a.texto)}%`;
      const w = donde([['(nombre LIKE ? OR num_id LIKE ?)', like], ['estado_rndc = ?', a.estado_rndc], ['es_conductor = ?', a.es_conductor === undefined ? undefined : a.es_conductor ? 1 : 0]]);
      // Un solo marcador de texto aparece dos veces en la condición: se repite el valor.
      const valores = like === undefined ? w.valores : [like, ...w.valores];
      return consultarSoloLectura(`SELECT id, tipo_id, num_id, nombre, municipio_nombre, es_conductor, estado_rndc FROM tercero ${w.sql} ORDER BY id DESC LIMIT ?`, [...valores, a.limite]);
    },
  },
  {
    nombre: 'buscar_vehiculos', pagina: 'vehiculos', tablas: ['vehiculo'],
    descripcion: 'Busca vehículos por placa o estado ante el RNDC.',
    parametros: { type: 'object', properties: { placa: pTexto('Placa (o su inicio).'), estado_rndc: pEnum(ESTADOS_TERCERO, 'Estado ante el RNDC.'), limite: pLimite }, additionalProperties: false },
    schema: z.object({ placa: texto(12).optional(), estado_rndc: z.enum(ESTADOS_TERCERO).optional(), limite }).strict(),
    ejecutar: async (a) => {
      const w = donde([['placa LIKE ?', a.placa === undefined ? undefined : `${escaparLike(a.placa.toUpperCase())}%`], ['estado_rndc = ?', a.estado_rndc]]);
      return consultarSoloLectura(`SELECT id, placa, cod_configuracion, remolque_placa, estado_rndc FROM vehiculo ${w.sql} ORDER BY id DESC LIMIT ?`, [...w.valores, a.limite]);
    },
  },
  {
    nombre: 'buscar_productos', pagina: 'productos', tablas: ['producto'],
    descripcion: 'Busca productos del catálogo por nombre o código.',
    parametros: { type: 'object', properties: { texto: pTexto('Parte del nombre o código.'), limite: pLimite }, additionalProperties: false, required: ['texto'] },
    schema: z.object({ texto: texto(), limite }).strict(),
    ejecutar: async (a) => {
      const like = `%${escaparLike(a.texto)}%`;
      return consultarSoloLectura('SELECT id, codigo, nombre, tipo, peligrosa FROM producto WHERE nombre LIKE ? OR codigo LIKE ? ORDER BY nombre LIMIT ?', [like, like, a.limite]);
    },
  },
  {
    nombre: 'buscar_municipios', pagina: null, tablas: ['municipio'],
    descripcion: 'Busca municipios (catálogo DIVIPOLA del RNDC) por nombre.',
    parametros: { type: 'object', properties: { texto: pTexto('Parte del nombre del municipio.'), limite: pLimite }, additionalProperties: false, required: ['texto'] },
    schema: z.object({ texto: texto(), limite }).strict(),
    ejecutar: async (a) => consultarSoloLectura('SELECT codigo_rndc, departamento, nombre, nombre_completo FROM municipio WHERE nombre LIKE ? OR nombre_completo LIKE ? ORDER BY nombre LIMIT ?', [`%${escaparLike(a.texto)}%`, `%${escaparLike(a.texto)}%`, a.limite]),
  },
];

/** Tablas que lee el chat (para generar el CREATE USER/GRANT de solo lectura sin que se desactualice). */
export const TABLAS_CHAT = [...new Set(HERRAMIENTAS.flatMap((h) => h.tablas))].sort();

/** Sentencias para crear el usuario de BD de solo lectura con SELECT SOLO sobre las tablas del chat. */
export function sqlUsuarioSoloLectura(baseDeDatos: string, usuario = 'tms_ro', host = 'localhost'): string {
  const lineas = [`CREATE USER '${usuario}'@'${host}' IDENTIFIED BY '<contraseña-larga-y-aleatoria>';`];
  for (const t of TABLAS_CHAT) lineas.push(`GRANT SELECT ON \`${baseDeDatos}\`.\`${t}\` TO '${usuario}'@'${host}';`);
  return lineas.join('\n');
}

export function permitida(h: Herramienta, ctx: ContextoChat): boolean {
  return h.pagina === null || tienePagina(ctx, h.pagina);
}

/** Herramientas que el usuario puede usar, en el formato de OpenRouter/OpenAI. */
export function herramientasParaModelo(ctx: ContextoChat) {
  return HERRAMIENTAS.filter((h) => permitida(h, ctx)).map((h) => ({
    type: 'function' as const,
    function: { name: h.nombre, description: h.descripcion, parameters: h.parametros },
  }));
}

/**
 * Ejecuta una llamada del modelo. Se vuelve a comprobar el permiso con el contexto del servidor: una herramienta inexistente,
 * de otra página o inventada devuelve el MISMO error y no ejecuta ninguna consulta. El resultado se devuelve como texto para el rol 'tool'.
 */
export async function ejecutarHerramienta(ctx: ContextoChat, nombre: string, argumentosJson: string): Promise<string> {
  const h = HERRAMIENTAS.find((x) => x.nombre === nombre);
  if (!h || !permitida(h, ctx)) return JSON.stringify({ error: 'Esa herramienta no está disponible para tu usuario.' });
  let crudo: unknown;
  try {
    crudo = JSON.parse(argumentosJson || '{}');
  } catch {
    return JSON.stringify({ error: 'Argumentos inválidos (no es JSON).' });
  }
  const p = h.schema.safeParse(crudo);
  if (!p.success) return JSON.stringify({ error: `Argumentos inválidos: ${p.error.issues[0]?.message ?? 'revisa los parámetros'}.` });
  try {
    const filas = await h.ejecutar(p.data);
    return JSON.stringify({ filas, total: filas.length });
  } catch {
    // El detalle del error de la base no se devuelve al modelo (podría revelar el esquema).
    return JSON.stringify({ error: 'No se pudo consultar ese dato.' });
  }
}
