/**
 * Hallazgos #7 y #10 (blindaje transaccional):
 * - #7: dos "Anular" simultáneos sobre el mismo despacho (cascada o un solo
 *   documento) deben encolar la anulación una sola vez.
 * - #10: el cumplido solo puede tocar remesas de SU manifiesto, y dos
 *   guardados simultáneos no deben duplicar los envíos de cumplido en la cola.
 *
 * Ruta HTTP real contra una base MySQL/MariaDB REAL de pruebas (crea y borra
 * solicitudes, manifiestos, remesas y filas de cola):
 *   TEST_DB=1 DB_HOST=127.0.0.1 DB_NAME=tms_test DB_USER=... DB_PASS=... npx vitest run test/anulacion_cumplido.db.test.ts
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
const solicitudes: number[] = [];
const sufijo = `${Date.now() % 1_000_000}`;
let n = 0;

/** Despacho radicado: solicitud + manifiesto aceptado + 1 remesa aceptada + su fila de cola 'manifiesto' enviada. */
async function despachoRadicado(): Promise<{ manifiestoId: number; remesaId: number; colaManifiesto: number }> {
  const [s] = await db().query<ResultSetHeader>(
    "INSERT INTO solicitud_servicio (fecha_solicitud, cantidad_vehiculos, cantidad_vehiculos_original, estado) VALUES (CURDATE(), 0, 1, 'despachada')",
  );
  solicitudes.push(s.insertId);
  n++;
  const [m] = await db().query<ResultSetHeader>(
    "INSERT INTO manifiesto (solicitud_id, num_manifiesto, estado_rndc) VALUES (?, ?, 'aceptado')",
    [s.insertId, `MAN-T${sufijo}-${n}`],
  );
  const [r] = await db().query<ResultSetHeader>(
    "INSERT INTO remesa (solicitud_id, num_remesa, estado_rndc, peso) VALUES (?, ?, 'aceptado', 10)",
    [s.insertId, `REM-T${sufijo}-${n}`],
  );
  await db().query('INSERT INTO manifiesto_remesa (manifiesto_id, remesa_id) VALUES (?, ?)', [m.insertId, r.insertId]);
  const [c] = await db().query<ResultSetHeader>(
    `INSERT INTO cola_envios (solicitud_id, manifiesto_id, tipo_documento, referencia_id, proceso_rndc, orden, payload_xml, estado)
     VALUES (?, ?, 'manifiesto', ?, 4, 40, '<x/>', 'enviado')`,
    [s.insertId, m.insertId, m.insertId],
  );
  return { manifiestoId: m.insertId, remesaId: r.insertId, colaManifiesto: c.insertId };
}

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

async function filasCola(manifiestoId: number, tipo: string): Promise<number> {
  const [[f]] = await db().query<RowDataPacket[]>(
    'SELECT COUNT(*) AS n FROM cola_envios WHERE manifiesto_id = ? AND tipo_documento = ?',
    [manifiestoId, tipo],
  );
  return Number(f!.n);
}

const codigos = (rs: Response[]) => rs.map((r) => r.status).sort();
const anular = { motivo: 'digitacion', observaciones: 'prueba de concurrencia' };

describe.skipIf(!RUN)('anulación y cumplido bajo concurrencia', () => {
  beforeAll(async () => {
    server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const email = `anulacion.${sufijo}@test.local`;
    const [u] = await db().query<ResultSetHeader>(
      "INSERT INTO staff_users (email, password_hash, nombre, rol, paginas, activo) VALUES (?, 'x', 'Prueba', 'admin', NULL, 1)",
      [email],
    );
    adminId = u.insertId;
    token = signToken({ sub: adminId, email, nombre: 'Prueba', rol: 'admin', paginas: null });
  });

  afterAll(async () => {
    if (solicitudes.length) {
      await db().query('DELETE FROM cola_envios WHERE solicitud_id IN (?)', [solicitudes]);
      // manifiesto_remesa cae en cascada con manifiesto/remesa.
      await db().query('DELETE FROM remesa WHERE solicitud_id IN (?)', [solicitudes]);
      await db().query('DELETE FROM manifiesto WHERE solicitud_id IN (?)', [solicitudes]);
      await db().query('DELETE FROM solicitud_servicio WHERE id IN (?)', [solicitudes]);
    }
    if (adminId) await db().query('DELETE FROM staff_users WHERE id = ?', [adminId]);
    await new Promise((r) => server.close(r));
    await db().end();
  });

  it('#7 dos "Anular despacho" a la vez encolan la cascada una sola vez', async () => {
    const d = await despachoRadicado();
    const rs = await Promise.all([post(`/api/despachos/${d.manifiestoId}/anular`, anular), post(`/api/despachos/${d.manifiestoId}/anular`, anular)]);
    expect(codigos(rs)).toEqual([200, 400]);
    expect(await filasCola(d.manifiestoId, 'anular_manifiesto')).toBe(1);
    expect(await filasCola(d.manifiestoId, 'anular_remesa')).toBe(1);
  });

  it('#7 dos "Anular" individuales a la vez sobre la misma fila encolan una sola anulación', async () => {
    const d = await despachoRadicado();
    const rs = await Promise.all([post(`/api/cola/${d.colaManifiesto}/anular`, anular), post(`/api/cola/${d.colaManifiesto}/anular`, anular)]);
    expect(codigos(rs)).toEqual([200, 400]);
    expect(await filasCola(d.manifiestoId, 'anular_manifiesto')).toBe(1);
  });

  it('#7 "Anular despacho" e "Anular" individual a la vez no duplican la anulación del manifiesto', async () => {
    const d = await despachoRadicado();
    const rs = await Promise.all([post(`/api/despachos/${d.manifiestoId}/anular`, anular), post(`/api/cola/${d.colaManifiesto}/anular`, anular)]);
    expect(codigos(rs)).toEqual([200, 400]);
    expect(await filasCola(d.manifiestoId, 'anular_manifiesto')).toBe(1);
  });

  it('#10 el cumplido rechaza una remesa de otro manifiesto y no la modifica', async () => {
    const a = await despachoRadicado();
    const b = await despachoRadicado();
    const r = await post(`/api/cumplido/${a.manifiestoId}`, {
      cumplido_tipo: 'C',
      remesas: [{ id: b.remesaId, cumplido_tipo: 'C', cantidad_entregada: 999 }],
    });
    expect(r.status).toBe(400);
    const [[rem]] = await db().query<RowDataPacket[]>('SELECT cantidad_entregada FROM remesa WHERE id = ?', [b.remesaId]);
    expect(rem!.cantidad_entregada).toBeNull();
    expect(await filasCola(a.manifiestoId, 'cumplido_remesa')).toBe(0);
  });

  it('#10 dos guardados del cumplido a la vez dejan un solo envío por documento en la cola', async () => {
    const d = await despachoRadicado();
    const body = { cumplido_tipo: 'C', remesas: [{ id: d.remesaId, cumplido_tipo: 'C', cantidad_entregada: 10 }] };
    const rs = await Promise.all([post(`/api/cumplido/${d.manifiestoId}`, body), post(`/api/cumplido/${d.manifiestoId}`, body)]);
    expect(codigos(rs)).toEqual([200, 200]);
    expect(await filasCola(d.manifiestoId, 'cumplido_manifiesto')).toBe(1);
    expect(await filasCola(d.manifiestoId, 'cumplido_remesa')).toBe(1);
  });

  it('#10 cumplido de un manifiesto que no existe responde 404', async () => {
    const r = await post('/api/cumplido/999999999', { cumplido_tipo: 'C', remesas: [] });
    expect(r.status).toBe(404);
  });
});
