/**
 * Si migracion_v50 (tabla auditoria) aún no se corrió, las operaciones deben
 * seguir funcionando: el INSERT de auditoría falla solo, sin revertir la
 * transacción de la operación. Se prueba con un despacho real.
 *
 * Base MySQL/MariaDB REAL de pruebas: renombra la tabla auditoria durante la
 * prueba y la restaura al final.
 *   TEST_DB=1 DB_HOST=127.0.0.1 DB_NAME=tms_test DB_USER=... DB_PASS=... npx vitest run test/auditoria_sin_tabla.db.test.ts
 * Sin TEST_DB=1 se omite. NUNCA apuntar a producción.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';

const RUN = process.env.TEST_DB === '1';
const { createApp } = await import('../src/app.js');
const { signToken } = await import('../src/modules/auth/jwt.js');
const { db } = await import('../src/db/pool.js');

let server: Server;
let base = '';
let token = '';
let adminId = 0;
let solicitudId = 0;
const respaldo = `auditoria_respaldo_${Date.now() % 1_000_000}`;

describe.skipIf(!RUN)('auditoría sin su tabla (migración pendiente)', () => {
  beforeAll(async () => {
    server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const email = `sintabla.${Date.now()}@test.local`;
    const [u] = await db().query<ResultSetHeader>(
      "INSERT INTO staff_users (email, password_hash, nombre, rol, paginas, activo) VALUES (?, 'x', 'Prueba', 'admin', NULL, 1)",
      [email],
    );
    adminId = u.insertId;
    token = signToken({ sub: adminId, email, nombre: 'Prueba', rol: 'admin', paginas: null });
    await db().query(`RENAME TABLE auditoria TO ${respaldo}`);
  });

  afterAll(async () => {
    await db().query(`RENAME TABLE ${respaldo} TO auditoria`);
    if (solicitudId) {
      await db().query('DELETE FROM cola_envios WHERE solicitud_id = ?', [solicitudId]);
      await db().query('DELETE FROM remesa WHERE solicitud_id = ?', [solicitudId]);
      await db().query('DELETE FROM manifiesto WHERE solicitud_id = ?', [solicitudId]);
      await db().query('DELETE FROM solicitud_servicio WHERE id = ?', [solicitudId]);
    }
    await db().query('DELETE FROM staff_users WHERE id = ?', [adminId]);
    await new Promise((r) => server.close(r));
    await db().end();
  });

  it('un despacho se completa aunque la tabla de auditoría no exista', async () => {
    const [s] = await db().query<ResultSetHeader>(
      "INSERT INTO solicitud_servicio (fecha_solicitud, cantidad_vehiculos, cantidad_vehiculos_original, estado, peso) VALUES (CURDATE(), 1, 1, 'borrador', 0)",
    );
    solicitudId = s.insertId;
    const r = await fetch(`${base}/api/solicitudes/${solicitudId}/despachar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ placa_vehiculo: 'TST123', conductor_tipo_id: 'C', conductor_num_id: '1' }),
    });
    expect(r.status).toBe(200);
    const [[m]] = await db().query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM manifiesto WHERE solicitud_id = ?', [solicitudId]);
    expect(Number(m!.n)).toBe(1);
    const [[c]] = await db().query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM cola_envios WHERE solicitud_id = ?', [solicitudId]);
    expect(Number(c!.n)).toBeGreaterThan(0); // the whole transaction committed, queue included
  });
});
