/**
 * Light TMS - Chat de datos: acceso de SOLO LECTURA.
 *
 * Ya NO hay SQL libre generado por el modelo: el chat usa herramientas TIPADAS (herramientas.ts), cada una con una
 * consulta fija, parámetros validados y enlazados, columnas enumeradas y LIMIT. Una expresión regular nunca fue una
 * frontera de seguridad suficiente; ahora la frontera es: (1) el modelo no escribe SQL, (2) cada herramienta se
 * filtra por los permisos del usuario que vienen del servidor, (3) la conexión está en modo SOLO LECTURA
 * (SET SESSION TRANSACTION READ ONLY en cada conexión del pool) y (4) idealmente un usuario de BD con SELECT solo
 * sobre las tablas del registro (ver docs/SOPORTE.md).
 */

import type { RowDataPacket } from 'mysql2';
import { dbReadonly } from '../../db/pool.js';

const TIMEOUT_MS = 8000;

/** Ejecuta una consulta FIJA con parámetros enlazados contra el pool de solo lectura. */
export async function consultarSoloLectura(sql: string, valores: (string | number)[]): Promise<Record<string, unknown>[]> {
  const [rows] = await dbReadonly().query<RowDataPacket[]>({ sql, values: valores, timeout: TIMEOUT_MS });
  return (rows as Record<string, unknown>[]) ?? [];
}

/** Escapa los comodines de LIKE en un texto del usuario/modelo (para que `%` y `_` no cambien la búsqueda). */
export function escaparLike(texto: string): string {
  return texto.replace(/[\\%_]/g, (c) => `\\${c}`);
}
