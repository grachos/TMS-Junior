/**
 * Página Empresa:
 * - La clave del RNDC nunca sale por GET /api/empresa (antes la recibía
 *   cualquier usuario, también cada vez que un operador abría un despacho).
 *   Guardar con el campo vacío conserva la clave; escribir una nueva la cambia.
 * - Guardar la página no debe pisar los consecutivos con el valor que tenía el
 *   formulario al abrirse: si entre tanto hubo un despacho, el contador volvía
 *   atrás y los siguientes despachos chocaban con la llave única (v47).
 *
 * Ruta HTTP real contra una base MySQL/MariaDB REAL de pruebas (modifica
 * maestro_empresa y la restaura; crea y borra solicitudes/usuarios):
 *   TEST_DB=1 DB_HOST=127.0.0.1 DB_NAME=tms_test DB_USER=... DB_PASS=... npx vitest run test/empresa_seguridad.db.test.ts
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
let original: RowDataPacket;
let tokenAdmin = '';
let tokenOperador = '';

async function usuario(nombre: string, rol: 'admin' | 'operador'): Promise<string> {
  const email = `${nombre}.${sufijo}@test.local`;
  const [u] = await db().query<ResultSetHeader>(
    "INSERT INTO staff_users (email, password_hash, nombre, rol, paginas, activo) VALUES (?, 'x', ?, ?, NULL, 1)",
    [email, nombre, rol],
  );
  usuarios.push(u.insertId);
  return signToken({ sub: u.insertId, email, nombre, rol, paginas: null });
}

const llamar = (method: string, path: string, token: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function enDb(): Promise<RowDataPacket> {
  const [[e]] = await db().query<RowDataPacket[]>('SELECT * FROM maestro_empresa WHERE id = 1');
  return e!;
}

/** Lo que el formulario carga y luego envía: los datos + el valor original de cada consecutivo. */
async function formulario(): Promise<Record<string, unknown>> {
  const datos = (await (await llamar('GET', '/api/empresa', tokenAdmin)).json()) as Record<string, unknown>;
  return {
    ...datos,
    consecutivo_remesa_original: datos.consecutivo_remesa,
    consecutivo_manifiesto_original: datos.consecutivo_manifiesto,
  };
}

async function despachar(): Promise<number> {
  const [s] = await db().query<ResultSetHeader>(
    "INSERT INTO solicitud_servicio (fecha_solicitud, cantidad_vehiculos, cantidad_vehiculos_original, estado, peso) VALUES (CURDATE(), 1, 1, 'borrador', 0)",
  );
  solicitudes.push(s.insertId);
  const r = await llamar('POST', `/api/solicitudes/${s.insertId}/despachar`, tokenAdmin, {
    placa_vehiculo: 'TST123', conductor_tipo_id: 'C', conductor_num_id: '1',
  });
  expect(r.status).toBe(200);
  return s.insertId;
}

describe.skipIf(!RUN)('página Empresa: clave RNDC y consecutivos', () => {
  beforeAll(async () => {
    server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    tokenAdmin = await usuario('empadmin', 'admin');
    tokenOperador = await usuario('empop', 'operador');
    original = await enDb();
    await db().query(
      "UPDATE maestro_empresa SET nit = '900123456', rndc_password = 'ClaveSecreta-Original', consecutivo_manifiesto = 'MAN-00300', consecutivo_remesa = 'REM-00300' WHERE id = 1",
    );
  });

  afterAll(async () => {
    if (solicitudes.length) {
      await db().query('DELETE FROM cola_envios WHERE solicitud_id IN (?)', [solicitudes]);
      await db().query('DELETE FROM remesa WHERE solicitud_id IN (?)', [solicitudes]);
      await db().query('DELETE FROM manifiesto WHERE solicitud_id IN (?)', [solicitudes]);
      await db().query('DELETE FROM solicitud_servicio WHERE id IN (?)', [solicitudes]);
    }
    await db().query("DELETE FROM manifiesto WHERE num_manifiesto = 'MAN-00500'");
    if (usuarios.length) {
      await db().query('DELETE FROM auditoria WHERE usuario_id IN (?)', [usuarios]);
      await db().query('DELETE FROM staff_users WHERE id IN (?)', [usuarios]);
    }
    await db().query(
      'UPDATE maestro_empresa SET nit = ?, rndc_password = ?, telefono = ?, consecutivo_manifiesto = ?, consecutivo_remesa = ? WHERE id = 1',
      [original.nit, original.rndc_password, original.telefono, original.consecutivo_manifiesto, original.consecutivo_remesa],
    );
    await new Promise((r) => server.close(r));
    await db().end();
  });

  it('GET /api/empresa no devuelve la clave del RNDC (ni a operador ni a admin), solo si está configurada', async () => {
    for (const token of [tokenOperador, tokenAdmin]) {
      const e = (await (await llamar('GET', '/api/empresa', token)).json()) as Record<string, unknown>;
      expect(e).not.toHaveProperty('rndc_password');
      expect(JSON.stringify(e)).not.toContain('ClaveSecreta-Original');
      expect(e.rndc_password_configurada).toBe(true);
    }
  });

  it('guardar con la clave vacía la conserva; escribir una nueva la cambia', async () => {
    const f = await formulario();
    expect((await llamar('PUT', '/api/empresa', tokenAdmin, { ...f, telefono: '6011234567', rndc_password: '' })).status).toBe(200);
    expect((await enDb()).rndc_password).toBe('ClaveSecreta-Original');
    expect((await llamar('PUT', '/api/empresa', tokenAdmin, { ...(await formulario()), rndc_password: 'ClaveNueva-2' })).status).toBe(200);
    expect((await enDb()).rndc_password).toBe('ClaveNueva-2');
  });

  it('un formulario abierto antes de un despacho no devuelve el consecutivo atrás al guardar', async () => {
    const f = await formulario(); // el admin abre la página
    await despachar(); // mientras tanto, alguien despacha (MAN-00301)
    const antes = await enDb();
    expect(antes.consecutivo_manifiesto).toBe('MAN-00301');
    const r = await llamar('PUT', '/api/empresa', tokenAdmin, { ...f, telefono: '6019999999' }); // guarda otro cambio
    expect(r.status).toBe(200);
    const despues = await enDb();
    expect(despues.telefono).toBe('6019999999');
    expect(despues.consecutivo_manifiesto).toBe('MAN-00301');
    expect(despues.consecutivo_remesa).toBe(antes.consecutivo_remesa);
  });

  it('cambiar el consecutivo sobre un valor que ya cambió responde 409 y no toca nada', async () => {
    const f = await formulario();
    await despachar();
    const antes = await enDb();
    const r = await llamar('PUT', '/api/empresa', tokenAdmin, { ...f, consecutivo_manifiesto: 'MAN-00900' });
    expect(r.status).toBe(409);
    expect((await enDb()).consecutivo_manifiesto).toBe(antes.consecutivo_manifiesto);
  });

  it('un cambio explícito y vigente del consecutivo sí se aplica', async () => {
    const f = await formulario();
    const r = await llamar('PUT', '/api/empresa', tokenAdmin, { ...f, consecutivo_manifiesto: 'MAN-00400' });
    expect(r.status).toBe(200);
    expect((await enDb()).consecutivo_manifiesto).toBe('MAN-00400');
  });

  it('no permite bajar el consecutivo por debajo del número más alto ya usado', async () => {
    const [[s]] = await db().query<RowDataPacket[]>('SELECT id FROM solicitud_servicio WHERE id = ?', [solicitudes[0]]);
    await db().query("INSERT INTO manifiesto (solicitud_id, num_manifiesto) VALUES (?, 'MAN-00500')", [s!.id]);
    const f = await formulario();
    const r = await llamar('PUT', '/api/empresa', tokenAdmin, { ...f, consecutivo_manifiesto: 'MAN-00450' });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/MAN-00500/);
  });
});
