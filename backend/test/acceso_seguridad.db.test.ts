/**
 * Seguridad del login contra la ruta HTTP real y una base REAL de pruebas:
 * límites por IP y por cuenta, respuesta que no delata qué cuentas existen,
 * auditoría sin datos sensibles, cabeceras y /health mínimo.
 *   TEST_DB=1 DB_HOST=127.0.0.1 DB_NAME=tms_test DB_USER=... DB_PASS=... npx vitest run test/acceso_seguridad.db.test.ts
 * Sin TEST_DB=1 se omite. NUNCA apuntar a producción.
 */
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';

const RUN = process.env.TEST_DB === '1';
const { createApp } = await import('../src/app.js');
const { db } = await import('../src/db/pool.js');
const guard = await import('../src/modules/auth/accesoGuard.js');
const { signToken } = await import('../src/modules/auth/jwt.js');

const sufijo = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const correo = (n: string) => `${n}.${sufijo}@test.local`;
const claveReal = randomBytes(12).toString('base64url');
const ipsUsadas: string[] = [];
const ipUnica = () => {
  const ip = `2001:db8:${Math.floor(Math.random() * 65535).toString(16)}:${sufijo.slice(-4)}::1`;
  ipsUsadas.push(ip);
  return ip;
};

let server: Server;
let base = '';
let usuarioId = 0;

const login = (email: string, password: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ email, password }) });

describe.skipIf(!RUN)('seguridad del login', () => {
  beforeAll(async () => {
    server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const [u] = await db().query<ResultSetHeader>(
      "INSERT INTO staff_users (email, password_hash, nombre, rol, paginas, activo) VALUES (?, ?, 'Seg', 'operador', NULL, 1)",
      [correo('seg'), await bcrypt.hash(claveReal, 10)],
    );
    usuarioId = u.insertId;
  });

  afterAll(async () => {
    const hashes = ['seg', 'noexiste', 'otro'].map((n) => guard.hashIdentificador(correo(n)));
    await db().query('DELETE FROM auth_intentos WHERE identificador_hash IN (?) OR ip IN (?)', [hashes, ipsUsadas.length ? ipsUsadas : ['-']]);
    await db().query('DELETE FROM auth_auditoria WHERE identificador_hash IN (?) OR ip IN (?)', [hashes, ipsUsadas.length ? ipsUsadas : ['-']]);
    await db().query('DELETE FROM staff_users WHERE id = ?', [usuarioId]);
    await new Promise((r) => server.close(r));
    await db().end();
  });

  it('un correo que no existe tarda lo mismo que uno real (compara un hash de verdad, no responde al instante)', async () => {
    // Calentar (conexión a la base, primer bcrypt) para no medir el arranque en frío.
    await login(correo('noexiste'), 'x', { 'X-Forwarded-For': ipUnica() });
    const tiempos: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      expect((await login(correo('noexiste'), 'x', { 'X-Forwarded-For': ipUnica() })).status).toBe(401);
      tiempos.push(performance.now() - t0);
    }
    // Antes respondía en ~1-3 ms (hash mal formado); un bcrypt de costo 10 tarda decenas de ms.
    expect(Math.min(...tiempos)).toBeGreaterThan(30);
  });

  it('límite por IP: probar la misma IP en muchas cuentas la bloquea, aunque cada cuenta tenga pocos fallos', async () => {
    const ip = ipUnica();
    const lim = { ventanaMin: 15, ipTotal: 1_000, ipFallos: 3, cuentaFallos: 100 };
    for (let i = 0; i < 3; i++) expect((await guard.registrarIntento(ip, guard.hashIdentificador(`victima${i}@x.co`), lim)).bloqueo).toBeNull();
    expect((await guard.registrarIntento(ip, guard.hashIdentificador('victima9@x.co'), lim)).bloqueo).toBe('IP');
  });

  it('límite por IP: los ingresos BUENOS no cuentan como fallos (una oficina entra por una sola IP)', async () => {
    const ip = ipUnica();
    const lim = { ventanaMin: 15, ipTotal: 1_000, ipFallos: 3, cuentaFallos: 100 };
    for (let i = 0; i < 10; i++) {
      const r = await guard.registrarIntento(ip, guard.hashIdentificador(`empleado${i}@x.co`), lim);
      expect(r.bloqueo).toBeNull();
      await guard.marcarExito(r.id);
    }
  });

  it('el total de peticiones por IP también tiene tope', async () => {
    const ip = ipUnica();
    const lim = { ventanaMin: 15, ipTotal: 4, ipFallos: 1_000, cuentaFallos: 1_000 };
    for (let i = 0; i < 4; i++) {
      const r = await guard.registrarIntento(ip, null, lim);
      expect(r.bloqueo).toBeNull();
      await guard.marcarExito(r.id);
    }
    expect((await guard.registrarIntento(ip, null, lim)).bloqueo).toBe('IP');
  });

  it('la IP que se guarda es la del visitante (X-Forwarded-For del proxy), no la del proxy', async () => {
    const ip = ipUnica();
    await login(correo('otro'), 'x', { 'X-Forwarded-For': ip });
    const [rows] = await db().query<RowDataPacket[]>('SELECT ip FROM auth_auditoria WHERE ip = ?', [ip]);
    expect(rows.length).toBe(1);
  });

  it('la auditoría registra el resultado y NUNCA el correo, la contraseña ni el token', async () => {
    const ip = ipUnica();
    await login(correo('seg'), 'contraseña-equivocada-123', { 'X-Forwarded-For': ip });
    const ok = await login(correo('seg'), claveReal, { 'X-Forwarded-For': ip });
    expect(ok.status).toBe(200);
    const token = ((await ok.json()) as { token: string }).token;
    const [rows] = await db().query<RowDataPacket[]>('SELECT * FROM auth_auditoria WHERE ip = ? ORDER BY id', [ip]);
    expect(rows.map((r) => r.resultado)).toEqual(['CREDENCIALES', 'EXITO']);
    expect(rows[1]!.usuario_id).toBe(usuarioId);
    const volcado = JSON.stringify(rows) + JSON.stringify((await db().query('SELECT * FROM auth_intentos WHERE ip = ?', [ip]))[0]);
    for (const secreto of [correo('seg'), 'contraseña-equivocada-123', claveReal, token]) expect(volcado).not.toContain(secreto);
  });

  it('si falta la tabla nueva (v55 sin correr) el login sigue limitado por el sistema anterior, no se cae ni queda sin límite', async () => {
    const ip = ipUnica();
    await db().query('RENAME TABLE auth_intentos TO auth_intentos_apartada');
    try {
      const cabeceras = { 'X-Forwarded-For': ip };
      for (let i = 0; i < 5; i++) expect((await login(correo('otro'), 'x', cabeceras)).status).toBe(401);
      expect((await login(correo('otro'), 'x', cabeceras)).status).toBe(429);
    } finally {
      await db().query('RENAME TABLE auth_intentos_apartada TO auth_intentos');
      await db().query('DELETE FROM login_intentos WHERE email = ?', [correo('otro')]);
    }
  });

  it('cabeceras: Permissions-Policy siempre; HSTS solo cuando la conexión original era HTTPS; CSP solo reporta por defecto', async () => {
    const http = await fetch(`${base}/no-existe`);
    expect(http.headers.get('permissions-policy')).toContain('camera=()');
    expect(http.headers.get('strict-transport-security')).toBeNull();
    expect(http.headers.get('content-security-policy-report-only')).toContain("default-src 'self'");
    // (Sin frontend compilado, el 404 de Express trae su propia CSP "default-src 'none'"; lo que importa es que NO sea la política de la app aplicada.)
    expect(http.headers.get('content-security-policy') ?? '').not.toContain('script-src');
    const https = await fetch(`${base}/no-existe`, { headers: { 'X-Forwarded-Proto': 'https' } });
    expect(https.headers.get('strict-transport-security')).toMatch(/max-age=\d+/);
    // La API no lleva CSP (es JSON).
    expect((await fetch(`${base}/api/health`)).headers.get('content-security-policy-report-only')).toBeNull();
  });

  it('/api/health público solo dice si está vivo; el ambiente del RNDC solo se ve con sesión', async () => {
    const h = (await (await fetch(`${base}/api/health`)).json()) as Record<string, unknown>;
    expect(Object.keys(h).sort()).toEqual(['database', 'ok']);
    expect((await fetch(`${base}/api/estado`)).status).toBe(401);
    const token = signToken({ sub: usuarioId, email: correo('seg'), nombre: 'Seg', rol: 'operador', paginas: null });
    const e = (await (await fetch(`${base}/api/estado`, { headers: { Authorization: `Bearer ${token}` } })).json()) as { rndc: { ambiente: string } };
    expect(e.rndc.ambiente).toBeTruthy();
  });
});
