/**
 * ICA por municipio de origen (migracion_v52, página Impuestos):
 * - Solo un administrador configura las tarifas; cualquier usuario puede
 *   consultar la de un municipio (el formulario de solicitud la propone).
 * - Valores inválidos y municipios inexistentes se rechazan.
 * - Cada cambio queda en la bitácora con antes/después, en su transacción.
 * - Una solicitud conserva la tarifa con la que se guardó: cambiar la tabla no
 *   altera las solicitudes existentes, y la retención sigue siendo
 *   flete × tarifa ÷ 1000.
 *
 * Ruta HTTP real contra una base MySQL/MariaDB REAL de pruebas:
 *   TEST_DB=1 DB_HOST=127.0.0.1 DB_NAME=tms_test DB_USER=... DB_PASS=... npx vitest run test/ica.db.test.ts
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
const sufijo = `${Date.now() % 1_000_000}`;
const usuarios: number[] = [];
const solicitudes: number[] = [];
let tokenAdmin = '';
let tokenOperador = '';
let adminId = 0;
let A = ''; // municipio de prueba 1
let B = ''; // municipio de prueba 2
let nombreA = '';

async function usuario(nombre: string, rol: 'admin' | 'operador'): Promise<{ token: string; id: number }> {
  const email = `${nombre}.${sufijo}@test.local`;
  const [u] = await db().query<ResultSetHeader>(
    "INSERT INTO staff_users (email, password_hash, nombre, rol, paginas, activo) VALUES (?, 'x', ?, ?, NULL, 1)",
    [email, nombre, rol],
  );
  usuarios.push(u.insertId);
  return { id: u.insertId, token: signToken({ sub: u.insertId, email, nombre, rol, paginas: null }) };
}

const llamar = (method: string, path: string, token: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const tarifaEnDb = async (codigo: string) => {
  const [rows] = await db().query<RowDataPacket[]>('SELECT tarifa_por_mil FROM ica_municipio WHERE codigo_rndc = ?', [codigo]);
  return rows[0] ? Number(rows[0].tarifa_por_mil) : null;
};

describe.skipIf(!RUN)('ICA por municipio de origen', () => {
  beforeAll(async () => {
    server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const admin = await usuario('icaadmin', 'admin');
    tokenAdmin = admin.token;
    adminId = admin.id;
    tokenOperador = (await usuario('icaop', 'operador')).token;
    const [mun] = await db().query<RowDataPacket[]>('SELECT codigo_rndc, nombre_completo FROM municipio ORDER BY codigo_rndc LIMIT 2');
    A = String(mun[0]!.codigo_rndc);
    B = String(mun[1]!.codigo_rndc);
    nombreA = String(mun[0]!.nombre_completo);
    await db().query('DELETE FROM ica_municipio WHERE codigo_rndc IN (?, ?)', [A, B]);
  });

  afterAll(async () => {
    await db().query('DELETE FROM ica_municipio WHERE codigo_rndc IN (?, ?)', [A, B]);
    if (solicitudes.length) await db().query('DELETE FROM solicitud_servicio WHERE id IN (?)', [solicitudes]);
    if (usuarios.length) {
      await db().query('DELETE FROM auditoria WHERE usuario_id IN (?)', [usuarios]);
      await db().query('DELETE FROM staff_users WHERE id IN (?)', [usuarios]);
    }
    await new Promise((r) => server.close(r));
    await db().end();
  });

  it('un municipio sin tarifa se consulta como null (no es un error)', async () => {
    const r = await llamar('GET', `/api/impuestos/ica/${B}`, tokenOperador);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ codigo_rndc: B, tarifa_por_mil: null });
  });

  it('el administrador guarda la tarifa y cualquier usuario la consulta', async () => {
    const r = await llamar('PUT', `/api/impuestos/ica/${A}`, tokenAdmin, { tarifa_por_mil: 9.66 });
    expect(r.status).toBe(200);
    expect(await tarifaEnDb(A)).toBe(9.66);
    const c = await llamar('GET', `/api/impuestos/ica/${A}`, tokenOperador);
    expect(await c.json()).toMatchObject({ codigo_rndc: A, tarifa_por_mil: 9.66, municipio: nombreA });
  });

  it('un operador no puede guardar, borrar ni listar tarifas', async () => {
    expect((await llamar('PUT', `/api/impuestos/ica/${B}`, tokenOperador, { tarifa_por_mil: 5 })).status).toBe(403);
    expect((await llamar('DELETE', `/api/impuestos/ica/${A}`, tokenOperador)).status).toBe(403);
    expect((await llamar('GET', '/api/impuestos/ica', tokenOperador)).status).toBe(403);
    expect(await tarifaEnDb(B)).toBeNull();
    expect(await tarifaEnDb(A)).toBe(9.66);
  });

  it.each([
    ['negativa', { tarifa_por_mil: -1 }],
    ['mayor que 100 por mil', { tarifa_por_mil: 100.001 }],
    ['no numérica', { tarifa_por_mil: 'abc' }],
    ['vacía', { tarifa_por_mil: '' }],
    ['ausente', {}],
    ['con más de 3 decimales', { tarifa_por_mil: 9.6612 }],
  ])('rechaza una tarifa %s', async (_nombre, body) => {
    const r = await llamar('PUT', `/api/impuestos/ica/${B}`, tokenAdmin, body);
    expect(r.status).toBe(400);
    expect(await tarifaEnDb(B)).toBeNull();
  });

  it('rechaza un municipio que no existe', async () => {
    const r = await llamar('PUT', '/api/impuestos/ica/99999999', tokenAdmin, { tarifa_por_mil: 5 });
    expect(r.status).toBe(404);
    expect(await tarifaEnDb('99999999')).toBeNull();
  });

  it('acepta 0 (municipio exento) y los extremos 0 y 100', async () => {
    for (const t of [0, 100, 2.5]) {
      expect((await llamar('PUT', `/api/impuestos/ica/${B}`, tokenAdmin, { tarifa_por_mil: t })).status).toBe(200);
      expect(await tarifaEnDb(B)).toBe(t);
    }
  });

  it('guardar dos veces deja una sola fila y la bitácora guarda antes/después', async () => {
    await llamar('PUT', `/api/impuestos/ica/${B}`, tokenAdmin, { tarifa_por_mil: 7 });
    await llamar('PUT', `/api/impuestos/ica/${B}`, tokenAdmin, { tarifa_por_mil: 8.5 });
    const [[n]] = await db().query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM ica_municipio WHERE codigo_rndc = ?', [B]);
    expect(Number(n!.n)).toBe(1);
    const [regs] = await db().query<RowDataPacket[]>(
      "SELECT * FROM auditoria WHERE accion = 'impuesto.ica.guardar' AND entidad_id = ? ORDER BY id DESC LIMIT 1",
      [B],
    );
    expect(regs[0]).toMatchObject({ usuario_id: adminId, entidad: 'impuesto_ica' });
    expect(JSON.parse(String(regs[0]!.detalle))).toMatchObject({ antes: 7, despues: 8.5 });
  });

  it('dos guardados simultáneos del mismo municipio dejan una sola fila', async () => {
    await db().query('DELETE FROM ica_municipio WHERE codigo_rndc = ?', [B]);
    const rs = await Promise.all([
      llamar('PUT', `/api/impuestos/ica/${B}`, tokenAdmin, { tarifa_por_mil: 4 }),
      llamar('PUT', `/api/impuestos/ica/${B}`, tokenAdmin, { tarifa_por_mil: 6 }),
    ]);
    expect(rs.map((r) => r.status)).toEqual([200, 200]);
    const [[n]] = await db().query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM ica_municipio WHERE codigo_rndc = ?', [B]);
    expect(Number(n!.n)).toBe(1);
    expect([4, 6]).toContain(await tarifaEnDb(B));
  });

  it('el listado filtra por texto, trae el nombre del municipio y pagina', async () => {
    const r = await llamar('GET', `/api/impuestos/ica?q=${encodeURIComponent(A)}&pageSize=10`, tokenAdmin);
    const body = (await r.json()) as { items: { codigo_rndc: string; municipio: string; tarifa_por_mil: number }[]; total: number };
    expect(body.items.map((i) => i.codigo_rndc)).toContain(A);
    expect(body.items.find((i) => i.codigo_rndc === A)).toMatchObject({ municipio: nombreA, tarifa_por_mil: 9.66 });
    const todo = (await (await llamar('GET', '/api/impuestos/ica?pageSize=1&page=1', tokenAdmin)).json()) as { items: unknown[]; total: number };
    expect(todo.items).toHaveLength(1);
    expect(todo.total).toBeGreaterThanOrEqual(2);
  });

  it('una solicitud conserva la tarifa con la que se guardó aunque la tabla cambie', async () => {
    // flete 5.000.000 × 9,66 por mil = 48.300
    const crear = await llamar('POST', '/api/solicitudes', tokenAdmin, { cantidad_vehiculos: '1', valor_flete: '5000000', porcentaje_ica: '9.66' });
    expect(crear.status).toBe(201);
    const { id } = (await crear.json()) as { id: number };
    solicitudes.push(id);
    const leer = async () => {
      const [[s]] = await db().query<RowDataPacket[]>('SELECT porcentaje_ica, retencion_ica FROM solicitud_servicio WHERE id = ?', [id]);
      return { tarifa: Number(s!.porcentaje_ica), retencion: Number(s!.retencion_ica) };
    };
    expect(await leer()).toEqual({ tarifa: 9.66, retencion: 48300 });
    await llamar('PUT', `/api/impuestos/ica/${A}`, tokenAdmin, { tarifa_por_mil: 14 });
    expect(await leer()).toEqual({ tarifa: 9.66, retencion: 48300 });
  });

  it('borrar la tarifa la quita y queda en la bitácora; borrar otra vez responde 404', async () => {
    expect((await llamar('DELETE', `/api/impuestos/ica/${A}`, tokenAdmin)).status).toBe(200);
    expect(await tarifaEnDb(A)).toBeNull();
    const c = await llamar('GET', `/api/impuestos/ica/${A}`, tokenOperador);
    expect(await c.json()).toMatchObject({ tarifa_por_mil: null });
    const [regs] = await db().query<RowDataPacket[]>(
      "SELECT detalle FROM auditoria WHERE accion = 'impuesto.ica.eliminar' AND entidad_id = ?",
      [A],
    );
    expect(regs).toHaveLength(1);
    expect(JSON.parse(String(regs[0]!.detalle))).toMatchObject({ antes: 14 });
    expect((await llamar('DELETE', `/api/impuestos/ica/${A}`, tokenAdmin)).status).toBe(404);
  });
});
