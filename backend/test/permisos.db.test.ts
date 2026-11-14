/**
 * Permisos por acción contra la ruta HTTP real y una base MySQL/MariaDB REAL:
 * un operador solo ejecuta las acciones críticas que un administrador le
 * habilitó (el servidor decide; ocultar un botón no es seguridad).
 *   TEST_DB=1 DB_HOST=127.0.0.1 DB_NAME=tms_test DB_USER=... DB_PASS=... npx vitest run test/permisos.db.test.ts
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
let adminId = 0;
let operadorId = 0;
let tokenAdmin = '';
let tokenOperador = '';
const solicitudes: number[] = [];

const llamar = (token: string, method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const configurar = (acciones: string[] | null | undefined) =>
  llamar(tokenAdmin, 'PUT', `/api/usuarios/${operadorId}`, {
    email: operadorEmail, nombre: 'Operador permisos', rol: 'operador', paginas: null, activo: true,
    ...(acciones === undefined ? {} : { acciones }),
  });
let operadorEmail = '';

describe.skipIf(!RUN)('permisos por acción', () => {
  beforeAll(async () => {
    server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const n = Date.now() % 1_000_000;
    const [a] = await db().query<ResultSetHeader>(
      "INSERT INTO staff_users (email, password_hash, nombre, rol, paginas, activo) VALUES (?, 'x', 'Admin permisos', 'admin', NULL, 1)", [`perm.admin.${n}@test.local`]);
    adminId = a.insertId;
    operadorEmail = `perm.op.${n}@test.local`;
    const [o] = await db().query<ResultSetHeader>(
      "INSERT INTO staff_users (email, password_hash, nombre, rol, paginas, activo) VALUES (?, 'x', 'Operador permisos', 'operador', NULL, 1)", [operadorEmail]);
    operadorId = o.insertId;
    tokenAdmin = signToken({ sub: adminId, email: 'a', nombre: 'a', rol: 'admin', paginas: null });
    tokenOperador = signToken({ sub: operadorId, email: operadorEmail, nombre: 'o', rol: 'operador', paginas: null });
  });

  afterAll(async () => {
    if (solicitudes.length) await db().query('DELETE FROM solicitud_servicio WHERE id IN (?)', [solicitudes]);
    await db().query('DELETE FROM auditoria WHERE usuario_id IN (?)', [[adminId, operadorId]]);
    await db().query('DELETE FROM staff_users WHERE id IN (?)', [[adminId, operadorId]]);
    await new Promise((r) => server.close(r));
    await db().end();
  });

  it('operador sin configurar: lo crítico responde 403 y lo de siempre sigue funcionando', async () => {
    expect((await llamar(tokenOperador, 'POST', '/api/cola/procesar')).status).toBe(403);
    expect((await llamar(tokenOperador, 'GET', '/api/impuestos/ica')).status).toBe(403);
    expect((await llamar(tokenOperador, 'GET', '/api/auditoria')).status).toBe(403);
    expect((await llamar(tokenOperador, 'POST', '/api/despachos/999999/anular', {})).status).toBe(403);
    expect((await llamar(tokenOperador, 'PUT', '/api/empresa', {})).status).toBe(403);
    const r = await llamar(tokenOperador, 'POST', '/api/solicitudes', { cantidad_vehiculos: '1', interna: '1' });
    expect(r.status).toBe(201);
    solicitudes.push(((await r.json()) as { id: number }).id);
  });

  it('el administrador habilita una acción y el operador la puede usar; las demás siguen en 403', async () => {
    expect((await configurar(['cola.procesar'])).status).toBe(200);
    expect((await llamar(tokenOperador, 'POST', '/api/cola/procesar')).status).toBe(200);
    expect((await llamar(tokenOperador, 'GET', '/api/impuestos/ica')).status).toBe(403);
    expect((await llamar(tokenOperador, 'POST', '/api/despachos/999999/anular', {})).status).toBe(403);
  });

  it('se le puede QUITAR una acción de siempre: ya no puede marcar Internas pero sí crear solicitudes normales', async () => {
    expect((await configurar(['cola.procesar'])).status).toBe(200);
    const interna = await llamar(tokenOperador, 'POST', '/api/solicitudes', { cantidad_vehiculos: '1', interna: '1' });
    expect(interna.status).toBe(403);
    const normal = await llamar(tokenOperador, 'POST', '/api/solicitudes', { cantidad_vehiculos: '1' });
    expect(normal.status).toBe(201);
    const id = ((await normal.json()) as { id: number }).id;
    solicitudes.push(id);
    // Editar sin tocar la marca está permitido; cambiarla, no.
    expect((await llamar(tokenOperador, 'PUT', `/api/solicitudes/${id}`, { cantidad_vehiculos: '1', interna: '0' })).status).toBe(200);
    expect((await llamar(tokenOperador, 'PUT', `/api/solicitudes/${id}`, { cantidad_vehiculos: '1', interna: '1' })).status).toBe(403);
    expect((await llamar(tokenOperador, 'POST', `/api/solicitudes/${id}/despachar`, { placa_vehiculo: 'TST123', conductor_num_id: '1' })).status).toBe(403);
  });

  it('una clave inventada se rechaza (400) y no cambia nada; guardar sin enviar acciones conserva las guardadas', async () => {
    expect((await configurar(['hackear.todo'])).status).toBe(400);
    expect((await configurar(undefined)).status).toBe(200);
    expect((await llamar(tokenOperador, 'POST', '/api/cola/procesar')).status).toBe(200);
  });

  it('un operador no puede darse permisos a sí mismo: Usuarios sigue siendo solo del administrador', async () => {
    const r = await llamar(tokenOperador, 'PUT', `/api/usuarios/${operadorId}`, {
      email: operadorEmail, nombre: 'x', rol: 'admin', paginas: null, activo: true, acciones: null,
    });
    expect(r.status).toBe(403);
    expect((await llamar(tokenOperador, 'GET', '/api/usuarios/acciones')).status).toBe(403);
  });

  it('volver a null devuelve los valores por defecto; el cambio queda en la auditoría', async () => {
    expect((await configurar(null)).status).toBe(200);
    expect((await llamar(tokenOperador, 'POST', '/api/cola/procesar')).status).toBe(403);
    const [rows] = await db().query<RowDataPacket[]>(
      "SELECT descripcion FROM auditoria WHERE accion = 'usuario.actualizar' AND entidad_id = ? ORDER BY id DESC LIMIT 1", [String(operadorId)]);
    expect(rows[0]?.descripcion).toMatch(/acciones/);
  });

  it('el administrador no queda limitado por la columna: aunque se guarde una lista, sigue pudiendo todo', async () => {
    await db().query("UPDATE staff_users SET acciones = '[]' WHERE id = ?", [adminId]);
    expect((await llamar(tokenAdmin, 'GET', '/api/impuestos/ica')).status).toBe(200);
  });
});
