/**
 * Login con Turnstile activo (TURNSTILE_ENFORCE=true), contra la ruta HTTP real y una base REAL.
 * Cloudflare se simula (vi.mock): no hay red.
 *   TEST_DB=1 DB_HOST=127.0.0.1 DB_NAME=tms_test DB_USER=... DB_PASS=... npx vitest run test/login_captcha.db.test.ts
 */
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';

const RUN = process.env.TEST_DB === '1';
process.env.TURNSTILE_ENFORCE = 'true';
process.env.TURNSTILE_SITE_KEY = '0xSITIO_PUBLICO';
process.env.TURNSTILE_SECRET_KEY = 'secreto-que-nunca-debe-salir';

const llamadas: { token: unknown; accion: string }[] = [];
vi.mock('../src/modules/auth/turnstile.js', async (original) => {
  const real = await original<typeof import('../src/modules/auth/turnstile.js')>();
  return {
    ...real,
    verifyTurnstile: async (token: unknown, accion: string) => {
      llamadas.push({ token, accion });
      return token === 'RETO-BUENO' ? { ok: true, hostname: 'x', action: accion } : { ok: false, code: 'CAPTCHA-03', reason: 'simulado', errorCodes: ['timeout-or-duplicate'] };
    },
  };
});

const { createApp } = await import('../src/app.js');
const { db } = await import('../src/db/pool.js');
const { hashIdentificador } = await import('../src/modules/auth/accesoGuard.js');

const sufijo = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const correo = `captcha.${sufijo}@test.local`;
const clave = randomBytes(12).toString('base64url');
let server: Server;
let base = '';
let usuarioId = 0;

const login = (cuerpo: Record<string, unknown>, ip = `2001:db8:cafe:${sufijo.slice(-4)}::1`) =>
  fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify(cuerpo) });

describe.skipIf(!RUN)('login con Turnstile', () => {
  beforeAll(async () => {
    server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const [u] = await db().query<ResultSetHeader>(
      "INSERT INTO staff_users (email, password_hash, nombre, rol, paginas, activo) VALUES (?, ?, 'Cap', 'operador', NULL, 1)",
      [correo, await bcrypt.hash(clave, 4)],
    );
    usuarioId = u.insertId;
  });

  afterAll(async () => {
    const h = hashIdentificador(correo);
    await db().query('DELETE FROM auth_intentos WHERE identificador_hash = ? OR ip LIKE ?', [h, `2001:db8:cafe:${sufijo.slice(-4)}%`]);
    await db().query('DELETE FROM auth_auditoria WHERE identificador_hash = ? OR ip LIKE ?', [h, `2001:db8:cafe:${sufijo.slice(-4)}%`]);
    await db().query('DELETE FROM staff_users WHERE id = ?', [usuarioId]);
    await new Promise((r) => server.close(r));
    await db().end();
  });

  it('la configuración pública trae la clave del sitio y NUNCA la secreta', async () => {
    const texto = await (await fetch(`${base}/api/auth/captcha-config`)).text();
    expect(JSON.parse(texto)).toEqual({ enforce: true, siteKey: '0xSITIO_PUBLICO' });
    expect(texto).not.toContain('secreto');
  });

  it('sin reto, con reto malo o con la contraseña correcta pero sin reto: 403 y NO inicia sesión', async () => {
    for (const cuerpo of [{ email: correo, password: clave }, { email: correo, password: clave, 'cf-turnstile-response': 'MALO' }]) {
      const r = await login(cuerpo);
      expect(r.status).toBe(403);
      const j = (await r.json()) as { error: string; token?: string };
      expect(j.token).toBeUndefined();
      expect(j.error).toMatch(/verificaci|origen/i);
      expect(j.error).not.toMatch(/timeout|duplicate|simulado/); // el motivo interno no se filtra
    }
    expect(llamadas.every((l) => l.accion === 'login')).toBe(true);
  });

  it('con el reto superado y la contraseña correcta inicia sesión', async () => {
    const r = await login({ email: correo, password: clave, 'cf-turnstile-response': 'RETO-BUENO' });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { token: string }).token).toBeTruthy();
  });

  it('con el reto superado pero contraseña incorrecta sigue siendo 401', async () => {
    expect((await login({ email: correo, password: 'incorrecta', 'cf-turnstile-response': 'RETO-BUENO' })).status).toBe(401);
  });

  it('un bot que falla el reto muchas veces NO puede bloquear la cuenta de otra persona', async () => {
    for (let i = 0; i < 12; i++) expect((await login({ email: correo, password: 'x', 'cf-turnstile-response': 'MALO' }, `2001:db8:cafe:${sufijo.slice(-4)}::${i + 10}`)).status).toBe(403);
    const r = await login({ email: correo, password: clave, 'cf-turnstile-response': 'RETO-BUENO' }, `2001:db8:cafe:${sufijo.slice(-4)}::99`);
    expect(r.status).toBe(200);
  });

  it('los retos fallidos quedan en la auditoría como CAPTCHA_FALLIDO y los intentos cuentan contra la IP', async () => {
    const ip = `2001:db8:cafe:${sufijo.slice(-4)}::aa`;
    await login({ email: correo, password: 'x' }, ip);
    const [a] = await db().query<RowDataPacket[]>('SELECT resultado FROM auth_auditoria WHERE ip = ?', [ip]);
    expect(a.map((r) => r.resultado)).toEqual(['CAPTCHA_FALLIDO']);
    const [i] = await db().query<RowDataPacket[]>('SELECT identificador_hash FROM auth_intentos WHERE ip = ?', [ip]);
    expect(i).toHaveLength(1);
    expect(i[0]!.identificador_hash).toBeNull();
  });
});
