/**
 * Hallazgo #1 (blindaje transaccional): dos despachos simultáneos no deben
 * recibir el mismo número de manifiesto ni de remesa.
 *
 * Corre contra una base MySQL/MariaDB REAL de pruebas (modifica
 * maestro_empresa y la restaura al final):
 *   TEST_DB=1 DB_HOST=127.0.0.1 DB_NAME=tms_test DB_USER=... DB_PASS=... npx vitest run test/consecutivos.db.test.ts
 * Sin TEST_DB=1 se omite. NUNCA apuntar a producción.
 *
 * Reproduce lo que hace confirmarDespacho(): cada despacho reserva sus números
 * dentro de su propia transacción, con trabajo en medio (sembrar manifiesto y
 * remesas) antes del COMMIT.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2';

const RUN = process.env.TEST_DB === '1';

const { db, withTransaction } = await import('../src/db/pool.js');
const empresa = await import('../src/modules/empresa/empresa.repo.js');

const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));
let original: { consecutivo_manifiesto: string; consecutivo_remesa: string } | null = null;

describe.skipIf(!RUN)('consecutivos de manifiesto y remesa bajo concurrencia', () => {
  beforeAll(async () => {
    await db().query(`INSERT IGNORE INTO maestro_empresa (id) VALUES (1)`);
    const [rows] = await db().query<RowDataPacket[]>(
      'SELECT consecutivo_manifiesto, consecutivo_remesa FROM maestro_empresa WHERE id = 1',
    );
    original = rows[0] as typeof original;
    await db().query(
      "UPDATE maestro_empresa SET consecutivo_manifiesto = 'MAN-00100', consecutivo_remesa = 'REM-00500' WHERE id = 1",
    );
  });

  afterAll(async () => {
    if (original) {
      await db().query('UPDATE maestro_empresa SET consecutivo_manifiesto = ?, consecutivo_remesa = ? WHERE id = 1', [
        original.consecutivo_manifiesto,
        original.consecutivo_remesa,
      ]);
    }
    await db().end();
  });

  it('10 despachos simultáneos (1 manifiesto + 2 remesas cada uno) reciben números distintos y consecutivos', async () => {
    const resultados = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        withTransaction(async (conn) => {
          const man = await empresa.siguienteManifiesto(conn);
          await pausa(30); // sembrar manifiesto
          const r1 = await empresa.siguienteRemesa(conn);
          const r2 = await empresa.siguienteRemesa(conn);
          await pausa(30); // sembrar remesas + encolar
          return { man, remesas: [r1, r2] };
        }),
      ),
    );

    const ok = resultados.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    expect(ok).toHaveLength(10); // ninguno falla: esperan su turno

    const manifiestos = ok.map((r) => r.man);
    const remesas = ok.flatMap((r) => r.remesas);
    expect(new Set(manifiestos).size).toBe(10);
    expect(new Set(remesas).size).toBe(20);
    expect([...manifiestos].sort()).toEqual(Array.from({ length: 10 }, (_, i) => `MAN-${String(101 + i).padStart(5, '0')}`));
    expect([...remesas].sort()).toEqual(Array.from({ length: 20 }, (_, i) => `REM-${String(501 + i).padStart(5, '0')}`));

    const [rows] = await db().query<RowDataPacket[]>(
      'SELECT consecutivo_manifiesto, consecutivo_remesa FROM maestro_empresa WHERE id = 1',
    );
    expect(rows[0]).toMatchObject({ consecutivo_manifiesto: 'MAN-00110', consecutivo_remesa: 'REM-00520' });
  });

  it('si el despacho hace rollback, su número no se consume', async () => {
    const [antes] = await db().query<RowDataPacket[]>('SELECT consecutivo_manifiesto FROM maestro_empresa WHERE id = 1');
    await expect(
      withTransaction(async (conn) => {
        await empresa.siguienteManifiesto(conn);
        throw new Error('falla al sembrar');
      }),
    ).rejects.toThrow('falla al sembrar');
    const [despues] = await db().query<RowDataPacket[]>('SELECT consecutivo_manifiesto FROM maestro_empresa WHERE id = 1');
    expect(despues[0]!.consecutivo_manifiesto).toBe(antes[0]!.consecutivo_manifiesto);
  });
});
