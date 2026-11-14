/**
 * Solicitudes "Internas" (migracion_v53): ningún documento viaja al RNDC.
 * - Un despacho interno no encola NADA y usa su propia numeración (INT-M- /
 *   INT-R-), sin dejar huecos en la serie oficial MAN-/REM-.
 * - La marca no se puede cambiar una vez que la solicitud tiene despachos.
 * - No hay cumplido ni envío para un despacho interno; sí se puede editar y
 *   anular (localmente, sin RNDC) para liberar el cupo del vehículo.
 *
 * Ruta HTTP real contra una base MySQL/MariaDB REAL de pruebas (modifica los
 * contadores de maestro_empresa y los restaura; crea y borra solicitudes):
 *   TEST_DB=1 DB_HOST=127.0.0.1 DB_NAME=tms_test DB_USER=... DB_PASS=... npx vitest run test/interna.db.test.ts
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
const { invalidate } = await import('../src/util/cache.js');
const cola = await import('../src/modules/cola/cola.repo.js');

let server: Server;
let base = '';
let token = '';
let adminId = 0;
const solicitudes: number[] = [];
let original: RowDataPacket | null = null;
const sufijo = `${Date.now() % 1_000_000}`;

const llamar = (method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function crearSolicitud(interna: boolean, vehiculos = 1): Promise<number> {
  const r = await llamar('POST', '/api/solicitudes', { cantidad_vehiculos: String(vehiculos), interna });
  expect(r.status).toBe(201);
  const { id } = (await r.json()) as { id: number };
  solicitudes.push(id);
  return id;
}

const despachar = (id: number) =>
  llamar('POST', `/api/solicitudes/${id}/despachar`, { placa_vehiculo: 'TST123', conductor_tipo_id: 'C', conductor_num_id: '1' });

async function manifiestoDe(solicitudId: number): Promise<RowDataPacket> {
  const [[m]] = await db().query<RowDataPacket[]>('SELECT * FROM manifiesto WHERE solicitud_id = ? ORDER BY id DESC LIMIT 1', [solicitudId]);
  return m!;
}
async function remesasDe(solicitudId: number): Promise<RowDataPacket[]> {
  const [rows] = await db().query<RowDataPacket[]>('SELECT * FROM remesa WHERE solicitud_id = ? ORDER BY id', [solicitudId]);
  return rows;
}
async function filasCola(solicitudId: number): Promise<number> {
  const [[c]] = await db().query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM cola_envios WHERE solicitud_id = ?', [solicitudId]);
  return Number(c!.n);
}
async function contadores(): Promise<RowDataPacket> {
  const [[e]] = await db().query<RowDataPacket[]>(
    'SELECT consecutivo_manifiesto, consecutivo_remesa, consecutivo_interno_manifiesto, consecutivo_interno_remesa FROM maestro_empresa WHERE id = 1',
  );
  return e!;
}
async function solicitudEnDb(id: number): Promise<RowDataPacket> {
  const [[s]] = await db().query<RowDataPacket[]>('SELECT * FROM solicitud_servicio WHERE id = ?', [id]);
  return s!;
}

describe.skipIf(!RUN)('solicitudes internas: nada viaja al RNDC', () => {
  beforeAll(async () => {
    server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const email = `interna.${sufijo}@test.local`;
    const [u] = await db().query<ResultSetHeader>(
      "INSERT INTO staff_users (email, password_hash, nombre, rol, paginas, activo) VALUES (?, 'x', 'Interna', 'admin', NULL, 1)",
      [email],
    );
    adminId = u.insertId;
    token = signToken({ sub: adminId, email, nombre: 'Interna', rol: 'admin', paginas: null });
    const [[e]] = await db().query<RowDataPacket[]>('SELECT * FROM maestro_empresa WHERE id = 1');
    original = e ?? null;
    await db().query(
      "UPDATE maestro_empresa SET consecutivo_manifiesto = 'MAN-00600', consecutivo_remesa = 'REM-00600', consecutivo_interno_manifiesto = 'INT-M-00000', consecutivo_interno_remesa = 'INT-R-00000' WHERE id = 1",
    );
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
    if (original) {
      await db().query(
        'UPDATE maestro_empresa SET consecutivo_manifiesto = ?, consecutivo_remesa = ?, consecutivo_interno_manifiesto = ?, consecutivo_interno_remesa = ? WHERE id = 1',
        [original.consecutivo_manifiesto, original.consecutivo_remesa, original.consecutivo_interno_manifiesto ?? 'INT-M-00000', original.consecutivo_interno_remesa ?? 'INT-R-00000'],
      );
    }
    await new Promise((r) => server.close(r));
    await db().end();
  });

  it('un despacho interno usa su propia numeración, queda en estado "interno" y no encola nada', async () => {
    const id = await crearSolicitud(true);
    expect((await solicitudEnDb(id)).interna).toBe(1);
    expect((await despachar(id)).status).toBe(200);
    const m = await manifiestoDe(id);
    const [r] = await remesasDe(id);
    expect(m.num_manifiesto).toBe('INT-M-00001');
    expect(r!.num_remesa).toBe('INT-R-00001');
    expect(m.estado_rndc).toBe('interno');
    expect(r!.estado_rndc).toBe('interno');
    expect(await filasCola(id)).toBe(0);
    // La serie oficial no se tocó.
    expect(await contadores()).toMatchObject({ consecutivo_manifiesto: 'MAN-00600', consecutivo_remesa: 'REM-00600' });
  });

  it('dos internos seguidos y luego uno oficial: las series no se mezclan ni dejan huecos', async () => {
    const interna2 = await crearSolicitud(true);
    await despachar(interna2);
    expect((await manifiestoDe(interna2)).num_manifiesto).toBe('INT-M-00002');
    expect((await remesasDe(interna2))[0]!.num_remesa).toBe('INT-R-00002');

    const oficial = await crearSolicitud(false);
    expect((await despachar(oficial)).status).toBe(200);
    expect((await manifiestoDe(oficial)).num_manifiesto).toBe('MAN-00601'); // sin hueco por los internos
    expect((await remesasDe(oficial))[0]!.num_remesa).toBe('REM-00601');
    expect((await manifiestoDe(oficial)).estado_rndc).toBe('pendiente');
    expect(await filasCola(oficial)).toBeGreaterThan(0); // el oficial sí se encola
  });

  it('despachos internos simultáneos reciben números distintos y consecutivos', async () => {
    const [{ consecutivo_interno_manifiesto: antes }] = [await contadores()] as [{ consecutivo_interno_manifiesto: string }];
    const desde = Number(String(antes).split('-').pop());
    const ids = await Promise.all([crearSolicitud(true), crearSolicitud(true), crearSolicitud(true), crearSolicitud(true)]);
    const rs = await Promise.all(ids.map((id) => despachar(id)));
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    const nums = (await Promise.all(ids.map(async (id) => (await manifiestoDe(id)).num_manifiesto as string))).sort();
    expect(nums).toEqual(Array.from({ length: 4 }, (_, i) => `INT-M-${String(desde + 1 + i).padStart(5, '0')}`));
  });

  it('una solicitud interna de 2 vehículos genera 2 despachos internos', async () => {
    const id = await crearSolicitud(true, 2);
    await despachar(id);
    await despachar(id);
    const [[n]] = await db().query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM manifiesto WHERE solicitud_id = ? AND estado_rndc = 'interno'", [id]);
    expect(Number(n!.n)).toBe(2);
    expect(await filasCola(id)).toBe(0);
  });

  it('la marca se puede cambiar antes de despachar; después la solicitud ya no se puede editar', async () => {
    const id = await crearSolicitud(false);
    const cambiar = (interna: boolean | undefined) => llamar('PUT', `/api/solicitudes/${id}`, { cantidad_vehiculos: '1', ...(interna === undefined ? {} : { interna }) });
    expect((await cambiar(true)).status).toBe(200);
    expect((await solicitudEnDb(id)).interna).toBe(1);
    expect((await cambiar(false)).status).toBe(200);
    expect((await solicitudEnDb(id)).interna).toBe(0);
    expect((await cambiar(true)).status).toBe(200);
    // Un cliente que no envía el campo conserva el valor actual.
    expect((await cambiar(undefined)).status).toBe(200);
    expect((await solicitudEnDb(id)).interna).toBe(1);
    // El cambio queda en la bitácora con antes/después.
    const [regs] = await db().query<RowDataPacket[]>("SELECT detalle FROM auditoria WHERE accion = 'solicitud.actualizar' AND entidad_id = ? ORDER BY id ASC LIMIT 1", [String(id)]);
    expect(JSON.parse(String(regs[0]!.detalle)).cambios.interna).toMatchObject({ antes: 0, despues: 1 });

    // Despachada, la solicitud ya no es borrador: la regla de siempre impide editarla.
    await despachar(id);
    expect((await cambiar(false)).status).toBe(400);
    expect((await solicitudEnDb(id)).interna).toBe(1);
  });

  it('la marca sigue fija aunque la solicitud vuelva a borrador (anulado el despacho), en ambos sentidos', async () => {
    // Interna -> despachada -> anulada (vuelve a borrador): sigue interna.
    const interna = await crearSolicitud(true);
    await despachar(interna);
    const mi = await manifiestoDe(interna);
    expect((await llamar('POST', `/api/despachos/${mi.id}/anular`, { motivo: 'digitacion', observaciones: 'x' })).status).toBe(200);
    expect((await solicitudEnDb(interna)).estado).toBe('borrador');
    const r1 = await llamar('PUT', `/api/solicitudes/${interna}`, { cantidad_vehiculos: '1', interna: false });
    expect(r1.status).toBe(409);
    expect(((await r1.json()) as { error: string }).error).toMatch(/despach/i);
    expect((await solicitudEnDb(interna)).interna).toBe(1);
    // Guardarla con la marca igual sí se puede.
    expect((await llamar('PUT', `/api/solicitudes/${interna}`, { cantidad_vehiculos: '1', interna: true, observaciones: 'otra nota' })).status).toBe(200);

    // Oficial -> despachada -> (el RNDC anuló y liberó el cupo, simulado) borrador: no puede pasar a interna.
    const oficial = await crearSolicitud(false);
    await despachar(oficial);
    await db().query("UPDATE solicitud_servicio SET estado = 'borrador', cantidad_vehiculos = 1 WHERE id = ?", [oficial]);
    const r2 = await llamar('PUT', `/api/solicitudes/${oficial}`, { cantidad_vehiculos: '1', interna: true });
    expect(r2.status).toBe(409);
    expect((await solicitudEnDb(oficial)).interna).toBe(0);
  });

  it('la solicitud informa si es interna y si ya tiene despachos (para bloquear el campo en pantalla)', async () => {
    const id = await crearSolicitud(true);
    const antes = (await (await llamar('GET', `/api/solicitudes/${id}`)).json()) as { solicitud: { interna: number; tiene_despachos: boolean } };
    expect(antes.solicitud).toMatchObject({ interna: 1, tiene_despachos: false });
    await despachar(id);
    const despues = (await (await llamar('GET', `/api/solicitudes/${id}`)).json()) as { solicitud: { tiene_despachos: boolean } };
    expect(despues.solicitud.tiene_despachos).toBe(true);
  });

  it('un despacho interno no tiene cumplido ante el RNDC: se rechaza y no encola nada', async () => {
    const id = await crearSolicitud(true);
    await despachar(id);
    const m = await manifiestoDe(id);
    const [r] = await remesasDe(id);
    const res = await llamar('POST', `/api/cumplido/${m.id}`, { cumplido_tipo: 'C', remesas: [{ id: r!.id, cumplido_tipo: 'C', cantidad_entregada: 10 }] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/interno/i);
    expect(await filasCola(id)).toBe(0);
  });

  it('"Procesar" un despacho interno no envía nada', async () => {
    const id = await crearSolicitud(true);
    await despachar(id);
    const m = await manifiestoDe(id);
    const r = (await (await llamar('POST', `/api/despachos/${m.id}/procesar`)).json()) as { ok: boolean; mensaje: string };
    expect(r.ok).toBe(false);
    expect(r.mensaje).toMatch(/interno/i);
    expect(await filasCola(id)).toBe(0);
  });

  it('un despacho interno se puede editar y sigue interno, sin encolar', async () => {
    const id = await crearSolicitud(true);
    await despachar(id);
    const m = await manifiestoDe(id);
    const [rem] = await remesasDe(id);
    const r = await llamar('PUT', `/api/despachos/${m.id}`, {
      placa_vehiculo: 'TST123', conductor_tipo_id: 'C', conductor_num_id: '1', observaciones: 'editado',
      remesas: [{ id: rem!.id, descripcion_producto: 'Carga interna editada' }],
    });
    expect(((await r.json()) as { ok: boolean }).ok).toBe(true);
    expect((await manifiestoDe(id)).estado_rndc).toBe('interno');
    expect((await remesasDe(id))[0]).toMatchObject({ estado_rndc: 'interno', descripcion_producto: 'Carga interna editada' });
    expect(await filasCola(id)).toBe(0);
  });

  it('anular un despacho interno es local: libera el cupo del vehículo, queda en la bitácora y no encola nada', async () => {
    const id = await crearSolicitud(true);
    await despachar(id);
    expect(await solicitudEnDb(id)).toMatchObject({ cantidad_vehiculos: 0, estado: 'despachada' });
    const m = await manifiestoDe(id);

    const preview = (await (await llamar('GET', `/api/despachos/${m.id}/anular`)).json()) as { puedeAnular: boolean; pasos: { label: string }[] };
    expect(preview.puedeAnular).toBe(true);
    expect(preview.pasos.map((p) => p.label).join(' ')).toMatch(/interno/i);

    const body = { motivo: 'digitacion', observaciones: 'se despachó la solicitud equivocada' };
    const rs = await Promise.all([llamar('POST', `/api/despachos/${m.id}/anular`, body), llamar('POST', `/api/despachos/${m.id}/anular`, body)]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 400]); // exactamente una
    expect((await manifiestoDe(id)).estado_rndc).toBe('anulado');
    expect((await remesasDe(id))[0]!.estado_rndc).toBe('anulado');
    expect(await solicitudEnDb(id)).toMatchObject({ cantidad_vehiculos: 1, estado: 'borrador' });
    expect(await filasCola(id)).toBe(0);
    const [regs] = await db().query<RowDataPacket[]>("SELECT descripcion FROM auditoria WHERE accion = 'anulacion.despacho' AND entidad_id = ?", [String(m.id)]);
    expect(regs).toHaveLength(1);
    expect(String(regs[0]!.descripcion)).toMatch(/interno/i);

    // La marca sigue fija (ya tuvo un despacho) y se puede volver a despachar.
    expect((await llamar('PUT', `/api/solicitudes/${id}`, { cantidad_vehiculos: '1', interna: false })).status).toBe(409);
    expect((await despachar(id)).status).toBe(200);
    expect((await manifiestoDe(id)).estado_rndc).toBe('interno');
  });

  it('los despachos internos no inflan el contador de pendientes del menú', async () => {
    invalidate('badge:despachos');
    const antes = await cola.contarDespachosPendientes();
    const id = await crearSolicitud(true);
    await despachar(id);
    invalidate('badge:despachos');
    expect(await cola.contarDespachosPendientes()).toBe(antes);
  });

  it('el PDF del RNDC no existe para un despacho interno', async () => {
    const id = await crearSolicitud(true);
    await despachar(id);
    const m = await manifiestoDe(id);
    const r = await llamar('GET', `/api/manifiesto/${m.id}/pdf-rndc`);
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/interno/i);
  });

  it('el manifiesto y la remesa impresos de un despacho interno dicen que NO están radicados ante el RNDC; los oficiales no', async () => {
    const interna = await crearSolicitud(true);
    await despachar(interna);
    const mi = await manifiestoDe(interna);
    const oficial = await crearSolicitud(false);
    await despachar(oficial);
    const mo = await manifiestoDe(oficial);
    const html = async (ruta: string, id: number) => (await llamar('GET', `/api/${ruta}/${id}/pdf?format=html`)).text();
    for (const ruta of ['manifiesto', 'remesa']) {
      const interno = await html(ruta, Number(mi.id));
      expect(interno).toContain('DOCUMENTO INTERNO — NO RADICADO ANTE EL RNDC');
      expect(interno).not.toContain('width:22mm;height:22mm;'); // sin el QR de seguridad del RNDC (el logo de la empresa sí puede ir)
      expect(await html(ruta, Number(mo.id))).not.toContain('DOCUMENTO INTERNO');
    }
    // La remesa interna se muestra con su propio número, no como un consecutivo del RNDC.
    expect(await html('remesa', Number(mi.id))).toContain((await remesasDe(interna))[0]!.num_remesa);
  });

  it('el informe marca los despachos internos (columna Interna) y no los esconde', async () => {
    const id = await crearSolicitud(true);
    await despachar(id);
    const m = await manifiestoDe(id);
    const r = await llamar('GET', `/api/informe?q=${encodeURIComponent(String(m.num_manifiesto))}`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: Record<string, string>[]; columns: { key: string }[] };
    expect(body.columns.map((c) => c.key)).toContain('interna');
    const fila = body.items.find((i) => i.num_manifiesto === m.num_manifiesto);
    expect(fila).toBeDefined();
    expect(fila).toMatchObject({ interna: 'Sí', estado_manifiesto_rndc: 'interno' });
  });
});
