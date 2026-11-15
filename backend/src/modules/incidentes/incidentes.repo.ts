/**
 * Light TMS - Incidentes (persistencia). Todo lo que entra aquí YA está sanitizado por quien llama.
 *
 * Agrupación: UN incidente por (sitio, huella). Una ocurrencia repetida suma al contador; nunca se mezclan sitios.
 * Privacidad: la vista del usuario sale SOLO de las funciones `vista*` (lista blanca de campos); lo técnico
 * (evidencias, notas internas, otros usuarios, huella) solo lo leen las funciones `propietario*`.
 */

import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import type { Pool, PoolConnection } from 'mysql2/promise';
import { db, withTransaction } from '../../db/pool.js';
import { sanitizarTexto } from './sanitizar.js';

type Q = Pool | PoolConnection;

export const ESTADOS = ['nuevo', 'en_diagnostico', 'causa_identificada', 'corrigiendo', 'corregido', 'desplegado', 'verificado', 'escalado', 'cerrado'] as const;
export type EstadoIncidente = (typeof ESTADOS)[number];
export const SEVERIDADES = ['baja', 'media', 'alta', 'critica'] as const;

/** Etiquetas PÚBLICAS: distintas a propósito para no prometer de más ("corregido" no es "ya está en uso" ni "verificado"). */
export const ETIQUETAS_PUBLICAS: Record<EstadoIncidente, string> = {
  nuevo: 'Recibido',
  en_diagnostico: 'En revisión',
  causa_identificada: 'Causa identificada',
  corrigiendo: 'En corrección',
  corregido: 'Corrección lista, todavía no está en uso',
  desplegado: 'Corrección publicada, falta verificarla',
  verificado: 'Corregido y verificado',
  escalado: 'En manos del equipo técnico',
  cerrado: 'Cerrado',
};

const MAX_EVIDENCIAS = 20;

export interface Ocurrencia {
  sitio: string;
  huella: string;
  tipo: string;
  origen: 'servidor' | 'navegador' | 'usuario';
  severidad: string;
  corregible: boolean;
  titulo: string;
  operacion: string | null;
  codigo: string | null;
  version: string;
  evidencia?: { tipo: 'servidor' | 'cliente' | 'usuario'; contenido: string; usuarioId: number | null; requestId: string | null };
}

/** Registra una ocurrencia: crea el incidente o suma al existente (un incidente cerrado que reaparece se reabre). */
export async function registrarOcurrencia(o: Ocurrencia, exec: Q = db()): Promise<{ id: number; nuevo: boolean }> {
  const [r] = await exec.query<ResultSetHeader>(
    `INSERT INTO incidentes (sitio, huella, tipo, origen, severidad, corregible, titulo, operacion, codigo, version_despliegue)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE ocurrencias = ocurrencias + 1, ultima_vez = NOW(), version_despliegue = VALUES(version_despliegue),
       estado = IF(estado IN ('verificado','cerrado'), 'nuevo', estado), id = LAST_INSERT_ID(id)`,
    [o.sitio, o.huella, o.tipo, o.origen, o.severidad, o.corregible ? 1 : 0, o.titulo.slice(0, 200), o.operacion, o.codigo, o.version],
  );
  const id = r.insertId;
  const [[fila]] = await exec.query<RowDataPacket[]>('SELECT ocurrencias FROM incidentes WHERE id = ?', [id]);
  const nuevo = Number(fila?.ocurrencias ?? 0) === 1;
  if (nuevo) await evento(id, 'creado', `Origen: ${o.origen}`, null, exec);
  if (o.evidencia) {
    await exec.query(
      'INSERT INTO incidente_evidencias (incidente_id, tipo, contenido, usuario_id, request_id, version_despliegue) VALUES (?, ?, ?, ?, ?, ?)',
      [id, o.evidencia.tipo, o.evidencia.contenido, o.evidencia.usuarioId, o.evidencia.requestId, o.version],
    );
    // Se conservan las últimas MAX_EVIDENCIAS: la tabla no crece sin límite.
    await exec.query(
      `DELETE FROM incidente_evidencias WHERE incidente_id = ? AND id <= COALESCE(
         (SELECT id FROM (SELECT id FROM incidente_evidencias WHERE incidente_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?) t), 0)`,
      [id, id, MAX_EVIDENCIAS],
    );
  }
  return { id, nuevo };
}

export async function evento(incidenteId: number, tipo: string, detalle: string | null, actor: number | null, exec: Q = db()): Promise<void> {
  await exec.query('INSERT INTO incidente_eventos (incidente_id, tipo, detalle, actor_usuario_id) VALUES (?, ?, ?, ?)', [incidenteId, tipo, detalle ? detalle.slice(0, 500) : null, actor]);
}

/** ¿Hay ya un incidente con esa evidencia de servidor (mismo X-Request-Id)? Sirve para atar un reporte a un error real. */
export async function incidentePorRequestId(requestId: string, exec: Q = db()): Promise<number | null> {
  const [rows] = await exec.query<RowDataPacket[]>('SELECT incidente_id FROM incidente_evidencias WHERE request_id = ? ORDER BY id DESC LIMIT 1', [requestId]);
  return rows[0] ? Number(rows[0].incidente_id) : null;
}

// ---------------------------------------------------------------- Reportes de usuarios

export async function crearReporte(
  d: { incidenteId: number; usuarioId: number; texto: string; pantalla: string | null; requestId: string | null },
  exec: Q = db(),
): Promise<number> {
  const [r] = await exec.query<ResultSetHeader>(
    'INSERT INTO incidente_reportes (incidente_id, usuario_id, texto, pantalla, request_id) VALUES (?, ?, ?, ?, ?)',
    [d.incidenteId, d.usuarioId, d.texto, d.pantalla, d.requestId],
  );
  await evento(d.incidenteId, 'reporte', `Reporte #${r.insertId}`, d.usuarioId, exec);
  return r.insertId;
}

export async function reportesRecientesDe(usuarioId: number, minutos: number): Promise<number> {
  const [[f]] = await db().query<RowDataPacket[]>(
    'SELECT COUNT(*) AS n FROM incidente_reportes WHERE usuario_id = ? AND created_at >= NOW() - INTERVAL ? MINUTE', [usuarioId, minutos]);
  return Number(f?.n ?? 0);
}

export async function telemetriaRecienteDe(usuarioId: number, minutos: number): Promise<number> {
  const [[f]] = await db().query<RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM incidente_evidencias WHERE usuario_id = ? AND tipo = 'cliente' AND created_at >= NOW() - INTERVAL ? MINUTE", [usuarioId, minutos]);
  return Number(f?.n ?? 0);
}

// ---------------------------------------------------------------- VISTA DEL USUARIO (lista blanca)

export interface VistaReporte {
  id: number;
  creado: string;
  pantalla: string | null;
  texto: string;
  estado: { codigo: EstadoIncidente; etiqueta: string };
  explicacion: { hecho: string | null; posibleCausa: string | null; causaConfirmada: string | null; accionTemporal: string | null; estadoCorreccion: string | null };
  mensajes: { texto: string; fecha: string }[];
  actualizado: string;
}

const fecha = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v ?? ''));

function aVista(r: RowDataPacket, mensajes: RowDataPacket[]): VistaReporte {
  const estado = (ESTADOS as readonly string[]).includes(String(r.estado)) ? (r.estado as EstadoIncidente) : 'nuevo';
  const txt = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
  // LISTA BLANCA: solo estos campos salen hacia el usuario. Nada de huella, sitio, versión, evidencias, notas internas ni otros usuarios.
  return {
    id: Number(r.id),
    creado: fecha(r.created_at),
    pantalla: txt(r.pantalla),
    texto: String(r.texto ?? ''),
    estado: { codigo: estado, etiqueta: ETIQUETAS_PUBLICAS[estado] },
    explicacion: {
      hecho: txt(r.exp_hecho), posibleCausa: txt(r.exp_posible_causa), causaConfirmada: txt(r.exp_causa_confirmada),
      accionTemporal: txt(r.exp_accion_temporal), estadoCorreccion: txt(r.exp_estado_correccion),
    },
    mensajes: mensajes.map((m) => ({ texto: String(m.texto), fecha: fecha(m.created_at) })),
    actualizado: fecha(r.updated_at),
  };
}

const SEL_VISTA = `SELECT r.id, r.created_at, r.pantalla, r.texto, i.estado, i.updated_at,
  i.exp_hecho, i.exp_posible_causa, i.exp_causa_confirmada, i.exp_accion_temporal, i.exp_estado_correccion
  FROM incidente_reportes r JOIN incidentes i ON i.id = r.incidente_id`;

/** Reportes del propio usuario (solo suyos). */
export async function vistaMisReportes(usuarioId: number): Promise<VistaReporte[]> {
  const [rows] = await db().query<RowDataPacket[]>(`${SEL_VISTA} WHERE r.usuario_id = ? ORDER BY r.id DESC LIMIT 50`, [usuarioId]);
  return rows.map((r) => aVista(r, []));
}

/** Un reporte del propio usuario con sus mensajes PÚBLICOS. Si no es suyo (o no existe): null (la ruta responde 404, no 403). */
export async function vistaMiReporte(usuarioId: number, reporteId: number): Promise<VistaReporte | null> {
  const [rows] = await db().query<RowDataPacket[]>(`${SEL_VISTA} WHERE r.id = ? AND r.usuario_id = ? LIMIT 1`, [reporteId, usuarioId]);
  if (!rows[0]) return null;
  const [msgs] = await db().query<RowDataPacket[]>(
    "SELECT texto, created_at FROM incidente_mensajes WHERE reporte_id = ? AND visibilidad = 'publico' ORDER BY id", [reporteId]);
  return aVista(rows[0], msgs);
}

// ---------------------------------------------------------------- PROPIETARIO

export interface FiltrosIncidentes { estado?: string; tipo?: string; sitio?: string; q?: string; limite?: number }

export async function propietarioListar(f: FiltrosIncidentes): Promise<RowDataPacket[]> {
  const donde: string[] = []; const args: unknown[] = [];
  if (f.estado) { donde.push('estado = ?'); args.push(f.estado); }
  if (f.tipo) { donde.push('tipo = ?'); args.push(f.tipo); }
  if (f.sitio) { donde.push('sitio = ?'); args.push(f.sitio); }
  if (f.q) { donde.push('(titulo LIKE ? OR operacion LIKE ?)'); args.push(`%${f.q}%`, `%${f.q}%`); }
  const [rows] = await db().query<RowDataPacket[]>(
    `SELECT i.id, i.sitio, i.tipo, i.origen, i.severidad, i.estado, i.corregible, i.titulo, i.operacion, i.codigo, i.version_despliegue,
            i.ocurrencias, i.primera_vez, i.ultima_vez,
            (SELECT COUNT(*) FROM incidente_reportes r WHERE r.incidente_id = i.id) AS reportes,
            (SELECT COUNT(DISTINCT r.usuario_id) FROM incidente_reportes r WHERE r.incidente_id = i.id) AS usuarios_reportaron
     FROM incidentes i ${donde.length ? `WHERE ${donde.join(' AND ')}` : ''} ORDER BY i.ultima_vez DESC LIMIT ?`,
    [...args, Math.min(Math.max(f.limite ?? 100, 1), 200)],
  );
  return rows;
}

export async function propietarioDetalle(id: number) {
  const [[inc]] = await db().query<RowDataPacket[]>('SELECT * FROM incidentes WHERE id = ?', [id]);
  if (!inc) return null;
  const [eventos] = await db().query<RowDataPacket[]>('SELECT * FROM incidente_eventos WHERE incidente_id = ? ORDER BY id DESC LIMIT 100', [id]);
  const [evidencias] = await db().query<RowDataPacket[]>('SELECT * FROM incidente_evidencias WHERE incidente_id = ? ORDER BY id DESC', [id]);
  const [reportes] = await db().query<RowDataPacket[]>(
    `SELECT r.id, r.usuario_id, su.nombre AS usuario_nombre, su.email AS usuario_email, r.texto, r.pantalla, r.request_id, r.created_at
     FROM incidente_reportes r LEFT JOIN staff_users su ON su.id = r.usuario_id WHERE r.incidente_id = ? ORDER BY r.id DESC`, [id]);
  const [mensajes] = await db().query<RowDataPacket[]>('SELECT * FROM incidente_mensajes WHERE incidente_id = ? ORDER BY id DESC LIMIT 200', [id]);
  return { incidente: inc, eventos, evidencias, reportes, mensajes };
}

export interface CambiosIncidente {
  estado?: EstadoIncidente;
  severidad?: string;
  tipo?: string;
  corregible?: boolean;
  explicacion?: { hecho?: string | null; posibleCausa?: string | null; causaConfirmada?: string | null; accionTemporal?: string | null; estadoCorreccion?: string | null };
}

/** Aplica cambios + deja el evento en la MISMA transacción y devuelve el estado releído (lo que de verdad quedó guardado). */
export async function propietarioActualizar(id: number, c: CambiosIncidente, actorId: number): Promise<{ estadoAntes: string; estadoAhora: EstadoIncidente } | null> {
  return withTransaction(async (conn) => {
    const [[antes]] = await conn.query<RowDataPacket[]>('SELECT estado FROM incidentes WHERE id = ? FOR UPDATE', [id]);
    if (!antes) return null;
    const sets: string[] = []; const args: unknown[] = [];
    const poner = (col: string, v: unknown) => { sets.push(`${col} = ?`); args.push(v); };
    if (c.estado !== undefined) poner('estado', c.estado);
    if (c.severidad !== undefined) poner('severidad', c.severidad);
    if (c.tipo !== undefined) poner('tipo', c.tipo);
    if (c.corregible !== undefined) poner('corregible', c.corregible ? 1 : 0);
    const e = c.explicacion;
    if (e) {
      const t = (v: string | null | undefined) => (v === undefined ? undefined : v === null || v === '' ? null : sanitizarTexto(v, 1000));
      for (const [col, v] of [['exp_hecho', t(e.hecho)], ['exp_posible_causa', t(e.posibleCausa)], ['exp_causa_confirmada', t(e.causaConfirmada)], ['exp_accion_temporal', t(e.accionTemporal)], ['exp_estado_correccion', t(e.estadoCorreccion)]] as const) {
        if (v !== undefined) poner(col, v);
      }
    }
    if (sets.length) await conn.query(`UPDATE incidentes SET ${sets.join(', ')} WHERE id = ?`, [...args, id]);
    if (c.estado !== undefined && c.estado !== antes.estado) await evento(id, 'estado', `${antes.estado} → ${c.estado}`, actorId, conn);
    const otros = [c.severidad !== undefined && 'severidad', c.tipo !== undefined && 'tipo', c.corregible !== undefined && 'corregible', e && 'explicación'].filter(Boolean).join(', ');
    if (otros) await evento(id, 'edicion', `Cambió: ${otros}`, actorId, conn);
    const [[ahora]] = await conn.query<RowDataPacket[]>('SELECT estado FROM incidentes WHERE id = ?', [id]);
    return { estadoAntes: String(antes.estado), estadoAhora: ahora!.estado as EstadoIncidente };
  });
}

/** Mensaje INTERNO (solo propietario) o PÚBLICO (uno por reporte destinatario: nunca llega a otros usuarios del mismo incidente). */
export async function propietarioPublicarMensaje(
  incidenteId: number, visibilidad: 'interno' | 'publico', texto: string, actorId: number, reporteId?: number,
): Promise<{ reporteIds: number[] } | null> {
  const limpio = sanitizarTexto(texto, 1000);
  return withTransaction(async (conn) => {
    const [[inc]] = await conn.query<RowDataPacket[]>('SELECT id FROM incidentes WHERE id = ? FOR UPDATE', [incidenteId]);
    if (!inc) return null;
    if (visibilidad === 'interno') {
      await conn.query("INSERT INTO incidente_mensajes (incidente_id, reporte_id, visibilidad, autor, texto) VALUES (?, NULL, 'interno', 'propietario', ?)", [incidenteId, limpio]);
      await evento(incidenteId, 'nota_interna', null, actorId, conn);
      return { reporteIds: [] };
    }
    const [reps] = await conn.query<RowDataPacket[]>(
      `SELECT id FROM incidente_reportes WHERE incidente_id = ? ${reporteId ? 'AND id = ?' : ''}`, reporteId ? [incidenteId, reporteId] : [incidenteId]);
    for (const r of reps) {
      await conn.query("INSERT INTO incidente_mensajes (incidente_id, reporte_id, visibilidad, autor, texto) VALUES (?, ?, 'publico', 'propietario', ?)", [incidenteId, r.id, limpio]);
    }
    await evento(incidenteId, 'mensaje_publico', `A ${reps.length} reporte(s)`, actorId, conn);
    return { reporteIds: reps.map((r) => Number(r.id)) };
  });
}

/** Usuarios que reportaron este incidente (opcionalmente solo algunos reportes): los ÚNICOS destinatarios de avisos al usuario. */
export async function usuariosDeReportes(incidenteId: number, reporteIds?: number[]): Promise<number[]> {
  const [rows] = await db().query<RowDataPacket[]>(
    `SELECT DISTINCT usuario_id FROM incidente_reportes WHERE incidente_id = ? ${reporteIds ? 'AND id IN (?)' : ''}`,
    reporteIds ? [incidenteId, reporteIds.length ? reporteIds : [0]] : [incidenteId]);
  return rows.map((r) => Number(r.usuario_id));
}

/** Mensaje público automático por cambio de estado confirmado (uno por reporte). */
export async function mensajePublicoDeEstado(incidenteId: number, etiqueta: string): Promise<number[]> {
  const [reps] = await db().query<RowDataPacket[]>('SELECT id FROM incidente_reportes WHERE incidente_id = ?', [incidenteId]);
  for (const r of reps) {
    await db().query("INSERT INTO incidente_mensajes (incidente_id, reporte_id, visibilidad, autor, texto) VALUES (?, ?, 'publico', 'sistema', ?)", [incidenteId, r.id, `Estado: ${etiqueta}`]);
  }
  return reps.map((r) => Number(r.id));
}
