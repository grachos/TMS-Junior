/**
 * Light TMS - Staff users data access (mysql2).
 *
 * New in the modern stack: the PHP app had no authentication. Staff accounts
 * live in `staff_users` (see database/migracion_v31_staff_users.sql).
 */

import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import type { Pool, PoolConnection } from 'mysql2/promise';

type Queryable = Pool | PoolConnection;
import { db } from '../../db/pool.js';
import { invalidate } from '../../util/cache.js';

type SqlValue = string | number | null;

export type Rol = 'admin' | 'operador';

/** Assignable page/module keys (mirrors AppShell's nav + App.tsx routes). */
export const PAGINAS = [
  'solicitudes', 'despachos', 'cola', 'cumplido', 'informe',
  'terceros', 'vehiculos', 'productos', 'empresa',
] as const;
export type Pagina = (typeof PAGINAS)[number];

export interface StaffUser {
  id: number;
  email: string;
  password_hash: string;
  nombre: string;
  rol: Rol;
  /** Allowed pages for rol='operador'; null = all (backward compatible). Ignored for 'admin'. */
  paginas: Pagina[] | null;
  activo: 0 | 1;
  created_at: string;
}

/** Public shape returned to clients (never leaks the password hash). */
export type StaffUserPublic = Omit<StaffUser, 'password_hash'>;

export function toPublic(u: StaffUser): StaffUserPublic {
  const { password_hash: _drop, ...rest } = u;
  return rest;
}

/**
 * MariaDB's JSON type is just LONGTEXT with a hidden CHECK constraint — mysql2
 * doesn't know to auto-parse/serialize it like a real MySQL JSON column, so
 * `paginas` comes back as a raw string (or null) and must be parsed by hand.
 */
function hydrate(row: RowDataPacket): StaffUser {
  const raw = row.paginas;
  let paginas: Pagina[] | null = null;
  if (Array.isArray(raw)) {
    paginas = raw;
  } else if (typeof raw === 'string' && raw !== '') {
    try {
      paginas = JSON.parse(raw);
    } catch {
      paginas = null;
    }
  }
  return { ...(row as unknown as StaffUser), paginas };
}

/** Serializes paginas for storage: 'admin' always ignores it (null = full access). */
function serializePaginas(rol: Rol, paginas: Pagina[] | null): string | null {
  if (rol === 'admin' || paginas === null) return null;
  return JSON.stringify(paginas);
}

/** Finds an active staff user by email, or null. */
export async function findByEmail(email: string): Promise<StaffUser | null> {
  const [rows] = await db().query<RowDataPacket[]>(
    'SELECT * FROM staff_users WHERE email = :email AND activo = 1 LIMIT 1',
    { email: email.trim().toLowerCase() },
  );
  return rows[0] ? hydrate(rows[0]) : null;
}

/** Finds a staff user by id (active or not), or null. */
export async function findById(id: number): Promise<StaffUser | null> {
  const [rows] = await db().query<RowDataPacket[]>('SELECT * FROM staff_users WHERE id = :id LIMIT 1', { id });
  return rows[0] ? hydrate(rows[0]) : null;
}

/** Creates a staff user and returns the new id. */
export async function createUser(input: {
  email: string;
  passwordHash: string;
  nombre: string;
  rol: Rol;
  paginas: Pagina[] | null;
}, exec: Queryable = db()): Promise<number> {
  const [res] = await exec.query<ResultSetHeader>(
    `INSERT INTO staff_users (email, password_hash, nombre, rol, paginas, activo)
     VALUES (:email, :passwordHash, :nombre, :rol, :paginas, 1)`,
    {
      email: input.email.trim().toLowerCase(),
      passwordHash: input.passwordHash,
      nombre: input.nombre.trim(),
      rol: input.rol,
      paginas: serializePaginas(input.rol, input.paginas),
    },
  );
  return res.insertId;
}

/** Lists all staff users (any estado), newest first. */
export async function listUsers(): Promise<StaffUser[]> {
  const [rows] = await db().query<RowDataPacket[]>('SELECT * FROM staff_users ORDER BY id DESC');
  return rows.map(hydrate);
}

/** True if another account already uses this email. */
export async function emailExists(email: string, excludeId: number | null = null): Promise<boolean> {
  const params: Record<string, string | number> = { email: email.trim().toLowerCase() };
  let sql = 'SELECT id FROM staff_users WHERE email = :email';
  if (excludeId !== null) {
    sql += ' AND id <> :excludeId';
    params.excludeId = excludeId;
  }
  const [rows] = await db().query<RowDataPacket[]>(sql, params);
  return rows.length > 0;
}

/** Updates a staff user's profile/permissions (and optionally its password). */
export async function updateUser(
  id: number,
  input: { email: string; nombre: string; rol: Rol; paginas: Pagina[] | null; activo: boolean; passwordHash?: string },
  exec: Queryable = db(),
): Promise<void> {
  const fila: Record<string, SqlValue> = {
    email: input.email.trim().toLowerCase(),
    nombre: input.nombre.trim(),
    rol: input.rol,
    paginas: serializePaginas(input.rol, input.paginas),
    activo: input.activo ? 1 : 0,
  };
  if (input.passwordHash) fila.password_hash = input.passwordHash;
  const sets = Object.keys(fila).map((c) => `${c} = :${c}`).join(', ');
  await exec.query(`UPDATE staff_users SET ${sets} WHERE id = :id`, { ...fila, id });
  // requireAuth re-reads the user (cached briefly); drop it so a deactivation
  // or a role/page change applies on this user's very next request.
  invalidate(claveCacheUsuario(id));
}

/** Cache key for the per-request user lookup in requireAuth. */
export const claveCacheUsuario = (id: number) => `auth:user:${id}`;

// ---------- Login attempts (brute-force lockout, migracion_v48) ----------

/** Failed attempts allowed per email inside the window before locking. */
export const LOGIN_MAX_FALLOS = 5;
export const LOGIN_VENTANA_MIN = 15;

const normalizarEmail = (email: string) => email.trim().toLowerCase().slice(0, 190);

/**
 * Records a login attempt as failed BEFORE the password is checked, and
 * returns its id plus how many failures this email has in the window since its
 * last successful login (this attempt included). Recording first means a
 * burst of simultaneous attempts can't all pass the check before any of them
 * is counted. The caller flips the row to exito=1 on success.
 */
export async function registrarIntento(email: string, ip: string | null): Promise<{ id: number; fallos: number }> {
  const e = normalizarEmail(email);
  const [res] = await db().query<ResultSetHeader>(
    'INSERT INTO login_intentos (email, ip, exito) VALUES (?, ?, 0)',
    [e, ip ? ip.slice(0, 45) : null],
  );
  const [rows] = await db().query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM login_intentos
     WHERE email = ? AND exito = 0 AND created_at >= NOW() - INTERVAL ? MINUTE
       AND id > COALESCE((SELECT MAX(id) FROM login_intentos WHERE email = ? AND exito = 1), 0)`,
    [e, LOGIN_VENTANA_MIN, e],
  );
  return { id: res.insertId, fallos: Number(rows[0]?.n ?? 0) };
}

/** Marks an attempt as successful (resets the failure count) and purges old rows. */
export async function marcarIntentoExitoso(id: number): Promise<void> {
  await db().query('UPDATE login_intentos SET exito = 1 WHERE id = ?', [id]);
  await db().query('DELETE FROM login_intentos WHERE created_at < NOW() - INTERVAL 30 DAY LIMIT 1000');
}
