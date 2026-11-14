/**
 * Hallazgo #9 (blindaje transaccional): ingreso y sesiones.
 * - Fuerza bruta: tras 5 fallos en 15 min para un correo, el login responde 429.
 * - Desactivar a un usuario o quitarle el rol de admin surte efecto de
 *   inmediato, sin esperar a que venza su token.
 * - La API responde con Cache-Control: no-store y cabeceras de seguridad.
 *
 * Ruta HTTP real contra una base MySQL/MariaDB REAL de pruebas (crea y borra
 * usuarios y registros de login_intentos):
 *   TEST_DB=1 DB_HOST=127.0.0.1 DB_NAME=tms_test DB_USER=... DB_PASS=... npx vitest run test/auth_blindaje.db.test.ts
 * Sin TEST_DB=1 se omite. NUNCA apuntar a producción.
 */

import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResultSetHeader } from 'mysql2';

const RUN = process.env.TEST_DB === '1';

const { createApp } = await import('../src/app.js');
const { db } = await import('../src/db/pool.js');

const sufijo = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const correo = (n: string) => `${n}.${sufijo}@test.local`;
const randomPassword = () => randomBytes(12).toString('base64url');

let server: Server;
let base = '';
const usuarios: number[] = [];

async function crearUsuario(nombre: string, rol: 'admin' | 'operador', password: string): Promise<number> {
  const [res] = await db().query<ResultSetHeader>(
    'INSERT INTO staff_users (email, password_hash, nombre, rol, paginas, activo) VALUES (?, ?, ?, ?, NULL, 1)',
    [correo(nombre), await bcrypt.hash(password, 4), nombre, rol],
  );
  usuarios.push(res.insertId);
  return res.insertId;
}

const login = (email: string, password: string) =>
  fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

async function token(email: string, password: string): Promise<string> {
  const r = await login(email, password);
  expect(r.status).toBe(200);
  return ((await r.json()) as { token: string }).token;
}

const get = (path: string, tk: string) => fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${tk}` } });

describe.skipIf(!RUN)('ingreso y sesiones', () => {
  beforeAll(async () => {
    server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await db().query('DELETE FROM login_intentos WHERE email LIKE ?', [`%.${sufijo}@test.local`]);
    const { hashIdentificador } = await import('../src/modules/auth/accesoGuard.js');
    const hashes = ['bruta', 'rafaga', 'noexiste', 'reinicio', 'adminA', 'adminB', 'desact'].map((n) => hashIdentificador(correo(n)));
    await db().query('DELETE FROM auth_intentos WHERE identificador_hash IN (?)', [hashes]);
    await db().query('DELETE FROM auth_auditoria WHERE identificador_hash IN (?)', [hashes]);
    if (usuarios.length) await db().query('DELETE FROM staff_users WHERE id IN (?)', [usuarios]);
    await new Promise((r) => server.close(r));
    await db().end();
  });

  it('tras 5 contraseñas incorrectas, el 6.º intento responde 429 aunque la contraseña sea la correcta', async () => {
    const pass = randomPassword();
    await crearUsuario('bruta', 'operador', pass);
    for (let i = 0; i < 5; i++) expect((await login(correo('bruta'), 'incorrecta')).status).toBe(401);
    const r = await login(correo('bruta'), pass);
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('10 intentos fallidos simultáneos no esquivan el límite', async () => {
    const pass = randomPassword();
    await crearUsuario('rafaga', 'operador', pass);
    const rs = await Promise.all(Array.from({ length: 10 }, () => login(correo('rafaga'), 'incorrecta')));
    expect(rs.filter((r) => r.status === 401).length).toBeLessThanOrEqual(5);
    expect((await login(correo('rafaga'), pass)).status).toBe(429);
  });

  it('un correo que no existe se bloquea igual (no revela qué cuentas existen)', async () => {
    for (let i = 0; i < 5; i++) expect((await login(correo('noexiste'), 'x')).status).toBe(401);
    expect((await login(correo('noexiste'), 'x')).status).toBe(429);
  });

  it('un ingreso exitoso reinicia el conteo de fallos', async () => {
    const pass = randomPassword();
    await crearUsuario('reinicio', 'operador', pass);
    for (let i = 0; i < 4; i++) await login(correo('reinicio'), 'incorrecta');
    expect((await login(correo('reinicio'), pass)).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await login(correo('reinicio'), 'incorrecta')).status).toBe(401);
    expect((await login(correo('reinicio'), pass)).status).toBe(200);
  });

  it('desactivar a un usuario corta su sesión de inmediato', async () => {
    const passAdmin = randomPassword();
    const passOp = randomPassword();
    await crearUsuario('admin1', 'admin', passAdmin);
    const opId = await crearUsuario('desactivado', 'operador', passOp);
    const tkAdmin = await token(correo('admin1'), passAdmin);
    const tkOp = await token(correo('desactivado'), passOp);
    expect((await get('/api/solicitudes', tkOp)).status).toBe(200);

    const r = await fetch(`${base}/api/usuarios/${opId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tkAdmin}` },
      body: JSON.stringify({ email: correo('desactivado'), nombre: 'desactivado', rol: 'operador', paginas: null, activo: false }),
    });
    expect(r.status).toBe(200);
    expect((await get('/api/solicitudes', tkOp)).status).toBe(401);
  });

  it('quitarle el rol de admin a alguien le quita los permisos de admin sin esperar a que venza el token', async () => {
    const passA = randomPassword();
    const passB = randomPassword();
    await crearUsuario('adminA', 'admin', passA);
    const bId = await crearUsuario('adminB', 'admin', passB);
    const tkA = await token(correo('adminA'), passA);
    const tkB = await token(correo('adminB'), passB);
    expect((await get('/api/usuarios', tkB)).status).toBe(200);

    await fetch(`${base}/api/usuarios/${bId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tkA}` },
      body: JSON.stringify({ email: correo('adminB'), nombre: 'adminB', rol: 'operador', paginas: null, activo: true }),
    });
    expect((await get('/api/usuarios', tkB)).status).toBe(403);
  });

  it('la API responde con Cache-Control: no-store y cabeceras de seguridad', async () => {
    const r = await fetch(`${base}/api/health`);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(r.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  });
});
