/**
 * Light TMS - MySQL/MariaDB connection pool (mysql2/promise).
 *
 * Port of src/db.php. Uses a shared pool instead of a single PDO singleton so
 * concurrent HTTP requests don't serialise on one connection. Prepared
 * statements are parameterised (equivalent to PDO's ATTR_EMULATE_PREPARES=false).
 */

import mysql, { type Pool, type PoolConnection } from 'mysql2/promise';
import { config } from '../config/env.js';

let poolInstance: Pool | null = null;
let readonlyPoolInstance: Pool | null = null;

/** Returns the shared connection pool (created lazily). */
export function db(): Pool {
  if (poolInstance) return poolInstance;
  const cfg = config().db;
  poolInstance = mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    database: cfg.name,
    user: cfg.user,
    password: cfg.pass,
    charset: cfg.charset === 'utf8mb4' ? 'utf8mb4' : cfg.charset,
    waitForConnections: true,
    connectionLimit: 10,
    // Keep DECIMAL/BIGINT as strings to preserve precision (mirrors PDO which
    // returns them as strings); the app formats money/ids as text for the RNDC.
    decimalNumbers: false,
    dateStrings: true,
    namedPlaceholders: true,
  });
  return poolInstance;
}

/**
 * Separate pool for the chatbot's LLM-generated queries. Uses the read-only DB
 * user (config().dbReadonly) and hard-disables multi-statement execution, so a
 * malicious or malformed generated query can't stack `;`-separated statements.
 * This is defence-in-depth on top of the SELECT-only guard in chat.repo.ts —
 * the real security boundary is granting this user SELECT only.
 */
export function dbReadonly(): Pool {
  if (readonlyPoolInstance) return readonlyPoolInstance;
  const cfg = config().db;
  const ro = config().dbReadonly;
  readonlyPoolInstance = mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    database: cfg.name,
    user: ro.user,
    password: ro.pass,
    charset: cfg.charset === 'utf8mb4' ? 'utf8mb4' : cfg.charset,
    waitForConnections: true,
    connectionLimit: 5,
    multipleStatements: false,
    decimalNumbers: false,
    dateStrings: true,
  });
  // DEFENSA EN PROFUNDIDAD: cada conexión de este pool arranca en modo SOLO LECTURA. Aunque por falta de un usuario
  // de BD de solo lectura se usen las credenciales principales, una escritura falla (error 1792) en vez de ejecutarse.
  readonlyPoolInstance.pool.on('connection', (conn) => {
    conn.query('SET SESSION TRANSACTION READ ONLY', () => undefined);
  });
  return readonlyPoolInstance;
}

/**
 * Reports whether the database is reachable, without throwing.
 * Port of db_disponible().
 */
export async function dbDisponible(): Promise<{ ok: boolean; error?: string }> {
  try {
    await db().query('SELECT 1');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** MySQL/MariaDB error number for "Deadlock found when trying to get lock". */
const ER_LOCK_DEADLOCK = 1213;
/** Extra attempts after the first one when the transaction is a deadlock victim. */
const REINTENTOS_DEADLOCK = 2;

/**
 * Runs `fn` inside a transaction on a dedicated connection, committing on
 * success and rolling back on any throw.
 *
 * If the database picks this transaction as a deadlock victim (errno 1213),
 * InnoDB has already rolled it back completely, so the WHOLE transaction is
 * run again (up to 2 more times, after a random 20-100 ms pause) instead of
 * surfacing a 500 to the user. That is why `fn` must contain only database
 * work: no RNDC/HTTP calls, emails or other side effects that a repeat would
 * duplicate (do those after the commit). Any other error is not retried.
 */
export async function withTransaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  for (let intento = 0; ; intento++) {
    const conn = await db().getConnection();
    try {
      await conn.beginTransaction();
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (e) {
      try {
        await conn.rollback();
      } catch {
        /* ignore rollback errors */
      }
      if ((e as { errno?: number }).errno === ER_LOCK_DEADLOCK && intento < REINTENTOS_DEADLOCK) {
        // eslint-disable-next-line no-console
        console.warn(`[db] Deadlock: se reintenta la transacción (intento ${intento + 2} de ${REINTENTOS_DEADLOCK + 1}).`);
        await new Promise((r) => setTimeout(r, 20 + Math.random() * 80));
        continue;
      }
      throw e;
    } finally {
      conn.release();
    }
  }
}
