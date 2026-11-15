/**
 * Recuperar la contraseña por correo, contra la ruta HTTP real y una base REAL. El envío de correo se
 * simula (vi.mock): se captura lo que se habría mandado.
 *   TEST_DB=1 DB_HOST=127.0.0.1 DB_NAME=tms_test DB_USER=... DB_PASS=... npx vitest run test/recuperacion.db.test.ts
 */
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';

const RUN = process.env.TEST_DB === '1';
process.env.APP_URL = 'https://konekto.prueba.test/';

const enviados: { para: string; asunto: string; texto: string; html: string }[] = [];
let demoraCorreoMs = 0;
vi.mock('../src/modules/auth/correo.js', () => ({
  enviarCorreo: async (c: { para: string; asunto: string; texto: string; html: string }) => {
    if (demoraCorreoMs) await new Promise((r) => setTimeout(r, demoraCorreoMs));
    enviados.push(c);
    return true;
  },
}));

const { createApp } = await import('../src/app.js');
const { db } = await import('../src/db/pool.js');
const { hashIdentificador } = await import('../src/modules/auth/accesoGuard.js');

const sufijo = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const correo = (n: string) => `rec.${n}.${sufijo}@test.local`;
const nuevaClave = () => randomBytes(10).toString('base64url');
const ips: string[] = [];
const ipUnica = () => { const ip = `2001:db8:beef:${sufijo.slice(-4)}::${ips.length + 1}`; ips.push(ip); return ip; };
const usuarios: number[] = [];

let server: Server;
let base = '';

const post = (path: string, body: unknown, ip = ipUnica()) =>
  fetch(`${base}/api/auth/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify(body) });
const olvide = (email: string, ip?: string) => post('forgot-password', { email }, ip);
const login = (email: string, password: string) => post('login', { email, password });
const tokenDe = (c: { texto: string }) => /token=([\w-]+)/.exec(c.texto)![1]!;

const creados = new Map<string, number>();
/** Crea la cuenta (o, si ya existe en esta corrida, la deja como nueva: contraseña, activa y sin enlaces previos). */
async function crear(nombre: string, clave: string, activo = 1): Promise<number> {
  const hash = await bcrypt.hash(clave, 4);
  const previo = creados.get(nombre);
  if (previo) {
    await db().query('UPDATE staff_users SET password_hash = ?, activo = ? WHERE id = ?', [hash, activo, previo]);
    await db().query('DELETE FROM password_resets WHERE usuario_id = ?', [previo]);
    await db().query('DELETE FROM recuperacion_solicitudes WHERE email_hash = ?', [hashIdentificador(correo(nombre))]);
    return previo;
  }
  const [r] = await db().query<ResultSetHeader>(
    "INSERT INTO staff_users (email, password_hash, nombre, rol, paginas, activo) VALUES (?, ?, ?, 'operador', NULL, ?)",
    [correo(nombre), hash, nombre, activo]);
  usuarios.push(r.insertId);
  creados.set(nombre, r.insertId);
  return r.insertId;
}

describe.skipIf(!RUN)('recuperar contraseña por correo', () => {
  beforeAll(async () => {
    server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  beforeEach(() => { enviados.length = 0; demoraCorreoMs = 0; });

  afterAll(async () => {
    const hashes = ['ana', 'inactivo', 'fantasma', 'rapida', 'lim', 'bloq', 'conc', 'venc', 'corta', 'dos'].map((n) => hashIdentificador(correo(n)));
    await db().query('DELETE FROM recuperacion_solicitudes WHERE email_hash IN (?) OR ip LIKE ?', [hashes, `2001:db8:beef:${sufijo.slice(-4)}%`]);
    await db().query('DELETE FROM auth_intentos WHERE identificador_hash IN (?)', [hashes]);
    await db().query('DELETE FROM auth_auditoria WHERE ip LIKE ? OR identificador_hash IN (?)', [`2001:db8:beef:${sufijo.slice(-4)}%`, hashes]);
    if (usuarios.length) {
      await db().query('DELETE FROM password_resets WHERE usuario_id IN (?)', [usuarios]);
      await db().query('DELETE FROM auth_auditoria WHERE usuario_id IN (?)', [usuarios]);
      await db().query('DELETE FROM staff_users WHERE id IN (?)', [usuarios]);
    }
    await new Promise((r) => server.close(r));
    await db().end();
  });

  it('responde 204 igual exista, no exista o esté inactiva la cuenta, y solo manda correo a una cuenta activa', async () => {
    await crear('ana', nuevaClave());
    await crear('inactivo', nuevaClave(), 0);
    const rs = await Promise.all([olvide(correo('ana')), olvide(correo('inactivo')), olvide(correo('fantasma'))]);
    expect(rs.map((r) => r.status)).toEqual([204, 204, 204]);
    expect(await Promise.all(rs.map((r) => r.text()))).toEqual(['', '', '']);
    await new Promise((r) => setTimeout(r, 100));
    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.para).toBe(correo('ana'));
  });

  it('el enlace usa APP_URL (no el Host de la petición) y el token NO queda guardado, solo su hash', async () => {
    await crear('ana', nuevaClave());
    await fetch(`${base}/api/auth/forgot-password`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ipUnica(), 'X-Forwarded-Host': 'sitio-malo.com' },
      body: JSON.stringify({ email: correo('ana') }),
    });
    await new Promise((r) => setTimeout(r, 100));
    const c = enviados.at(-1)!;
    expect(c.texto).toContain('https://konekto.prueba.test/restablecer?token=');
    expect(c.texto + c.html).not.toContain('sitio-malo.com');
    const token = tokenDe(c);
    const [filas] = await db().query<RowDataPacket[]>('SELECT token_hash FROM password_resets WHERE token_hash = ? OR token_hash = ?', [token, 'x']);
    expect(filas).toHaveLength(0); // el token en claro no está en la base
    const [h] = await db().query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM password_resets WHERE usuario_id IN (?) AND CHAR_LENGTH(token_hash) = 64', [usuarios]);
    expect(Number(h[0]!.n)).toBeGreaterThan(0);
  });

  it('con el enlace se cambia la contraseña: la nueva entra, la vieja no, y el enlace no se puede reusar', async () => {
    const vieja = nuevaClave(); const nueva = nuevaClave();
    await crear('dos', vieja);
    await olvide(correo('dos'));
    await new Promise((r) => setTimeout(r, 100));
    const token = tokenDe(enviados.at(-1)!);
    expect((await post('reset-password', { token, password: nueva })).status).toBe(204);
    expect((await login(correo('dos'), nueva)).status).toBe(200);
    expect((await login(correo('dos'), vieja)).status).toBe(401);
    const otra = await post('reset-password', { token, password: nuevaClave() });
    expect(otra.status).toBe(400);
    expect(((await otra.json()) as { error: string }).error).toMatch(/enlace/i);
    expect((await login(correo('dos'), nueva)).status).toBe(200); // la otra contraseña NO se aplicó
  });

  it('5 clics simultáneos sobre el mismo enlace: solo uno cambia la contraseña', async () => {
    await crear('conc', nuevaClave());
    await olvide(correo('conc'));
    await new Promise((r) => setTimeout(r, 100));
    const token = tokenDe(enviados.at(-1)!);
    const rs = await Promise.all(Array.from({ length: 5 }, () => post('reset-password', { token, password: nuevaClave() })));
    expect(rs.filter((r) => r.status === 204)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 400)).toHaveLength(4);
  });

  it('un enlace vencido no sirve', async () => {
    const id = await crear('venc', nuevaClave());
    await olvide(correo('venc'));
    await new Promise((r) => setTimeout(r, 100));
    await db().query('UPDATE password_resets SET expira_en = NOW() - INTERVAL 1 MINUTE WHERE usuario_id = ?', [id]);
    expect((await post('reset-password', { token: tokenDe(enviados.at(-1)!), password: nuevaClave() })).status).toBe(400);
  });

  it('una solicitud nueva invalida el enlace anterior', async () => {
    await crear('rapida', nuevaClave());
    await olvide(correo('rapida')); await olvide(correo('rapida'));
    await new Promise((r) => setTimeout(r, 150));
    expect(enviados).toHaveLength(2);
    expect((await post('reset-password', { token: tokenDe(enviados[0]!), password: nuevaClave() })).status).toBe(400);
    expect((await post('reset-password', { token: tokenDe(enviados[1]!), password: nuevaClave() })).status).toBe(204);
  });

  it('una contraseña corta se rechaza y NO gasta el enlace', async () => {
    await crear('corta', nuevaClave());
    await olvide(correo('corta'));
    await new Promise((r) => setTimeout(r, 100));
    const token = tokenDe(enviados.at(-1)!);
    expect((await post('reset-password', { token, password: '123' })).status).toBe(400);
    expect((await post('reset-password', { token, password: nuevaClave() })).status).toBe(204);
  });

  it('un token inventado se rechaza igual que uno vencido', async () => {
    expect((await post('reset-password', { token: randomBytes(32).toString('base64url'), password: nuevaClave() })).status).toBe(400);
  });

  it('límite por correo: pasadas 3 solicitudes por hora no se manda más, pero se sigue respondiendo 204 (no delata)', async () => {
    await crear('lim', nuevaClave());
    for (let i = 0; i < 5; i++) expect((await olvide(correo('lim'))).status).toBe(204);
    await new Promise((r) => setTimeout(r, 200));
    expect(enviados).toHaveLength(3);
  });

  it('límite por IP: una misma IP que pide demasiado recibe 429', async () => {
    const ip = ipUnica();
    let ultimo = 204;
    for (let i = 0; i < 12; i++) ultimo = (await olvide(`cualquiera${i}.${sufijo}@test.local`, ip)).status;
    expect(ultimo).toBe(429);
  });

  it('restablecer la contraseña es la salida de un bloqueo por intentos fallidos', async () => {
    const nueva = nuevaClave();
    await crear('bloq', nuevaClave());
    for (let i = 0; i < 6; i++) await login(correo('bloq'), 'incorrecta');
    expect((await login(correo('bloq'), 'otra')).status).toBe(429);
    await olvide(correo('bloq'));
    await new Promise((r) => setTimeout(r, 100));
    expect((await post('reset-password', { token: tokenDe(enviados.at(-1)!), password: nueva })).status).toBe(204);
    expect((await login(correo('bloq'), nueva)).status).toBe(200);
  });

  it('la respuesta no espera al servidor de correo (el tiempo no delata si la cuenta existe)', async () => {
    await crear('ana', nuevaClave());
    demoraCorreoMs = 1500;
    const t0 = performance.now();
    expect((await olvide(correo('ana'))).status).toBe(204);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it('la auditoría registra lo ocurrido y NUNCA el correo, el token ni la contraseña', async () => {
    const nueva = nuevaClave();
    const ip = ipUnica();
    await crear('ana', nuevaClave());
    await olvide(correo('ana'), ip);
    await new Promise((r) => setTimeout(r, 100));
    const token = tokenDe(enviados.at(-1)!);
    await post('reset-password', { token, password: nueva }, ip);
    const [rows] = await db().query<RowDataPacket[]>('SELECT resultado FROM auth_auditoria WHERE ip = ? ORDER BY id', [ip]);
    expect(rows.map((r) => r.resultado)).toEqual(['RECUPERACION_SOLICITADA', 'RECUPERACION_COMPLETADA']);
    const volcado = JSON.stringify((await db().query('SELECT * FROM auth_auditoria WHERE ip = ?', [ip]))[0])
      + JSON.stringify((await db().query('SELECT * FROM recuperacion_solicitudes WHERE ip = ?', [ip]))[0]);
    for (const secreto of [correo('ana'), token, nueva]) expect(volcado).not.toContain(secreto);
  });
});
