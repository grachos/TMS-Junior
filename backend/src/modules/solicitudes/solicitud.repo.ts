/**
 * Light TMS - Solicitud de Servicio. Faithful port of SolicitudRepo.php.
 *
 * A Solicitud is captured ONCE; confirming its dispatch SEEDS one Manifiesto and
 * N Remesas (one per product), linked via manifiesto_remesa, marks the solicitud
 * 'procesada'/'despachada', and enqueues the documents for the RNDC. Retentions
 * are computed server-side (never trusted from the client).
 */

import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { db, withTransaction } from '../../db/pool.js';
import * as terceroRepo from '../terceros/tercero.repo.js';
import * as empresaRepo from '../empresa/empresa.repo.js';
import * as cola from '../cola/cola.repo.js';
import { pesoAsignadoSolicitud, pesoTotalDe } from '../../util/pesoSolicitud.js';
import { badRequest, conflict, notFound } from '../../http/errors.js';
import { ACTOR_SISTEMA, auditar, cambios, type Actor } from '../auditoria/auditoria.repo.js';

type Queryable = Pool | PoolConnection;
type Row = Record<string, any>;
type SqlValue = string | number | null;

/** Dispatch fields completed when confirming (deferred from capture). */
const CAMPOS_DESPACHO = [
  'placa_vehiculo',
  'conductor_tipo_id',
  'conductor_num_id',
  'responsable_pago_cargue',
  'responsable_pago_descargue',
  'emf',
] as const;

/** Whitelisted capture fields (mirror SolicitudRepo::CAMPOS). */
const CAMPOS = [
  'consecutivo', 'fecha_solicitud', 'operacion_transporte', 'contenedor_serial', 'tipo_viaje',
  'municipio_pago_saldo',
  'remitente_tipo_id', 'remitente_num_id',
  'destinatario_tipo_id', 'destinatario_num_id',
  'generador_tipo_id', 'generador_num_id',
  'naturaleza_carga', 'tipo_empaque', 'mercancia_codigo',
  'descripcion_producto', 'cantidad_vehiculos', 'unidad_medida', 'peso',
  'valor_mercancia',
  'valor_flete', 'porcentaje_ica',
  'retencion_ica', 'retencion_fuente', 'fopat',
  'tipo_flete', 'tipo_valor_pactado', 'fecha_pago_saldo',
  'observaciones', 'dueno_poliza',
] as const;

const round2 = (n: number) => Math.round(n * 100) / 100;
const hoy = () => new Date().toISOString().slice(0, 10);

/** Dynamic INSERT with named placeholders. */
async function insertNamed(exec: Queryable, tabla: string, fila: Record<string, SqlValue>): Promise<number> {
  const cols = Object.keys(fila);
  const [res] = await exec.query<ResultSetHeader>(
    `INSERT INTO \`${tabla}\` (${cols.join(', ')}) VALUES (${cols.map((c) => `:${c}`).join(', ')})`,
    fila,
  );
  return res.insertId;
}

/**
 * Normalises form input and computes retentions. Port of prepararFila().
 * Reads use the pool (committed master data), like the PHP.
 */
async function prepararFila(datos: Row): Promise<Record<string, SqlValue>> {
  const fila: Record<string, SqlValue> = {};
  for (const c of CAMPOS) {
    const valor = datos[c];
    fila[c] = valor === '' || valor === undefined || valor === null ? null : (valor as SqlValue);
  }
  // `interna` is NOT NULL: never let '' become NULL (500). A client that doesn't
  // send it keeps the current value (see actualizar()).
  if (datos.interna !== undefined) fila.interna = bit(datos.interna);
  if (!fila.fecha_solicitud) fila.fecha_solicitud = hoy();
  if (fila.contenedor_serial) fila.contenedor_serial = String(fila.contenedor_serial).trim().toUpperCase();

  // Retentions computed on the server (not trusted from the client).
  const flete = Number(fila.valor_flete ?? 0) || 0;
  const pIca = Number(fila.porcentaje_ica ?? 0) || 0; // ICA tariff per mil
  fila.retencion_ica = round2((flete * pIca) / 1000);
  fila.retencion_fuente = round2(flete * 0.01); // 1%
  fila.fopat = round2(flete * 0.001); // 0.1%

  // Municipios from the terceros (remitente → origin, destinatario → destination).
  if (fila.remitente_num_id) {
    const t = await terceroRepo.obtenerPorTipoNum(String(fila.remitente_tipo_id ?? ''), String(fila.remitente_num_id));
    fila.municipio_origen = t?.cod_municipio ?? (fila.municipio_origen as SqlValue) ?? null;
  }
  if (fila.destinatario_num_id) {
    const t = await terceroRepo.obtenerPorTipoNum(
      String(fila.destinatario_tipo_id ?? ''),
      String(fila.destinatario_num_id),
    );
    fila.municipio_destino = t?.cod_municipio ?? (fila.municipio_destino as SqlValue) ?? null;
  }
  return fila;
}

/** Inserts the solicitud (auto-consecutivo = id if none). Port of crear(). */
export async function crear(datos: Row, actor: Actor = ACTOR_SISTEMA): Promise<number> {
  const fila = await prepararFila(datos);
  fila.cantidad_vehiculos_original = Number(fila.cantidad_vehiculos ?? 1) || 1;

  return withTransaction(async (conn) => {
    const id = await insertNamed(conn, 'solicitud_servicio', fila);
    if (!fila.consecutivo) {
      await conn.query('UPDATE solicitud_servicio SET consecutivo = ? WHERE id = ?', [String(id), id]);
    }
    await auditar(conn, actor, 'solicitud.crear', 'solicitud', id, `Creó la solicitud #${id}`, {
      placa: fila.placa_vehiculo ?? null, origen: fila.municipio_origen ?? null, destino: fila.municipio_destino ?? null,
      vehiculos: fila.cantidad_vehiculos ?? null, valor_flete: fila.valor_flete ?? null, interna: fila.interna ?? 0,
    });
    return id;
  });
}

/** Updates the solicitud. Port of actualizar(). */
export async function actualizar(id: number, datos: Row, actor: Actor = ACTOR_SISTEMA): Promise<void> {
  const fila = await prepararFila(datos);
  await withTransaction(async (conn) => {
    const [antesRows] = await conn.query<RowDataPacket[]>('SELECT * FROM solicitud_servicio WHERE id = ? FOR UPDATE', [id]);
    // "Interna" (nothing goes to the RNDC) can't change once the solicitud has
    // any dispatch — annulled ones included, since their documents already
    // exist in one series or the other. confirmarDespacho takes the same row
    // lock first, so a change and a dispatch can't race.
    if (fila.interna !== undefined && Number(antesRows[0]?.interna ?? 0) !== fila.interna) {
      const [desp] = await conn.query<RowDataPacket[]>('SELECT 1 FROM manifiesto WHERE solicitud_id = ? LIMIT 1', [id]);
      if (desp.length > 0) {
        throw conflict('La solicitud ya tiene despachos: no se puede cambiar si es interna (no se envía al RNDC) o no.');
      }
    }
    const sets = Object.keys(fila).map((c) => `${c} = :${c}`).join(', ');
    await conn.query(`UPDATE solicitud_servicio SET ${sets} WHERE id = :id`, { ...fila, id });
    const diff = cambios((antesRows[0] ?? {}) as Record<string, unknown>, fila as Record<string, unknown>);
    const resumen = Object.keys(diff).length ? Object.keys(diff).join(', ') : 'sin cambios';
    await auditar(conn, actor, 'solicitud.actualizar', 'solicitud', id, `Editó la solicitud #${id}: ${resumen}`.slice(0, 500), { cambios: diff });
  });
}

async function tenedorCampo(conn: Queryable, placa: string, col: 'tenedor_tipo_id' | 'tenedor_num_id'): Promise<string | null> {
  if (placa === '') return null;
  const [rows] = await conn.query<RowDataPacket[]>(`SELECT ${col} FROM vehiculo WHERE placa = ?`, [placa.toUpperCase()]);
  const v = (rows[0] as Row | undefined)?.[col];
  return v ?? null;
}

/** Form value -> 0/1 for the NOT NULL `interna` flag ('' or garbage means unchecked). */
const bit = (v: unknown): 0 | 1 => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);

/** Seeds the manifiesto (one per dispatch). Port of sembrarManifiesto(). */
async function sembrarManifiesto(conn: Queryable, solicitudId: number, s: Row): Promise<number> {
  const empresa = await empresaRepo.obtener(conn);
  const manifiesto: Record<string, SqlValue> = {
    solicitud_id: solicitudId,
    num_manifiesto: s.num_manifiesto ?? null,
    fecha_expedicion: s.fecha_solicitud ?? null,
    operacion_transporte: s.operacion_transporte ?? null,
    municipio_origen: s.municipio_origen ?? null,
    municipio_destino: s.municipio_destino ?? null,
    titular_tipo_id: await tenedorCampo(conn, String(s.placa_vehiculo ?? ''), 'tenedor_tipo_id'),
    titular_num_id: await tenedorCampo(conn, String(s.placa_vehiculo ?? ''), 'tenedor_num_id'),
    valor_flete_pactado: s.valor_flete ?? null,
    valor_anticipo: s.valor_anticipo ?? null,
    retencion_ica: s.retencion_ica ?? null,
    retencion_fuente: s.retencion_fuente ?? null,
    fopat: s.fopat ?? null,
    tipo_valor_pactado: s.tipo_valor_pactado ?? null,
    municipio_pago_saldo: s.municipio_pago_saldo ?? null,
    fecha_pago_saldo: s.fecha_pago_saldo ?? null,
    observaciones: s.observaciones ?? null,
    nro_poliza: empresa.nro_poliza ?? null,
    emf: s.emf ?? empresa.emf ?? null,
    placa_vehiculo: s.placa_vehiculo ?? null,
    conductor_tipo_id: s.conductor_tipo_id ?? null,
    conductor_num_id: s.conductor_num_id ?? null,
    responsable_pago_cargue: s.responsable_pago_cargue ?? null,
    responsable_pago_descargue: s.responsable_pago_descargue ?? null,
  };
  if (Number(s.interna ?? 0) === 1) manifiesto.estado_rndc = 'interno';
  return insertNamed(conn, 'manifiesto', manifiesto);
}

/**
 * The dispatch form sends '' (not null) for optional number/date fields the
 * user leaves blank. In a strict-mode database '' is rejected for DECIMAL /
 * INT / DATE columns ("Incorrect decimal value: ''"), which failed the whole
 * dispatch with a 500; a non-strict one silently stored 0. Blank means "no
 * value", so it's stored as NULL.
 */
const vacioANull = (v: unknown): SqlValue => (v === '' || v === undefined ? null : (v as SqlValue));

/** Seeds a remesa (one per product). Port of sembrarRemesa(). */
async function sembrarRemesa(conn: Queryable, solicitudId: number, rd: Row, s: Row): Promise<number> {
  // Inherit codigo_un / estado_producto from the product when dangerous.
  let codigoUn: SqlValue = null;
  let estadoProducto: SqlValue = null;
  if (rd.mercancia_codigo) {
    const [rows] = await conn.query<RowDataPacket[]>(
      'SELECT codigo_un, estado_producto FROM producto WHERE codigo = ?',
      [rd.mercancia_codigo],
    );
    const p = rows[0] as Row | undefined;
    if (p) {
      codigoUn = p.codigo_un || null;
      estadoProducto = p.estado_producto || null;
    }
  }
  const remesa: Record<string, SqlValue> = {
    solicitud_id: solicitudId,
    num_remesa: rd.num_remesa ?? null,
    operacion_transporte: s.operacion_transporte ?? null,
    contenedor_serial: s.contenedor_serial ?? null,
    naturaleza_carga: rd.naturaleza_carga ?? null,
    tipo_empaque: rd.tipo_empaque ?? null,
    mercancia_codigo: rd.mercancia_codigo ?? null,
    descripcion_producto: rd.descripcion_producto ?? null,
    // cantidadCargada travels to the RNDC as the loaded quantity — it's the
    // remesa's own "Peso (kg)" field, not a hardcoded placeholder.
    cantidad_cargada: vacioANull(rd.peso) ?? 1,
    unidad_medida: rd.unidad_medida ?? null,
    peso: vacioANull(rd.peso),
    valor_mercancia: vacioANull(rd.valor_mercancia),
    remitente_tipo_id: rd.remitente_tipo_id ?? s.remitente_tipo_id ?? null,
    remitente_num_id: rd.remitente_num_id ?? s.remitente_num_id ?? null,
    destinatario_tipo_id: rd.destinatario_tipo_id ?? s.destinatario_tipo_id ?? null,
    destinatario_num_id: rd.destinatario_num_id ?? s.destinatario_num_id ?? null,
    municipio_cargue: s.municipio_origen ?? null,
    municipio_descargue: s.municipio_destino ?? null,
    propietario_tipo_id: rd.generador_tipo_id ?? s.generador_tipo_id ?? null,
    propietario_num_id: rd.generador_num_id ?? s.generador_num_id ?? null,
    fecha_cita_cargue: vacioANull(rd.fecha_cita_cargue),
    hora_cita_cargue: vacioANull(rd.hora_cita_cargue),
    fecha_cita_descargue: vacioANull(rd.fecha_cita_descargue),
    hora_cita_descargue: vacioANull(rd.hora_cita_descargue),
    horas_pacto_cargue: vacioANull(rd.horas_pacto_cargue),
    minutos_pacto_cargue: vacioANull(rd.minutos_pacto_cargue),
    horas_pacto_descargue: vacioANull(rd.horas_pacto_descargue),
    minutos_pacto_descargue: vacioANull(rd.minutos_pacto_descargue),
    dueno_poliza: s.dueno_poliza ?? 'N',
    codigo_un: codigoUn,
    estado_producto: estadoProducto,
  };
  if (Number(s.interna ?? 0) === 1) remesa.estado_rndc = 'interno';
  return insertNamed(conn, 'remesa', remesa);
}

/**
 * Confirms the dispatch: saves deferred fields, decrements the vehicle counter,
 * seeds 1 manifiesto + N remesas, links them, and enqueues for the RNDC.
 * Port of confirmarDespacho().
 */
export async function confirmarDespacho(id: number, datos: Row, actor: Actor = ACTOR_SISTEMA): Promise<void> {
  await withTransaction(async (conn) => {
    // 1) Save dispatch fields on the solicitud.
    const fila: Record<string, SqlValue> = {};
    for (const c of CAMPOS_DESPACHO) {
      const valor = datos[c];
      fila[c] = valor === '' || valor === undefined || valor === null ? null : (valor as SqlValue);
    }

    // Lock the solicitud FIRST and validate after locking: concurrent
    // dispatches of the same solicitud (double click, retry after a timeout)
    // now take turns, and each one sees what the previous one committed.
    // Before, the route checked estado/vehicles/weight from an unlocked read
    // and this read had no lock either, so 3 simultaneous requests on a
    // 1-vehicle solicitud created 3 manifiestos (test/despacho_doble.db.test.ts).
    // Lock order for every dispatch: solicitud_servicio → maestro_empresa
    // (consecutivos, empresa.repo.ts) — keep it the same everywhere.
    const [restRows] = await conn.query<RowDataPacket[]>(
      'SELECT estado, cantidad_vehiculos, peso, interna FROM solicitud_servicio WHERE id = ? FOR UPDATE',
      [id],
    );
    const actual = restRows[0] as Row | undefined;
    if (!actual) throw notFound('Solicitud no encontrada.');
    if (actual.estado === 'despachada' || actual.estado === 'anulada') {
      throw conflict(actual.estado === 'despachada' ? 'La solicitud ya fue despachada.' : 'La solicitud está anulada.');
    }
    // No `|| 1` fallback: 0 vehicles left means nothing left to dispatch.
    const restantes = Number(actual.cantidad_vehiculos ?? 0);
    if (!(restantes >= 1)) throw conflict('Ya no quedan vehículos por despachar en esta solicitud.');
    // Solicitud interna: own numbering, documents in state 'interno', and NOTHING
    // is queued for the RNDC.
    const interna = Number(actual.interna ?? 0) === 1;

    // Weight budget, also under the lock (remesas committed by a concurrent
    // dispatch are visible here because the read happens after the lock).
    const pesoTotal = Number(actual.peso ?? 0);
    if (pesoTotal > 0) {
      const pesoDisponible = pesoTotal - (await pesoAsignadoSolicitud(conn, id));
      if (pesoDisponible <= 0) {
        throw badRequest(
          `Ya se agotó el peso disponible de esta solicitud (${pesoTotal.toLocaleString('es-CO')} kg). No es posible despachar más remesas.`,
        );
      }
      // No custom remesas -> one default remesa that inherits the solicitud's full peso.
      const remesasBody = Array.isArray(datos.remesas) ? datos.remesas : [];
      const pesoNuevo = remesasBody.length > 0 ? pesoTotalDe(remesasBody) : pesoTotal;
      if (pesoNuevo - pesoDisponible > 0.001) {
        throw badRequest(
          `El peso de las remesas (${pesoNuevo.toLocaleString('es-CO')} kg) supera el peso disponible ` +
            `(${pesoDisponible.toLocaleString('es-CO')} kg) de esta solicitud.`,
        );
      }
    }

    const nuevosRestantes = Math.max(0, restantes - 1);
    fila.cantidad_vehiculos = nuevosRestantes;
    fila.estado = nuevosRestantes > 0 ? 'procesada' : 'despachada';

    const sets = Object.keys(fila).map((c) => `${c} = :${c}`).join(', ');
    await conn.query(`UPDATE solicitud_servicio SET ${sets} WHERE id = :id`, { ...fila, id });

    // 2) Read the full solicitud to feed remesas/manifiesto.
    const [sRows] = await conn.query<RowDataPacket[]>('SELECT * FROM solicitud_servicio WHERE id = ?', [id]);
    const s = sRows[0] as Row;
    s.valor_anticipo = vacioANull(datos.valor_anticipo);
    s.cantidad_vehiculos = nuevosRestantes;

    // Company consecutivos (reserved on the same connection).
    s.num_manifiesto = interna ? await empresaRepo.siguienteManifiestoInterno(conn) : await empresaRepo.siguienteManifiesto(conn);

    // 3) Seed the manifiesto (one per dispatch).
    const manifiestoId = await sembrarManifiesto(conn, id, s);

    // 4) Remesas from POST (or one default from the solicitud).
    let remesasData: Row[] = Array.isArray(datos.remesas) ? datos.remesas : [];
    if (remesasData.length === 0) {
      remesasData = [
        {
          naturaleza_carga: s.naturaleza_carga ?? null,
          tipo_empaque: s.tipo_empaque ?? null,
          mercancia_codigo: s.mercancia_codigo ?? null,
          descripcion_producto: s.descripcion_producto ?? null,
          unidad_medida: s.unidad_medida ?? null,
          peso: s.peso ?? null,
          valor_mercancia: datos.valor_mercancia ?? s.valor_mercancia ?? null,
        },
      ];
    }

    const remesaIds: number[] = [];
    const numRemesas: string[] = [];
    for (const rd of remesasData) {
      rd.num_remesa = interna ? await empresaRepo.siguienteRemesaInterno(conn) : await empresaRepo.siguienteRemesa(conn);
      numRemesas.push(String(rd.num_remesa));
      remesaIds.push(await sembrarRemesa(conn, id, rd, s));
    }

    // 5) Link remesas to the manifiesto.
    for (const rid of remesaIds) {
      await conn.query('INSERT INTO manifiesto_remesa (manifiesto_id, remesa_id) VALUES (?, ?)', [manifiestoId, rid]);
    }

    // 6) Enqueue tercero(11) → vehículo(12) → remesas(3) → manifiesto(4).
    if (!interna) await cola.encolar(conn, id, manifiestoId, remesaIds);

    await auditar(
      conn, actor, 'despacho.confirmar', 'solicitud', id,
      `Despachó la solicitud #${id}${interna ? ' (interna, no se envía al RNDC)' : ''}: manifiesto ${s.num_manifiesto}, remesa(s) ${numRemesas.join(', ')}, placa ${s.placa_vehiculo ?? '-'}`,
      {
        interna,
        manifiesto_id: manifiestoId, num_manifiesto: s.num_manifiesto, remesas: numRemesas,
        placa: s.placa_vehiculo ?? null, conductor: s.conductor_num_id ?? null, valor_anticipo: s.valor_anticipo ?? null,
      },
    );
  });
}

// ---------- Reads ----------

const LIST_FROM = `FROM solicitud_servicio s
  LEFT JOIN tercero r ON r.tipo_id = s.remitente_tipo_id AND r.num_id = s.remitente_num_id
  LEFT JOIN tercero d ON d.tipo_id = s.destinatario_tipo_id AND d.num_id = s.destinatario_num_id
  LEFT JOIN tercero g ON g.tipo_id = s.generador_tipo_id AND g.num_id = s.generador_num_id
  LEFT JOIN municipio om ON om.codigo_rndc = s.municipio_origen
  LEFT JOIN municipio dm ON dm.codigo_rndc = s.municipio_destino`;

const LIST_COLS = `s.id, s.consecutivo, s.fecha_solicitud, s.interna,
  s.municipio_origen, s.municipio_destino,
  s.valor_flete, s.placa_vehiculo, s.estado,
  s.cantidad_vehiculos, s.cantidad_vehiculos_original,
  s.generador_tipo_id, s.generador_num_id,
  r.nombre AS remitente_nombre,
  d.nombre AS destinatario_nombre,
  g.nombre AS generador_nombre,
  om.nombre_completo AS origen_nombre,
  dm.nombre_completo AS destino_nombre`;

/** Paginated list with search + date range. Port of listarConPaginacion(). */
export async function listarConPaginacion(
  q = '',
  pagina = 1,
  porPagina = 10,
  desde: string | null = null,
  hasta: string | null = null,
): Promise<{ items: Row[]; total: number }> {
  let where = 'WHERE 1=1';
  const params: unknown[] = [];
  if (q !== '') {
    where += ' AND s.consecutivo LIKE ?';
    params.push(`%${q}%`);
  }
  if (desde !== null) {
    where += ' AND s.fecha_solicitud >= ?';
    params.push(desde);
  }
  if (hasta !== null) {
    where += ' AND s.fecha_solicitud <= ?';
    params.push(hasta);
  }
  const [countRows] = await db().query<(RowDataPacket & { total: number })[]>(
    `SELECT COUNT(*) AS total ${LIST_FROM} ${where}`,
    params,
  );
  const total = Number(countRows[0]?.total ?? 0);
  const offset = Math.max(0, (pagina - 1) * porPagina);
  const [rows] = await db().query<RowDataPacket[]>(
    `SELECT ${LIST_COLS} ${LIST_FROM} ${where} ORDER BY s.id DESC LIMIT ? OFFSET ?`,
    [...params, porPagina, offset],
  );
  return { items: rows as Row[], total };
}

/** Fetches a solicitud with its manifiesto + remesas. Port of obtener(). */
export async function obtener(
  id: number,
  manifiestoId: number | null = null,
): Promise<{ solicitud: Row; manifiesto: Row | null; remesas: Row[] } | null> {
  const [sRows] = await db().query<RowDataPacket[]>('SELECT * FROM solicitud_servicio WHERE id = ?', [id]);
  const solicitud = sRows[0] as Row | undefined;
  if (!solicitud) return null;

  let manifiesto: Row | null;
  if (manifiestoId !== null) {
    const [m] = await db().query<RowDataPacket[]>('SELECT * FROM manifiesto WHERE id = ? AND solicitud_id = ?', [
      manifiestoId,
      id,
    ]);
    manifiesto = (m[0] as Row) ?? null;
  } else {
    const [m] = await db().query<RowDataPacket[]>('SELECT * FROM manifiesto WHERE solicitud_id = ?', [id]);
    manifiesto = (m[0] as Row) ?? null;
  }

  let remesas: Row[] = [];
  if (manifiesto) {
    const [rs] = await db().query<RowDataPacket[]>(
      `SELECT r.* FROM remesa r
       JOIN manifiesto_remesa mr ON mr.remesa_id = r.id
       WHERE mr.manifiesto_id = ?
       ORDER BY r.id`,
      [manifiesto.id],
    );
    remesas = rs as Row[];
  }

  // Weight budget: how much of the solicitud's declared peso is already
  // committed to remesas (excluding the manifiesto being viewed/edited, if
  // any, since its own weight shouldn't count against itself).
  const pesoAsignado = await pesoAsignadoSolicitud(db(), id, manifiestoId);
  solicitud.peso_asignado = pesoAsignado;
  solicitud.peso_disponible = Number(solicitud.peso ?? 0) - pesoAsignado;
  // The form locks "Interna" once there's any dispatch (annulled ones count).
  const [[nDesp]] = await db().query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM manifiesto WHERE solicitud_id = ?', [id]);
  solicitud.tiene_despachos = Number(nDesp?.n ?? 0) > 0;

  return { solicitud, manifiesto, remesas };
}
