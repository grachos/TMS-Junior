/**
 * Instalación nueva: al arrancar, si staff_users está vacía, se crea el primer
 * administrador desde SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD (en hosting sin
 * consola no se puede correr `npm run seed:admin`).
 *
 * Corre contra una base MySQL/MariaDB REAL de pruebas y necesita staff_users
 * VACÍA al empezar (la deja vacía al terminar):
 *   TEST_DB=1 DB_HOST=127.0.0.1 DB_NAME=tms_test DB_USER=... DB_PASS=... npx vitest run test/primer_admin.db.test.ts
 * Sin TEST_DB=1 se omite. NUNCA apuntar a producción.
 */

import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2';

const RUN = process.env.TEST_DB === '1';

const { db } = await import('../src/db/pool.js');
const { crearPrimerAdminSiFalta } = await import('../src/modules/auth/primerAdmin.js');

const password = () => randomBytes(12).toString('base64url'); // 16 caracteres
const email = (n: string) => `${n}.${Date.now()}@test.local`;

async function usuarios(): Promise<RowDataPacket[]> {
  const [rows] = await db().query<RowDataPacket[]>('SELECT email, password_hash, rol, activo, paginas FROM staff_users');
  return rows;
}

describe.skipIf(!RUN)('primer administrador al arrancar', () => {
  beforeAll(async () => {
    // Esta prueba solo tiene sentido sobre una tabla vacía; no borra datos ajenos.
    expect(await usuarios()).toHaveLength(0);
  });
  afterEach(async () => {
    await db().query("DELETE FROM staff_users WHERE email LIKE '%@test.local'");
  });
  afterAll(async () => {
    await db().end();
  });

  it('con la tabla vacía crea un admin activo con esa contraseña', async () => {
    const e = email('primero');
    const p = password();
    expect(await crearPrimerAdminSiFalta({ email: e, password: p })).toBe('creado');
    const us = await usuarios();
    expect(us).toHaveLength(1);
    expect(us[0]).toMatchObject({ email: e, rol: 'admin', activo: 1, paginas: null });
    expect(await bcrypt.compare(p, String(us[0]!.password_hash))).toBe(true);
  });

  it('si ya hay usuarios no crea ni cambia nada', async () => {
    const e = email('existente');
    await crearPrimerAdminSiFalta({ email: e, password: password() });
    const antes = await usuarios();
    expect(await crearPrimerAdminSiFalta({ email: email('otro'), password: password() })).toBe('ya_hay_usuarios');
    expect(await crearPrimerAdminSiFalta({ email: e, password: password() })).toBe('ya_hay_usuarios');
    expect(await usuarios()).toEqual(antes); // misma fila, mismo hash
  });

  it('dos procesos arrancando a la vez crean un solo admin', async () => {
    const r = await Promise.all([
      crearPrimerAdminSiFalta({ email: email('a'), password: password() }),
      crearPrimerAdminSiFalta({ email: email('b'), password: password() }),
    ]);
    expect(r.filter((x) => x === 'creado')).toHaveLength(1);
    expect(await usuarios()).toHaveLength(1);
  });

  it('sin SEED_ADMIN_* no crea nada', async () => {
    expect(await crearPrimerAdminSiFalta({ email: undefined, password: undefined })).toBe('sin_datos');
    expect(await usuarios()).toHaveLength(0);
  });

  it('rechaza una contraseña corta o de ejemplo y un correo inválido', async () => {
    expect(await crearPrimerAdminSiFalta({ email: email('corta'), password: 'corta123' })).toBe('invalido');
    expect(await crearPrimerAdminSiFalta({ email: email('ejemplo'), password: 'admin1234admin' })).toBe('creado'); // 14 caracteres, válida
    await db().query("DELETE FROM staff_users WHERE email LIKE '%@test.local'");
    expect(await crearPrimerAdminSiFalta({ email: email('defecto'), password: 'admin1234' })).toBe('invalido');
    expect(await crearPrimerAdminSiFalta({ email: 'no-es-correo', password: password() })).toBe('invalido');
    expect(await usuarios()).toHaveLength(0);
  });
});
