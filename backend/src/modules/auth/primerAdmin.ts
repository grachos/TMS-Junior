/**
 * Light TMS - Creates the first admin on startup of a fresh installation.
 *
 * Shared hosting (Hostinger's Node.js apps) gives no console to run
 * `npm run seed:admin`, so a new instance had no way to get its first user.
 * On startup, if staff_users is EMPTY and SEED_ADMIN_EMAIL /
 * SEED_ADMIN_PASSWORD are set, this creates that admin.
 *
 * Safe by construction:
 * - It only acts when there are no users at all: it never adds to, changes or
 *   re-enables an existing team, and it does nothing on every later restart.
 * - The insert is a single conditional statement (INSERT ... SELECT ... WHERE
 *   NOT EXISTS) plus the UNIQUE email key, so two processes starting together
 *   create one admin.
 * - The password must be 12+ characters; it is never logged.
 * - It never throws: a missing table or bad values are only logged, so the
 *   API still starts.
 */

import bcrypt from 'bcryptjs';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { db } from '../../db/pool.js';

export type ResultadoPrimerAdmin = 'creado' | 'ya_hay_usuarios' | 'sin_datos' | 'invalido' | 'error';

const MIN_PASSWORD = 12;

export async function crearPrimerAdminSiFalta(datos: {
  email: string | undefined;
  password: string | undefined;
  nombre?: string | undefined;
}): Promise<ResultadoPrimerAdmin> {
  try {
    const [[fila]] = await db().query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM staff_users');
    if (Number(fila?.n ?? 0) > 0) return 'ya_hay_usuarios';

    const email = (datos.email ?? '').trim().toLowerCase();
    const password = datos.password ?? '';
    if (!email || !password) {
      // eslint-disable-next-line no-console
      console.warn(
        '[auth] No hay ningún usuario, así que nadie puede iniciar sesión. Define las variables ' +
          'SEED_ADMIN_EMAIL y SEED_ADMIN_PASSWORD y reinicia la aplicación para crear el primer administrador.',
      );
      return 'sin_datos';
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < MIN_PASSWORD) {
      // eslint-disable-next-line no-console
      console.error(
        `[auth] No se creó el primer administrador: SEED_ADMIN_EMAIL debe ser un correo válido y ` +
          `SEED_ADMIN_PASSWORD tener al menos ${MIN_PASSWORD} caracteres.`,
      );
      return 'invalido';
    }

    const hash = await bcrypt.hash(password, 10);
    const [res] = await db().query<ResultSetHeader>(
      `INSERT INTO staff_users (email, password_hash, nombre, rol, paginas, activo)
       SELECT ?, ?, ?, 'admin', NULL, 1 FROM DUAL
       WHERE NOT EXISTS (SELECT 1 FROM staff_users)`,
      [email, hash, (datos.nombre ?? '').trim() || 'Administrador'],
    );
    if (res.affectedRows !== 1) return 'ya_hay_usuarios'; // another process created it first
    // eslint-disable-next-line no-console
    console.log(
      `[auth] Se creó el primer administrador (${email}). Inicia sesión, cambia la contraseña en Usuarios ` +
        'y quita SEED_ADMIN_PASSWORD de las variables de entorno.',
    );
    return 'creado';
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'ER_DUP_ENTRY' || code === 'ER_LOCK_DEADLOCK') return 'ya_hay_usuarios'; // a concurrent startup won
    // eslint-disable-next-line no-console
    console.error(
      code === 'ER_NO_SUCH_TABLE'
        ? '[auth] Falta la tabla staff_users: importa schema.sql y las migraciones (ver DEPLOY.md).'
        : `[auth] No se pudo revisar/crear el primer administrador: ${e instanceof Error ? e.message : String(e)}`,
    );
    return 'error';
  }
}
