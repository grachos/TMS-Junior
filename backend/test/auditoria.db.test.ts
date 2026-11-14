/**
 * Hallazgo #11 (blindaje transaccional): bitácora de auditoría.
 * - Cada operación sensible deja UN registro con quién, qué y cuándo, escrito
 *   en su misma transacción: una operación rechazada o revertida no deja nada.
 * - Los cambios guardan antes/después; las contraseñas nunca (solo "cambió").
 * - El visor (GET /api/auditoria) filtra y es solo para administradores.
 *
 * Ruta HTTP real contra una base MySQL/MariaDB REAL de pruebas (crea y borra
 * usuarios, solicitudes, despachos y registros de auditoría):
 *   TEST_DB=1 DB_HOST=127.0.0.1 DB_NAME=tms_test DB_USER=... DB_PASS=... npx vitest run test/auditoria.db.test.ts
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
let empresaOriginal: RowDataPacket | null = null;

async function crearUsuario(nombre: string, rol: 'admin' | 'operador'): Promise<{ id: number; email: string; token: string }> {
  const email = `${nombre}.${sufijo}@test.local`;
  const [u] = await db().query<ResultSetHeader>(
    "INSERT INTO staff_users (email, password_hash, nombre, rol, paginas, activo) VALUES (?, 'x', ?, ?, NULL, 1)",
    [email, nombre, rol],
  );
  usuarios.push(u.insertId);
  return { id: u.insertId, email, token: signToken({ sub: u.insertId, email, nombre, rol, paginas: null }) };
}

async function crearSolicitud(vehiculos = 1): Promise<number> {
  const [s] = await db().query<ResultSetHeader>(
    "INSERT INTO solicitud_servicio (fecha_solicitud, cantidad_vehiculos, cantidad_vehiculos_original, estado, peso) VALUES (CURDATE(), ?, ?, 'borrador', 0)",
    [vehiculos, vehiculos],
  );
  solicitudes.push(s.insertId);
  return s.insertId;
}

const llamar = (method: string, path: string, token: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function registros(accion: string, entidadId?: string | number): Promise<RowDataPacket[]> {
  const [rows] = await db().query<RowDataPacket[]>(
    `SELECT * FROM auditoria WHERE accion = ? ${entidadId !== undefined ? 'AND entidad_id = ?' : ''} ORDER BY id`,
    entidadId !== undefined ? [accion, String(entidadId)] : [accion],
  );
  return rows;
}

const despacho = { placa_vehiculo: 'TST123', conductor_tipo_id: 'C', conductor_num_id: '1' };

describe.skipIf(!RUN)('bitácora de auditoría', () => {
  let admin: Awaited<ReturnType<typeof crearUsuario>>;
  let operador: Awaited<ReturnType<typeof crearUsuario>>;

  beforeAll(async () => {
    server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    admin = await crearUsuario('auditadmin', 'admin');
    operador = await crearUsuario('auditop', 'operador');
    const [[e]] = await db().query<RowDataPacket[]>('SELECT * FROM maestro_empresa WHERE id = 1');
    empresaOriginal = e ?? null;
  });

  afterAll(async () => {
    if (solicitudes.length) {
      await db().query('DELETE FROM cola_envios WHERE solicitud_id IN (?)', [solicitudes]);
      await db().query('DELETE FROM remesa WHERE solicitud_id IN (?)', [solicitudes]);
      await db().query('DELETE FROM manifiesto WHERE solicitud_id IN (?)', [solicitudes]);
      await db().query('DELETE FROM solicitud_servicio WHERE id IN (?)', [solicitudes]);
    }
    if (usuarios.length) {
      await db().query('DELETE FROM auditoria WHERE usuario_id IN (?) OR (entidad = "usuario" AND entidad_id IN (?))', [usuarios, usuarios.map(String)]);
      await db().query('DELETE FROM staff_users WHERE id IN (?)', [usuarios]);
    }
    if (empresaOriginal) {
      await db().query('UPDATE maestro_empresa SET razon_social = ?, rndc_password = ?, telefono = ? WHERE id = 1', [
        empresaOriginal.razon_social, empresaOriginal.rndc_password, empresaOriginal.telefono,
      ]);
    }
    await new Promise((r) => server.close(r));
    await db().end();
  });

  it('despachar deja un registro con quién y qué; un despacho rechazado no deja ninguno', async () => {
    const id = await crearSolicitud(1);
    expect((await llamar('POST', `/api/solicitudes/${id}/despachar`, operador.token, despacho)).status).toBe(200);
    expect((await llamar('POST', `/api/solicitudes/${id}/despachar`, operador.token, despacho)).status).toBe(409);
    const rs = await registros('despacho.confirmar', id);
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ usuario_id: operador.id, usuario_email: operador.email, entidad: 'solicitud' });
    expect(String(rs[0]!.descripcion)).toMatch(/MAN-/);
  });

  it('anular un despacho queda registrado una vez, con el motivo', async () => {
    const id = await crearSolicitud(1);
    await llamar('POST', `/api/solicitudes/${id}/despachar`, admin.token, despacho);
    const [[m]] = await db().query<RowDataPacket[]>('SELECT id FROM manifiesto WHERE solicitud_id = ?', [id]);
    await db().query("UPDATE manifiesto SET estado_rndc = 'aceptado' WHERE id = ?", [m!.id]);
    const body = { motivo: 'digitacion', observaciones: 'error en la placa' };
    const rs = await Promise.all([
      llamar('POST', `/api/despachos/${m!.id}/anular`, admin.token, body),
      llamar('POST', `/api/despachos/${m!.id}/anular`, admin.token, body),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 400]);
    const reg = await registros('anulacion.despacho', m!.id);
    expect(reg).toHaveLength(1);
    expect(JSON.parse(String(reg[0]!.detalle))).toMatchObject({ motivo: 'digitacion', observaciones: 'error en la placa' });
  });

  it('cambiar el rol y la contraseña de un usuario guarda antes/después, nunca la contraseña', async () => {
    const otro = await crearUsuario('auditobjetivo', 'admin');
    const r = await llamar('PUT', `/api/usuarios/${otro.id}`, admin.token, {
      email: otro.email, nombre: 'auditobjetivo', rol: 'operador', paginas: ['cola'], activo: false, password: 'NuevaClaveSegura123',
    });
    expect(r.status).toBe(200);
    const [reg] = await registros('usuario.actualizar', otro.id);
    expect(reg).toMatchObject({ usuario_id: admin.id, entidad: 'usuario' });
    const det = JSON.parse(String(reg!.detalle));
    expect(det.cambios.rol).toEqual({ antes: 'admin', despues: 'operador' });
    expect(det.cambios.activo).toEqual({ antes: 1, despues: 0 });
    expect(det.cambios.password).toBe('cambió');
    expect(String(reg!.detalle)).not.toContain('NuevaClaveSegura123');
    expect(String(reg!.detalle)).not.toMatch(/\$2[aby]\$/); // ningún hash bcrypt
  });

  it('cambiar los datos de la empresa guarda los cambios, y la clave RNDC solo como "cambió"', async () => {
    const actual = (await (await llamar('GET', '/api/empresa', admin.token)).json()) as Record<string, unknown>;
    const r = await llamar('PUT', '/api/empresa', admin.token, {
      ...actual, razon_social: `Empresa Auditada ${sufijo}`, rndc_password: `ClaveRndc-${sufijo}`,
    });
    expect(r.status).toBe(200);
    const rs = await registros('empresa.actualizar');
    const reg = rs[rs.length - 1]!;
    const det = JSON.parse(String(reg.detalle));
    expect(det.cambios.razon_social.despues).toBe(`Empresa Auditada ${sufijo}`);
    expect(det.cambios.rndc_password).toBe('cambió');
    expect(String(reg.detalle)).not.toContain(`ClaveRndc-${sufijo}`);
  });

  it('el visor filtra por usuario y acción, y es solo para administradores', async () => {
    const r = await llamar('GET', `/api/auditoria?usuario=${operador.id}&accion=despacho.confirmar`, admin.token);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: RowDataPacket[]; total: number; acciones: string[] };
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.items.every((i) => i.usuario_id === operador.id && i.accion === 'despacho.confirmar')).toBe(true);
    expect(body.acciones).toContain('despacho.confirmar');
    expect((await llamar('GET', '/api/auditoria', operador.token)).status).toBe(403);
  });
});
