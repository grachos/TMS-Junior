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
import { ACCIONES, normalizarAcciones, tieneAccion, type Accion } from './permisos.js';
import { coincidePropietario } from './propietario.js';
import { forbidden } from '../../http/errors.js';

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
  /** Identificador estable e inmutable de la cuenta (migracion_v57). Nunca sale por la API. */
  uuid?: string;
  /** Sube para invalidar todas las sesiones abiertas de la cuenta. Ausente (sin v57) = 0. */
  sesion_version?: number;
  email: string;
  password_hash: string;
  nombre: string;
  rol: Rol;
  /** Allowed pages for rol='operador'; null = all (backward compatible). Ignored for 'admin'. */
  paginas: Pagina[] | null;
  /** Acciones críticas permitidas a un operador; null = valores por defecto (permisos.ts). */
  acciones: Accion[] | null;
  activo: 0 | 1;
  created_at: string;
}

/** Public shape returned to clients (never leaks the password hash). */
/** `permisos` = acciones que el usuario puede ejecutar HOY (ya resueltas: admin todas, operador su lista o los valores por defecto). La interfaz solo lee esto. */
export type StaffUserPublic = Omit<StaffUser, 'password_hash' | 'uuid' | 'sesion_version'> & { permisos: Accion[]; protegido: boolean };

export function toPublic(u: StaffUser): StaffUserPublic {
  // El uuid y la versión de sesión NUNCA salen por la API (ni para otros administradores). `protegido` solo
  // dice, calculado por el servidor, que esta cuenta no se puede modificar desde Usuarios.
  const { password_hash: _p, uuid, sesion_version: _s, ...rest } = u;
  return { ...rest, permisos: ACCIONES.filter((a) => tieneAccion(u, a)), protegido: coincidePropietario(uuid) };
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
  return { ...(row as unknown as StaffUser), paginas, acciones: parseAcciones(row.acciones), sesion_version: Number(row.sesion_version ?? 0) };
}

/** `acciones` llega como texto (LONGTEXT) o null; una columna ausente o un JSON dañado = valores por defecto. */
function parseAcciones(raw: unknown): Accion[] | null {
  if (Array.isArray(raw)) return normalizarAcciones(raw as string[]);
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? normalizarAcciones(v as string[]) : null;
  } catch {
    return null;
  }
}

/** Serializa acciones: el admin las ignora (null = valores por defecto / todo). */
function serializeAcciones(rol: Rol, acciones: Accion[] | null): string | null {
  if (rol === 'admin' || acciones === null) return null;
  return JSON.stringify(normalizarAcciones(acciones) ?? []);
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
  acciones?: Accion[] | null;
}, exec: Queryable = db()): Promise<number> {
  const [res] = await exec.query<ResultSetHeader>(
    `INSERT INTO staff_users (email, password_hash, nombre, rol, paginas, acciones, activo)
     VALUES (:email, :passwordHash, :nombre, :rol, :paginas, :acciones, 1)`,
    {
      email: input.email.trim().toLowerCase(),
      passwordHash: input.passwordHash,
      nombre: input.nombre.trim(),
      rol: input.rol,
      paginas: serializePaginas(input.rol, input.paginas),
      acciones: serializeAcciones(input.rol, input.acciones ?? null),
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

/** uuid de una cuenta (null si no existe o si todavía no se corrió migracion_v57). */
async function uuidDe(id: number, exec: Queryable): Promise<string | null> {
  try {
    const [rows] = await exec.query<RowDataPacket[]>('SELECT uuid FROM staff_users WHERE id = :id', { id });
    return rows[0] ? String(rows[0].uuid ?? '') : null;
  } catch (e) {
    if ((e as { code?: string }).code === 'ER_BAD_FIELD_ERROR') return null; // sin v57 no hay propietario vinculable
    throw e;
  }
}

/** ¿Esta cuenta es la del propietario de la plataforma? (se decide en el servidor, por uuid) */
export async function esCuentaPropietario(id: number, exec: Queryable = db()): Promise<boolean> {
  return coincidePropietario(await uuidDe(id, exec));
}

/**
 * Sube la versión de sesión: TODAS las sesiones abiertas de la cuenta dejan de valer. Si todavía no se
 * corrió migracion_v57 no hay columna: no falla (la operación que la llamó, p. ej. cambiar la contraseña, sigue).
 */
export async function subirVersionSesion(id: number, exec: Queryable = db()): Promise<void> {
  try {
    await exec.query('UPDATE staff_users SET sesion_version = sesion_version + 1 WHERE id = :id', { id });
  } catch (e) {
    if ((e as { code?: string }).code !== 'ER_BAD_FIELD_ERROR') throw e;
  }
  invalidate(claveCacheUsuario(id));
}

/**
 * Updates a staff user's profile/permissions (and optionally its password) — DESDE LA GESTIÓN DE USUARIOS.
 *
 * La cuenta del propietario de la plataforma está PROTEGIDA aquí, en el servicio (no solo en la ruta ni en la
 * interfaz): nadie puede modificarla por esta vía, ni otro administrador ni ella misma (su perfil se cambia con
 * actualizarPerfilPropietario, con reautenticación). `actorId` es obligatorio para que ninguna ruta futura
 * olvide decir quién actúa.
 */
export async function updateUser(
  id: number,
  input: { email: string; nombre: string; rol: Rol; paginas: Pagina[] | null; acciones?: Accion[] | null; activo: boolean; passwordHash?: string },
  exec: Queryable = db(),
  actorId?: number,
): Promise<void> {
  if (typeof actorId !== 'number') throw new Error('updateUser requiere actorId');
  if (await esCuentaPropietario(id, exec)) {
    throw forbidden('Esta cuenta está protegida: no se puede modificar desde Usuarios.');
  }
  const fila: Record<string, SqlValue> = {
    email: input.email.trim().toLowerCase(),
    nombre: input.nombre.trim(),
    rol: input.rol,
    paginas: serializePaginas(input.rol, input.paginas),
    activo: input.activo ? 1 : 0,
  };
  // undefined = el cliente no envió acciones: se conservan las guardadas.
  if (input.acciones !== undefined || input.rol === 'admin') fila.acciones = serializeAcciones(input.rol, input.acciones ?? null);
  if (input.passwordHash) fila.password_hash = input.passwordHash;
  const sets = Object.keys(fila).map((c) => `${c} = :${c}`).join(', ');
  await exec.query(`UPDATE staff_users SET ${sets} WHERE id = :id`, { ...fila, id });
  // Cambiar la contraseña de alguien cierra sus sesiones abiertas.
  if (input.passwordHash) await subirVersionSesion(id, exec);
  // requireAuth re-reads the user (cached briefly); drop it so a deactivation
  // or a role/page change applies on this user's very next request.
  invalidate(claveCacheUsuario(id));
}

/**
 * Cambios legítimos del propietario sobre SU cuenta (lista explícita de campos: nombre, correo, contraseña).
 * Nunca toca rol, estado ni uuid. Cambiar correo o contraseña cierra todas sus sesiones. Solo funciona sobre la
 * cuenta del propietario; la reautenticación (contraseña actual) la exige quien llama.
 */
export async function actualizarPerfilPropietario(
  id: number,
  cambios: { nombre?: string; email?: string; passwordHash?: string },
  exec: Queryable = db(),
): Promise<void> {
  if (!(await esCuentaPropietario(id, exec))) throw forbidden('Acceso restringido.');
  const fila: Record<string, SqlValue> = {};
  if (cambios.nombre !== undefined) fila.nombre = cambios.nombre.trim();
  if (cambios.email !== undefined) fila.email = cambios.email.trim().toLowerCase();
  if (cambios.passwordHash !== undefined) fila.password_hash = cambios.passwordHash;
  if (Object.keys(fila).length === 0) return;
  const sets = Object.keys(fila).map((c) => `${c} = :${c}`).join(', ');
  await exec.query(`UPDATE staff_users SET ${sets} WHERE id = :id`, { ...fila, id });
  if (fila.email !== undefined || fila.password_hash !== undefined) {
    // Un correo cambiado no debe dejar enlaces de recuperación viejos ni sesiones abiertas.
    await exec.query('UPDATE password_resets SET usado_en = NOW() WHERE usuario_id = :id AND usado_en IS NULL', { id }).catch(() => undefined);
    await subirVersionSesion(id, exec);
  }
  invalidate(claveCacheUsuario(id));
}

/** Cambia el hash de la contraseña (recuperación por correo) y cierra las sesiones abiertas. */
export async function establecerPasswordHash(id: number, passwordHash: string, exec: Queryable = db()): Promise<boolean> {
  const [upd] = await exec.query<ResultSetHeader>('UPDATE staff_users SET password_hash = :h WHERE id = :id AND activo = 1', { h: passwordHash, id });
  if (upd.affectedRows !== 1) return false;
  await subirVersionSesion(id, exec);
  return true;
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
