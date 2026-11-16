/**
 * El correo de la cuenta protegida (propietario) se oculta a los demás administradores en Usuarios y en Actividad.
 *   TEST_DB=1 DB_HOST=... DB_NAME=... DB_USER=... DB_PASS=... npx vitest run test/correo_propietario.db.test.ts
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResultSetHeader } from 'mysql2';

const RUN = process.env.TEST_DB === '1';
process.env.SITE_ID = 'sitio-test-correo';
process.env.PLATFORM_OWNER_UUID = randomUUID();

const { createApp } = await import('../src/app.js');
const { db } = await import('../src/db/pool.js');
const { signToken } = await import('../src/modules/auth/jwt.js');
const { sinCorreoProtegido } = await import('../src/modules/auditoria/auditoria.repo.js');

const sufijo = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const ids: Record<string, number> = {}; const tokens: Record<string, string> = {}; const correos: Record<string, string> = {};
let server: Server; let base = ''; let ipN = 0;
async function crear(nombre: string, rol: 'admin' | 'operador', uuid?: string) {
  const email = `co.${nombre}.${sufijo}@test.local`; const hash = await bcrypt.hash(randomBytes(6).toString('hex'), 4);
  const [r] = await db().query<ResultSetHeader>(uuid ? 'INSERT INTO staff_users (uuid, email, password_hash, nombre, rol, paginas, activo) VALUES (?,?,?,?,?,NULL,1)' : 'INSERT INTO staff_users (email, password_hash, nombre, rol, paginas, activo) VALUES (?,?,?,?,NULL,1)', uuid ? [uuid, email, hash, nombre, rol] : [email, hash, nombre, rol]);
  ids[nombre] = r.insertId; correos[nombre] = email; tokens[nombre] = signToken({ sub: r.insertId, email, nombre, rol, paginas: null, sv: 0 });
}
const get = (quien: string, ruta: string) => fetch(`${base}${ruta}`, { headers: { Authorization: `Bearer ${tokens[quien]}`, 'X-Forwarded-For': `2001:db8:c0e0::${++ipN}` } });

describe('sinCorreoProtegido (unidad)', () => {
  it('quita el correo sin distinguir mayúsculas, en texto y en objetos, sin tratarlo como expresión regular', () => {
    expect(sinCorreoProtegido('Cambió a A.B@x.com ok', 'a.b@x.com')).toBe('Cambió a Cuenta protegida ok');
    expect(sinCorreoProtegido('axb@x.com', 'a.b@x.com')).toBe('axb@x.com');
    expect(sinCorreoProtegido({ a: ['a.b@x.com'] }, 'a.b@x.com')).toEqual({ a: ['Cuenta protegida'] });
    expect(sinCorreoProtegido('igual', '')).toBe('igual');
  });
});

describe.skipIf(!RUN)('correo del propietario oculto a los demás', () => {
  const marca = `marca-${randomBytes(4).toString('hex')}`;
  beforeAll(async () => {
    server = createApp().listen(0); await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await crear('dueno', 'admin', process.env.PLATFORM_OWNER_UUID); await crear('admin', 'admin');
    await db().query('INSERT INTO auditoria (usuario_id, usuario_email, ip, accion, entidad, entidad_id, descripcion, detalle) VALUES (?,?,?,?,?,?,?,?)',
      [ids.dueno, correos.dueno, '127.0.0.1', 'usuario.actualizar', 'usuario', '1', `${marca} cambio de ${correos.dueno}`, JSON.stringify({ email: correos.dueno })]);
  });
  afterAll(async () => {
    await db().query('DELETE FROM auditoria WHERE descripcion LIKE ?', [`${marca}%`]);
    await db().query('DELETE FROM staff_users WHERE id IN (?)', [Object.values(ids)]);
    await new Promise((r) => server.close(r)); await db().end();
  });

  it('Usuarios: otro administrador ve la cuenta protegida sin correo; las demás cuentas, normales', async () => {
    const j = (await (await get('admin', '/api/usuarios')).json()) as { items?: any[] } | any[];
    const lista = (Array.isArray(j) ? j : j.items ?? []) as { id: number; email: string; correoOculto?: boolean; protegido?: boolean }[];
    const dueno = lista.find((u) => u.id === ids.dueno)!; const otro = lista.find((u) => u.id === ids.admin)!;
    expect(dueno.protegido).toBe(true); expect(dueno.correoOculto).toBe(true); expect(dueno.email).toBe('');
    expect(otro.email).toBe(correos.admin); expect(otro.correoOculto).toBeUndefined();
    const uno = (await (await get('admin', `/api/usuarios/${ids.dueno}`)).text());
    expect(uno).not.toContain(correos.dueno);
  });

  it('Usuarios: el propietario ve su propio correo', async () => {
    const j = (await (await get('dueno', '/api/usuarios')).json()) as any;
    const lista = (Array.isArray(j) ? j : j.items) as { id: number; email: string }[];
    expect(lista.find((u) => u.id === ids.dueno)!.email).toBe(correos.dueno);
  });

  it('Actividad: otro administrador no ve el correo del propietario (ni en filas, descripción, detalle), ni puede buscarlo', async () => {
    const t = await (await get('admin', `/api/auditoria?pageSize=200&q=${marca}`)).text();
    expect(t).toContain(marca); expect(t).not.toContain(correos.dueno);
    const adivinar = (await (await get('admin', `/api/auditoria?pageSize=200&q=${encodeURIComponent(correos.dueno)}`)).json()) as { items: unknown[] };
    expect(adivinar.items).toHaveLength(0);
  });

  it('Actividad: el propietario sí ve su correo', async () => {
    const t = await (await get('dueno', `/api/auditoria?pageSize=200&q=${marca}`)).text();
    expect(t).toContain(correos.dueno);
  });
});
