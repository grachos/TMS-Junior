/**
 * Light TMS - Audit trail (migracion_v50): who did what, when, from which IP,
 * with before/after values.
 *
 * auditar() is called with the SAME connection as the operation it records, as
 * the last statement inside that operation's transaction: if the operation
 * rolls back, its audit row does too, so the log never claims something that
 * didn't happen. Never pass passwords in `detalle` (record "changed" instead).
 *
 * If the table doesn't exist yet (migration not run), the operation still
 * succeeds — MySQL rejects only that statement, not the transaction — and a
 * warning is logged once per process.
 */

import type { Request } from 'express';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { db } from '../../db/pool.js';

type Queryable = Pool | PoolConnection;

export interface Actor {
  id: number | null;
  email: string | null;
  ip: string | null;
}

/** The logged-in user making the request (null fields for automatic processes). */
export function actorDe(req: Request): Actor {
  return { id: req.user?.sub ?? null, email: req.user?.email ?? null, ip: req.ip ?? null };
}

/** Actor for work no person triggered (cron worker, startup tasks). */
export const ACTOR_SISTEMA: Actor = { id: null, email: 'sistema', ip: null };

let avisoTablaFaltante = false;

export async function auditar(
  exec: Queryable,
  actor: Actor,
  accion: string,
  entidad: string,
  entidadId: string | number | null,
  descripcion: string,
  detalle?: Record<string, unknown>,
): Promise<void> {
  try {
    await exec.query(
      `INSERT INTO auditoria (usuario_id, usuario_email, ip, accion, entidad, entidad_id, descripcion, detalle)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        actor.id,
        actor.email,
        actor.ip ? actor.ip.slice(0, 45) : null,
        accion,
        entidad,
        entidadId === null ? null : String(entidadId),
        descripcion.slice(0, 500),
        detalle ? JSON.stringify(detalle) : null,
      ],
    );
  } catch (e) {
    if ((e as { code?: string }).code !== 'ER_NO_SUCH_TABLE') throw e;
    if (!avisoTablaFaltante) {
      avisoTablaFaltante = true;
      // eslint-disable-next-line no-console
      console.error('[auditoria] Falta la tabla auditoria (migracion_v50): las acciones NO se están registrando.');
    }
  }
}

/** '' and undefined -> null; numeric strings -> numbers (so DECIMAL '100.000' equals '100'). */
function normalizar(v: unknown): unknown {
  if (v === undefined || v === '') return null;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return v;
}

/** Fields whose before/after differ (for "update" actions), skipping secrets. */
export function cambios(
  antes: Record<string, unknown>,
  despues: Record<string, unknown>,
  secretos: string[] = [],
): Record<string, { antes: unknown; despues: unknown } | 'cambió'> {
  const out: Record<string, { antes: unknown; despues: unknown } | 'cambió'> = {};
  for (const k of Object.keys(despues)) {
    if (k === 'created_at' || k === 'updated_at') continue;
    const a = normalizar(antes[k]);
    const d = normalizar(despues[k]);
    if (JSON.stringify(a) === JSON.stringify(d)) continue;
    out[k] = secretos.includes(k) ? 'cambió' : { antes: a, despues: d };
  }
  return out;
}

export interface FiltrosAuditoria {
  usuarioId?: number;
  accion?: string;
  entidad?: string;
  entidadId?: string;
  desde?: string; // YYYY-MM-DD
  hasta?: string; // YYYY-MM-DD (inclusive)
  q?: string;
  page?: number;
  pageSize?: number;
}

/** Paginated, filterable listing for the activity viewer (newest first). */
export async function listar(f: FiltrosAuditoria): Promise<{ items: RowDataPacket[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.usuarioId) { where.push('usuario_id = ?'); params.push(f.usuarioId); }
  if (f.accion) { where.push('accion = ?'); params.push(f.accion); }
  if (f.entidad) { where.push('entidad = ?'); params.push(f.entidad); }
  if (f.entidadId) { where.push('entidad_id = ?'); params.push(f.entidadId); }
  if (f.desde) { where.push('created_at >= ?'); params.push(`${f.desde} 00:00:00`); }
  if (f.hasta) { where.push('created_at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(f.hasta); }
  if (f.q) { where.push('(descripcion LIKE ? OR usuario_email LIKE ? OR entidad_id = ?)'); params.push(`%${f.q}%`, `%${f.q}%`, f.q); }
  const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const pageSize = Math.min(Math.max(f.pageSize ?? 50, 1), 200);
  const page = Math.max(f.page ?? 1, 1);
  const [[t]] = await db().query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM auditoria ${sqlWhere}`, params);
  const [items] = await db().query<RowDataPacket[]>(
    `SELECT id, created_at, usuario_id, usuario_email, ip, accion, entidad, entidad_id, descripcion, detalle
     FROM auditoria ${sqlWhere} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  return { items, total: Number(t?.n ?? 0) };
}

/** Distinct actions recorded so far (for the viewer's filter). */
export async function accionesRegistradas(): Promise<string[]> {
  const [rows] = await db().query<RowDataPacket[]>('SELECT DISTINCT accion FROM auditoria ORDER BY accion');
  return rows.map((r) => String(r.accion));
}
