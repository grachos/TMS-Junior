/**
 * La actividad de soporte (incidentes, perfil/sesiones del propietario) la ve SOLO el propietario en la pantalla Actividad.
 *   TEST_DB=1 DB_HOST=... DB_NAME=... DB_USER=... DB_PASS=... npx vitest run test/auditoria_soporte.db.test.ts
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResultSetHeader } from 'mysql2';

const RUN = process.env.TEST_DB === '1';
process.env.SITE_ID = 'sitio-test-audit';
process.env.PLATFORM_OWNER_UUID = randomUUID();

const { createApp } = await import('../src/app.js');
const { db } = await import('../src/db/pool.js');
const { signToken } = await import('../src/modules/auth/jwt.js');

const sufijo = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const ids: Record<string, number> = {}; const tokens: Record<string, string> = {};
let server: Server; let base = ''; let ipN = 0;
async function crear(nombre: string, rol: 'admin' | 'operador', uuid?: string) {
  const email = `au.${nombre}.${sufijo}@test.local`; const hash = await bcrypt.hash(randomBytes(6).toString('hex'), 4);
  const [r] = await db().query<ResultSetHeader>(uuid ? 'INSERT INTO staff_users (uuid, email, password_hash, nombre, rol, paginas, activo) VALUES (?,?,?,?,?,NULL,1)' : 'INSERT INTO staff_users (email, password_hash, nombre, rol, paginas, activo) VALUES (?,?,?,?,NULL,1)', uuid ? [uuid, email, hash, nombre, rol] : [email, hash, nombre, rol]);
  ids[nombre] = r.insertId; tokens[nombre] = signToken({ sub: r.insertId, email, nombre, rol, paginas: null, sv: 0 });
}
const ver = (quien: string, qs = '') => fetch(`${base}/api/auditoria?pageSize=200${qs}`, { headers: { Authorization: `Bearer ${tokens[quien]}`, 'X-Forwarded-For': `2001:db8:a0d1::${++ipN}` } });

describe.skipIf(!RUN)('actividad de soporte solo para el propietario', () => {
  const marca = `marca-${randomBytes(4).toString('hex')}`;
  beforeAll(async () => {
    server = createApp().listen(0); await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await crear('dueno', 'admin', process.env.PLATFORM_OWNER_UUID); await crear('admin', 'admin');
    for (const [accion, entidad] of [['incidente.actualizar', 'incidente'], ['incidente.diagnostico_aplicado', 'incidente'], ['propietario.perfil', 'usuario'], ['incidente.issue_creado', 'incidente'], ['usuario.actualizar', 'usuario']]) {
      await db().query('INSERT INTO auditoria (usuario_id, usuario_email, ip, accion, entidad, entidad_id, descripcion, detalle) VALUES (?,?,?,?,?,?,?,?)', [ids.dueno, 'x@test.local', '127.0.0.1', accion, entidad, '1', `${marca} ${accion}`, '{}']);
    }
  });
  afterAll(async () => {
    await db().query('DELETE FROM auditoria WHERE descripcion LIKE ?', [`${marca}%`]);
    await db().query('DELETE FROM staff_users WHERE id IN (?)', [Object.values(ids)]);
    await new Promise((r) => server.close(r)); await db().end();
  });

  it('un administrador que NO es el propietario no ve nada de soporte (ni en la lista, ni en el filtro de acciones, ni filtrando por ellas)', async () => {
    const r = await ver('admin', `&q=${marca}`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { items: { accion: string }[]; total: number; acciones: string[] };
    expect(j.items.map((i) => i.accion)).toEqual(['usuario.actualizar']);
    expect(j.total).toBe(1);
    expect(j.acciones.filter((a) => a.startsWith('incidente.') || a.startsWith('propietario.'))).toEqual([]);
    const f = (await (await ver('admin', '&accion=incidente.actualizar')).json()) as { items: unknown[]; total: number };
    expect(f.items).toHaveLength(0); expect(f.total).toBe(0);
    const e = (await (await ver('admin', '&entidad=incidente')).json()) as { items: unknown[] };
    expect(e.items).toHaveLength(0);
  });

  it('el propietario sí lo ve todo', async () => {
    const j = (await (await ver('dueno', `&q=${marca}`)).json()) as { items: { accion: string }[]; acciones: string[] };
    expect(j.items.map((i) => i.accion).sort()).toEqual(['incidente.actualizar', 'incidente.diagnostico_aplicado', 'incidente.issue_creado', 'propietario.perfil', 'usuario.actualizar']);
    expect(j.acciones).toContain('incidente.actualizar');
  });
});
