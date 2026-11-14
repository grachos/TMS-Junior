/**
 * Hallazgo #8 (blindaje transaccional): withTransaction reintenta la
 * transacción completa cuando MySQL/MariaDB la elige como víctima de un
 * deadlock (errno 1213), en vez de devolverle un 500 al usuario.
 *
 * Corre contra una base MySQL/MariaDB REAL de pruebas (crea y borra una tabla
 * auxiliar):
 *   TEST_DB=1 DB_HOST=127.0.0.1 DB_NAME=tms_test DB_USER=... DB_PASS=... npx vitest run test/transaccion_reintento.db.test.ts
 * Sin TEST_DB=1 se omite. NUNCA apuntar a producción.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const RUN = process.env.TEST_DB === '1';

const { db, withTransaction } = await import('../src/db/pool.js');

const tabla = `prueba_deadlock_${Date.now() % 1_000_000}`;
const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!RUN)('withTransaction: reintento ante deadlock', () => {
  beforeAll(async () => {
    await db().query(`CREATE TABLE ${tabla} (id INT PRIMARY KEY, v INT NOT NULL) ENGINE=InnoDB`);
    await db().query(`INSERT INTO ${tabla} (id, v) VALUES (1, 0), (2, 0)`);
  });

  afterAll(async () => {
    await db().query(`DROP TABLE IF EXISTS ${tabla}`);
    await db().end();
  });

  it('dos transacciones que se bloquean en cruz (A→B y B→A) terminan las dos', async () => {
    let intentos = 0;
    const cruzada = (primero: number, segundo: number) =>
      withTransaction(async (conn) => {
        intentos++;
        await conn.query(`UPDATE ${tabla} SET v = v + 1 WHERE id = ?`, [primero]);
        await pausa(150); // la otra transacción toma su primera fila mientras tanto
        await conn.query(`UPDATE ${tabla} SET v = v + 1 WHERE id = ?`, [segundo]);
      });

    const r = await Promise.allSettled([cruzada(1, 2), cruzada(2, 1)]);
    expect(r.map((x) => x.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(intentos).toBe(3); // la víctima del deadlock se repitió una vez

    // Cada transacción sumó 1 a cada fila exactamente una vez: el intento
    // fallido se revirtió por completo.
    const [rows] = await db().query<import('mysql2').RowDataPacket[]>(`SELECT id, v FROM ${tabla} ORDER BY id`);
    expect(rows.map((x) => Number(x.v))).toEqual([2, 2]);
  });

  it('un error que no es deadlock no se reintenta', async () => {
    let intentos = 0;
    await expect(
      withTransaction(async () => {
        intentos++;
        throw new Error('regla de negocio');
      }),
    ).rejects.toThrow('regla de negocio');
    expect(intentos).toBe(1);
  });
});
