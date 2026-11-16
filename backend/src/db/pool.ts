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

/** Errores de conexión: el socket se cortó (el servidor o un intermediario cerró la conexión ociosa). */
const CODIGOS_DE_CONEXION = new Set(['ECONNRESET', 'EPIPE', 'PROTOCOL_CONNECTION_LOST']);
export const esErrorDeConexion = (e: unknown): boolean => CODIGOS_DE_CONEXION.has(String((e as { code?: unknown } | null)?.code ?? ''));

/**
 * ¿Es una lectura pura (se puede repetir sin efectos)? Solo SELECT/SHOW/DESCRIBE/EXPLAIN sin bloqueos ni funciones con estado.
 * Todo lo demás (INSERT, UPDATE, DELETE, CALL, SET…) NO se reintenta: si la conexión se corta a mitad, no se sabe si se aplicó.
 */
export function esLectura(consulta: unknown): boolean {
  const sql = typeof consulta === 'string' ? consulta : (consulta as { sql?: unknown } | null)?.sql;
  if (typeof sql !== 'string') return false;
  return /^\s*(select|show|describe|desc|explain)\b/i.test(sql) && !/\bfor\s+update\b|\block\s+in\s+share\s+mode\b|\binto\s+(outfile|dumpfile|@)|\b(get_lock|release_lock|sleep|nextval|setval)\s*\(/i.test(sql) && !sql.includes(';');
}

const PAUSA_REINTENTO_MS = 50;
const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Envuelve un pool para que `query`/`execute` de una LECTURA se repitan UNA vez si la conexión se cortó (ECONNRESET, EPIPE,
 * PROTOCOL_CONNECTION_LOST). Al fallar, el pool descarta esa conexión y la repetición toma otra (o abre una nueva).
 * Las escrituras y cualquier otro error pasan tal cual.
 */
export function conReintentoDeLectura(pool: Pool): Pool {
  return new Proxy(pool, {
    get(destino, propiedad) {
      const valor = Reflect.get(destino, propiedad, destino) as unknown;
      if (typeof valor !== 'function') return valor;
      if (propiedad === 'query' || propiedad === 'execute') {
        return async (...args: unknown[]) => {
          try {
            return await (valor as (...a: unknown[]) => Promise<unknown>).apply(destino, args);
          } catch (e) {
            if (!esErrorDeConexion(e) || !esLectura(args[0])) throw e;
            // eslint-disable-next-line no-console
            console.warn('[db] Conexión cortada: se repite la lectura una vez.');
            await espera(PAUSA_REINTENTO_MS);
            return (valor as (...a: unknown[]) => Promise<unknown>).apply(destino, args);
          }
        };
      }
      return (valor as (...a: unknown[]) => unknown).bind(destino);
    },
  });
}
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
    // Conexiones que el hosting corta por inactividad causaban ECONNRESET (500) en la siguiente petición: se mantienen vivas y
    // las ociosas se cierran antes de que el servidor las mate.
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
    maxIdle: 4,
    idleTimeout: 15_000,
    // Keep DECIMAL/BIGINT as strings to preserve precision (mirrors PDO which
    // returns them as strings); the app formats money/ids as text for the RNDC.
    decimalNumbers: false,
    dateStrings: true,
    namedPlaceholders: true,
  });
  // Las lecturas que fallan por una conexión cortada se repiten una vez (ver conReintentoDeLectura).
  poolInstance = conReintentoDeLectura(poolInstance);
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
 * Ejecuta lecturas dentro de una transacción de SOLO LECTURA (`START TRANSACTION READ ONLY`): la base de datos misma impide que
 * cambien nada. Usa el pool principal, así no depende de un usuario de BD aparte (que este hosting no permite crear).
 */
export async function leerSoloLectura<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  for (let intento = 0; ; intento++) {
    const conn = await db().getConnection();
    try {
      await conn.query('START TRANSACTION READ ONLY');
      try {
        return await fn(conn);
      } finally {
        await conn.query('COMMIT').catch(() => undefined);
      }
    } catch (e) {
      // Solo lectura: si la conexión se cortó se puede repetir todo sin riesgo (una vez).
      if (esErrorDeConexion(e) && intento < 1) {
        // eslint-disable-next-line no-console
        console.warn('[db] Conexión cortada: se repite la lectura una vez.');
        await espera(PAUSA_REINTENTO_MS);
        continue;
      }
      throw e;
    } finally {
      conn.release();
    }
  }
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
  let reintentosDeadlock = 0;
  let reintentosConexion = 0;
  for (;;) {
    const conn = await db().getConnection();
    // Mientras no se haya lanzado el COMMIT, una conexión cortada deja la transacción sin aplicar (el servidor la deshace), así que
    // repetirla es seguro. Si se corta DURANTE el commit no se sabe si se aplicó: ahí NO se repite.
    let enCommit = false;
    try {
      await conn.beginTransaction();
      const result = await fn(conn);
      enCommit = true;
      await conn.commit();
      return result;
    } catch (e) {
      try {
        await conn.rollback();
      } catch {
        /* ignore rollback errors */
      }
      if ((e as { errno?: number }).errno === ER_LOCK_DEADLOCK && reintentosDeadlock < REINTENTOS_DEADLOCK) {
        reintentosDeadlock += 1;
        // eslint-disable-next-line no-console
        console.warn(`[db] Deadlock: se reintenta la transacción (intento ${reintentosDeadlock + 1} de ${REINTENTOS_DEADLOCK + 1}).`);
        await new Promise((r) => setTimeout(r, 20 + Math.random() * 80));
        continue;
      }
      if (esErrorDeConexion(e) && !enCommit && reintentosConexion < 1) {
        reintentosConexion += 1;
        // eslint-disable-next-line no-console
        console.warn('[db] Conexión cortada antes del commit: se repite la transacción una vez.');
        await espera(PAUSA_REINTENTO_MS);
        continue;
      }
      throw e;
    } finally {
      conn.release();
    }
  }
}
