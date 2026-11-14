/**
 * Light TMS - Impuestos: tarifa de ICA (por mil) por municipio de origen
 * (migracion_v52). El formulario de solicitud la propone al elegir el
 * remitente; cada solicitud conserva la tarifa con la que se guardó.
 */

import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { db } from '../../db/pool.js';

type Queryable = Pool | PoolConnection;

export interface TarifaIca {
  codigo_rndc: string;
  municipio: string;
  tarifa_por_mil: number | null;
}

/** Full name of a municipio, or null if the code doesn't exist. */
export async function nombreMunicipio(exec: Queryable, codigo: string): Promise<string | null> {
  const [rows] = await exec.query<RowDataPacket[]>('SELECT nombre_completo FROM municipio WHERE codigo_rndc = ?', [codigo]);
  return rows[0] ? String(rows[0].nombre_completo) : null;
}

/** The configured tariff for a municipio (null = none configured). */
export async function tarifaDe(exec: Queryable, codigo: string): Promise<number | null> {
  const [rows] = await exec.query<RowDataPacket[]>('SELECT tarifa_por_mil FROM ica_municipio WHERE codigo_rndc = ?', [codigo]);
  return rows[0] ? Number(rows[0].tarifa_por_mil) : null;
}

/** Locks the row (if any) and returns its tariff — for before/after auditing. */
export async function tarifaBloqueada(conn: PoolConnection, codigo: string): Promise<number | null> {
  const [rows] = await conn.query<RowDataPacket[]>('SELECT tarifa_por_mil FROM ica_municipio WHERE codigo_rndc = ? FOR UPDATE', [codigo]);
  return rows[0] ? Number(rows[0].tarifa_por_mil) : null;
}

export async function guardar(conn: PoolConnection, codigo: string, tarifa: number, usuarioId: number | null): Promise<void> {
  await conn.query(
    `INSERT INTO ica_municipio (codigo_rndc, tarifa_por_mil, updated_by) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE tarifa_por_mil = VALUES(tarifa_por_mil), updated_by = VALUES(updated_by)`,
    [codigo, tarifa, usuarioId],
  );
}

export async function eliminar(conn: PoolConnection, codigo: string): Promise<void> {
  await conn.query('DELETE FROM ica_municipio WHERE codigo_rndc = ?', [codigo]);
}

export interface FiltrosIca {
  q?: string;
  page?: number;
  pageSize?: number;
}

/** Configured tariffs with their municipio name, filterable and paginated. */
export async function listar(f: FiltrosIca): Promise<{ items: (TarifaIca & { updated_at: string })[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.q) {
    where.push('(i.codigo_rndc LIKE ? OR m.nombre_completo LIKE ? OR m.nombre LIKE ?)');
    params.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`);
  }
  const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const pageSize = Math.min(Math.max(f.pageSize ?? 50, 1), 200);
  const page = Math.max(f.page ?? 1, 1);
  const from = `FROM ica_municipio i LEFT JOIN municipio m ON m.codigo_rndc = i.codigo_rndc ${sqlWhere}`;
  const [[t]] = await db().query<RowDataPacket[]>(`SELECT COUNT(*) AS n ${from}`, params);
  const [rows] = await db().query<RowDataPacket[]>(
    `SELECT i.codigo_rndc, COALESCE(m.nombre_completo, i.codigo_rndc) AS municipio, i.tarifa_por_mil, i.updated_at
     ${from} ORDER BY municipio LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  return {
    items: rows.map((r) => ({
      codigo_rndc: String(r.codigo_rndc),
      municipio: String(r.municipio),
      tarifa_por_mil: Number(r.tarifa_por_mil),
      updated_at: String(r.updated_at),
    })),
    total: Number(t?.n ?? 0),
  };
}
