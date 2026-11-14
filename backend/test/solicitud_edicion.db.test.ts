/**
 * Edición de solicitudes:
 * - Sin `cantidad_vehiculos` válida, crear/editar responde 400 (antes: 500 por
 *   una columna NOT NULL).
 * - Una edición que coincide con un despacho NO puede devolver el cupo del
 *   vehículo ya usado: actualizar() revisa que siga en borrador DESPUÉS de
 *   bloquear la fila (el chequeo de la ruta se hace antes y puede estar viejo).
 * - Cambiar la cantidad de vehículos de un borrador actualiza también la
 *   cantidad original (la lista muestra X/Y y el tope de una anulación).
 *
 * Ruta HTTP real contra una base MySQL/MariaDB REAL de pruebas:
 *   TEST_DB=1 DB_HOST=127.0.0.1 DB_NAME=tms_test DB_USER=... DB_PASS=... npx vitest run test/solicitud_edicion.db.test.ts
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
const solicitudRepo = await import('../src/modules/solicitudes/solicitud.repo.js');

let server: Server;
let base = '';
let token = '';
let adminId = 0;
const solicitudes: number[] = [];

const llamar = (method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function crear(vehiculos: number): Promise<number> {
  const r = await llamar('POST', '/api/solicitudes', { cantidad_vehiculos: String(vehiculos) });
  expect(r.status).toBe(201);
  const { id } = (await r.json()) as { id: number };
  solicitudes.push(id);
  return id;
}
const despachar = (id: number) =>
  llamar('POST', `/api/solicitudes/${id}/despachar`, { placa_vehiculo: 'TST123', conductor_tipo_id: 'C', conductor_num_id: '1' });
async function enDb(id: number): Promise<RowDataPacket> {
  const [[s]] = await db().query<RowDataPacket[]>('SELECT estado, cantidad_vehiculos, cantidad_vehiculos_original FROM solicitud_servicio WHERE id = ?', [id]);
  return s!;
}
async function manifiestos(id: number): Promise<number> {
  const [[m]] = await db().query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM manifiesto WHERE solicitud_id = ?', [id]);
  return Number(m!.n);
}

describe.skipIf(!RUN)('edición de solicitudes', () => {
  beforeAll(async () => {
    server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const email = `edicion.${Date.now() % 1_000_000}@test.local`;
    const [u] = await db().query<ResultSetHeader>(
      "INSERT INTO staff_users (email, password_hash, nombre, rol, paginas, activo) VALUES (?, 'x', 'Edicion', 'admin', NULL, 1)",
      [email],
    );
    adminId = u.insertId;
    token = signToken({ sub: adminId, email, nombre: 'Edicion', rol: 'admin', paginas: null });
  });

  afterAll(async () => {
    if (solicitudes.length) {
      await db().query('DELETE FROM cola_envios WHERE solicitud_id IN (?)', [solicitudes]);
      await db().query('DELETE FROM remesa WHERE solicitud_id IN (?)', [solicitudes]);
      await db().query('DELETE FROM manifiesto WHERE solicitud_id IN (?)', [solicitudes]);
      await db().query('DELETE FROM solicitud_servicio WHERE id IN (?)', [solicitudes]);
    }
    await db().query('DELETE FROM auditoria WHERE usuario_id = ?', [adminId]);
    await db().query('DELETE FROM staff_users WHERE id = ?', [adminId]);
    await new Promise((r) => server.close(r));
    await db().end();
  });

  it.each([
    ['ausente', {}],
    ['vacía', { cantidad_vehiculos: '' }],
    ['cero', { cantidad_vehiculos: '0' }],
    ['negativa', { cantidad_vehiculos: '-1' }],
    ['no numérica', { cantidad_vehiculos: 'abc' }],
    ['con decimales', { cantidad_vehiculos: '2.5' }],
  ])('crear con cantidad de vehículos %s responde 400, no 500', async (_n, body) => {
    const r = await llamar('POST', '/api/solicitudes', body);
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/cantidad de veh/i);
  });

  it('editar sin cantidad de vehículos válida responde 400 y no cambia nada', async () => {
    const id = await crear(2);
    const r = await llamar('PUT', `/api/solicitudes/${id}`, { observaciones: 'sin cantidad' });
    expect(r.status).toBe(400);
    expect(await enDb(id)).toMatchObject({ cantidad_vehiculos: 2, cantidad_vehiculos_original: 2 });
  });

  it('cambiar la cantidad de vehículos de un borrador actualiza también la cantidad original, y alcanza para despachar', async () => {
    const id = await crear(1);
    expect((await llamar('PUT', `/api/solicitudes/${id}`, { cantidad_vehiculos: '3' })).status).toBe(200);
    expect(await enDb(id)).toMatchObject({ cantidad_vehiculos: 3, cantidad_vehiculos_original: 3 });
    for (let i = 0; i < 3; i++) expect((await despachar(id)).status).toBe(200);
    expect((await despachar(id)).status).toBe(409);
    expect(await manifiestos(id)).toBe(3);
  });

  it('una edición que llega después de un despacho no devuelve el cupo usado (regla dentro del bloqueo)', async () => {
    const id = await crear(1);
    expect((await despachar(id)).status).toBe(200);
    expect(await enDb(id)).toMatchObject({ estado: 'despachada', cantidad_vehiculos: 0 });
    // El chequeo de la ruta ya pasó (la edición leyó "borrador" antes del despacho):
    // se llama al repositorio directamente, que es lo que ejecutaría esa edición vieja.
    await expect(solicitudRepo.actualizar(id, { cantidad_vehiculos: '1' })).rejects.toMatchObject({ status: 409 });
    expect(await enDb(id)).toMatchObject({ estado: 'despachada', cantidad_vehiculos: 0 });
    expect(await manifiestos(id)).toBe(1);
  });

  it('despachar y editar a la vez, 25 veces: nunca queda un cupo de más', async () => {
    for (let i = 0; i < 25; i++) {
      const id = await crear(1);
      await Promise.all([despachar(id), llamar('PUT', `/api/solicitudes/${id}`, { cantidad_vehiculos: '1', observaciones: `edición ${i}` })]);
      const s = await enDb(id);
      // Invariante: cupos que quedan + despachos hechos = cupos de la solicitud.
      expect(Number(s.cantidad_vehiculos) + (await manifiestos(id))).toBe(Number(s.cantidad_vehiculos_original));
    }
  });
});
