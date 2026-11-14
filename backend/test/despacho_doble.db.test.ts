/**
 * Hallazgo #3 (blindaje transaccional): una solicitud no debe despacharse más
 * veces que sus vehículos, ni pasarse de su peso, aunque lleguen varias
 * peticiones a la vez (doble clic, reintento tras un timeout).
 *
 * Prueba la ruta HTTP real (POST /api/solicitudes/:id/despachar) contra una
 * base MySQL/MariaDB REAL de pruebas (crea y borra solicitudes):
 *   TEST_DB=1 DB_HOST=127.0.0.1 DB_NAME=tms_test DB_USER=... DB_PASS=... npx vitest run test/despacho_doble.db.test.ts
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
// requireAuth checks the user in the DB, so the token must belong to a real active admin.
let token = '';
let adminId = 0;
const creadas: number[] = [];

async function crearSolicitud(vehiculos: number, peso = 0): Promise<number> {
  const [res] = await db().query<ResultSetHeader>(
    `INSERT INTO solicitud_servicio (fecha_solicitud, cantidad_vehiculos, cantidad_vehiculos_original, estado, peso)
     VALUES (CURDATE(), ?, ?, 'borrador', ?)`,
    [vehiculos, vehiculos, peso],
  );
  creadas.push(res.insertId);
  return res.insertId;
}

function despachar(id: number, remesas?: { peso: number }[]) {
  return fetch(`${base}/api/solicitudes/${id}/despachar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ placa_vehiculo: 'TST123', conductor_tipo_id: 'C', conductor_num_id: '1', ...(remesas ? { remesas } : {}) }),
  });
}

async function estado(id: number) {
  const [[s]] = await db().query<RowDataPacket[]>(
    'SELECT estado, cantidad_vehiculos FROM solicitud_servicio WHERE id = ?',
    [id],
  );
  const [[m]] = await db().query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM manifiesto WHERE solicitud_id = ?', [id]);
  const [[r]] = await db().query<RowDataPacket[]>(
    'SELECT COUNT(*) AS n, COALESCE(SUM(peso), 0) AS peso FROM remesa WHERE solicitud_id = ?',
    [id],
  );
  return { estado: s!.estado, restantes: Number(s!.cantidad_vehiculos), manifiestos: Number(m!.n), remesas: Number(r!.n), peso: Number(r!.peso) };
}

const codigos = (rs: Response[]) => rs.map((r) => r.status).sort();

describe.skipIf(!RUN)('despachar: una vez por vehículo, aunque lleguen peticiones simultáneas', () => {
  beforeAll(async () => {
    server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const email = `despacho.${Date.now()}@test.local`;
    const [u] = await db().query<ResultSetHeader>(
      "INSERT INTO staff_users (email, password_hash, nombre, rol, paginas, activo) VALUES (?, 'x', 'Prueba', 'admin', NULL, 1)",
      [email],
    );
    adminId = u.insertId;
    token = signToken({ sub: adminId, email, nombre: 'Prueba', rol: 'admin', paginas: null });
  });

  afterAll(async () => {
    if (creadas.length) {
      await db().query('DELETE FROM cola_envios WHERE solicitud_id IN (?)', [creadas]);
      await db().query(
        'DELETE mr FROM manifiesto_remesa mr JOIN manifiesto m ON m.id = mr.manifiesto_id WHERE m.solicitud_id IN (?)',
        [creadas],
      );
      await db().query('DELETE FROM remesa WHERE solicitud_id IN (?)', [creadas]);
      await db().query('DELETE FROM manifiesto WHERE solicitud_id IN (?)', [creadas]);
      await db().query('DELETE FROM solicitud_servicio WHERE id IN (?)', [creadas]);
    }
    if (adminId) await db().query('DELETE FROM staff_users WHERE id = ?', [adminId]);
    await new Promise((r) => server.close(r));
    await db().end();
  });

  it('doble clic (3 peticiones a la vez) sobre una solicitud de 1 vehículo crea un solo despacho', async () => {
    const id = await crearSolicitud(1);
    const rs = await Promise.all([despachar(id), despachar(id), despachar(id)]);
    expect(codigos(rs)).toEqual([200, 409, 409]);
    expect(await estado(id)).toMatchObject({ estado: 'despachada', restantes: 0, manifiestos: 1, remesas: 1 });
  });

  it('un reintento después del éxito responde 409 y no crea otro despacho', async () => {
    const id = await crearSolicitud(1);
    expect((await despachar(id)).status).toBe(200);
    const retry = await despachar(id);
    expect(retry.status).toBe(409);
    expect(await estado(id)).toMatchObject({ manifiestos: 1, restantes: 0 });
  });

  it('solicitud de 2 vehículos con 4 peticiones a la vez: exactamente 2 despachos', async () => {
    const id = await crearSolicitud(2);
    const rs = await Promise.all([despachar(id), despachar(id), despachar(id), despachar(id)]);
    expect(codigos(rs)).toEqual([200, 200, 409, 409]);
    expect(await estado(id)).toMatchObject({ estado: 'despachada', restantes: 0, manifiestos: 2 });
  });

  it('dos despachos simultáneos no superan el peso de la solicitud', async () => {
    const id = await crearSolicitud(2, 100);
    const rs = await Promise.all([despachar(id, [{ peso: 60 }]), despachar(id, [{ peso: 60 }])]);
    expect(codigos(rs)).toEqual([200, 400]);
    expect(await estado(id)).toMatchObject({ manifiestos: 1, peso: 60, restantes: 1, estado: 'procesada' });
  });
});
