/**
 * Recuperar contraseña con Turnstile activo: sin reto no se manda correo ni se cambia nada, y cada
 * formulario exige SU acción (un reto de "login" no vale aquí).
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ResultSetHeader } from 'mysql2';

const RUN = process.env.TEST_DB === '1';
process.env.TURNSTILE_ENFORCE = 'true';
process.env.TURNSTILE_SITE_KEY = '0xSITIO';
process.env.TURNSTILE_SECRET_KEY = 'secreto';
process.env.APP_URL = 'https://konekto.prueba.test';

const enviados: { para: string; texto: string }[] = [];
vi.mock('../src/modules/auth/correo.js', () => ({ enviarCorreo: async (c: { para: string; texto: string }) => { enviados.push(c); return true; } }));
const acciones: string[] = [];
vi.mock('../src/modules/auth/turnstile.js', async (original) => {
  const real = await original<typeof import('../src/modules/auth/turnstile.js')>();
  return {
    ...real,
    verifyTurnstile: async (token: unknown, accion: string) => {
      acciones.push(accion);
      // El reto solo vale para la acción para la que se pidió, como hace Cloudflare.
      return typeof token === 'string' && token === `RETO-${accion}` ? { ok: true, hostname: 'x', action: accion } : { ok: false, code: 'CAPTCHA-03', reason: 'x', errorCodes: [] };
    },
  };
});

const { createApp } = await import('../src/app.js');
const { db } = await import('../src/db/pool.js');
const { hashIdentificador } = await import('../src/modules/auth/accesoGuard.js');

const sufijo = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const email = `cap.rec.${sufijo}@test.local`;
let server: Server; let base = ''; let id = 0; let n = 0;
const ip = () => `2001:db8:feed:${sufijo.slice(-4)}::${++n}`;
const post = (path: string, body: unknown) =>
  fetch(`${base}/api/auth/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip() }, body: JSON.stringify(body) });

describe.skipIf(!RUN)('recuperar contraseña con Turnstile', () => {
  beforeAll(async () => {
    server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const [u] = await db().query<ResultSetHeader>("INSERT INTO staff_users (email, password_hash, nombre, rol, paginas, activo) VALUES (?, ?, 'Cap', 'operador', NULL, 1)", [email, await bcrypt.hash('clave-vieja-123', 4)]);
    id = u.insertId;
  });
  afterAll(async () => {
    await db().query('DELETE FROM password_resets WHERE usuario_id = ?', [id]);
    await db().query('DELETE FROM recuperacion_solicitudes WHERE email_hash = ? OR ip LIKE ?', [hashIdentificador(email), `2001:db8:feed:${sufijo.slice(-4)}%`]);
    await db().query('DELETE FROM auth_auditoria WHERE ip LIKE ? OR usuario_id = ?', [`2001:db8:feed:${sufijo.slice(-4)}%`, id]);
    await db().query('DELETE FROM staff_users WHERE id = ?', [id]);
    await new Promise((r) => server.close(r));
    await db().end();
  });

  it('sin reto, o con el reto de OTRO formulario, no se manda correo (403)', async () => {
    expect((await post('forgot-password', { email })).status).toBe(403);
    expect((await post('forgot-password', { email, 'cf-turnstile-response': 'RETO-login' })).status).toBe(403);
    await new Promise((r) => setTimeout(r, 80));
    expect(enviados).toHaveLength(0);
  });

  it('con el reto correcto se manda el correo; y para restablecer se exige el reto de "reset_password"', async () => {
    expect((await post('forgot-password', { email, 'cf-turnstile-response': 'RETO-forgot_password' })).status).toBe(204);
    await new Promise((r) => setTimeout(r, 100));
    expect(enviados).toHaveLength(1);
    const token = /token=([\w-]+)/.exec(enviados[0]!.texto)![1]!;
    expect((await post('reset-password', { token, password: 'clave-nueva-123' })).status).toBe(403);
    expect((await post('reset-password', { token, password: 'clave-nueva-123', 'cf-turnstile-response': 'RETO-forgot_password' })).status).toBe(403);
    expect((await post('reset-password', { token, password: 'clave-nueva-123', 'cf-turnstile-response': 'RETO-reset_password' })).status).toBe(204);
    expect(acciones).toContain('forgot_password');
    expect(acciones).toContain('reset_password');
  });
});
