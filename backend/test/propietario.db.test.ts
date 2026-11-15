/**
 * Fase 1 del módulo de soporte: PROPIETARIO ÚNICO. Contra la ruta HTTP real y una base REAL.
 * Solo la cuenta vinculada a PLATFORM_OWNER_UUID entra a /api/soporte; ningún otro administrador, ningún operador,
 * ninguna acción/página asignada, ningún claim ni cabecera. La cuenta del propietario no se puede tocar desde Usuarios.
 *   TEST_DB=1 DB_HOST=127.0.0.1 DB_NAME=tms_test DB_USER=... DB_PASS=... npx vitest run test/propietario.db.test.ts
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';

const RUN = process.env.TEST_DB === '1';
const OWNER_UUID = randomUUID();
process.env.PLATFORM_OWNER_UUID = OWNER_UUID;
process.env.APP_URL = 'https://konekto.prueba.test';

const correos: { para: string }[] = [];
vi.mock('../src/modules/auth/correo.js', () => ({ enviarCorreo: async (c: { para: string }) => { correos.push(c); return true; } }));

const { createApp } = await import('../src/app.js');
const { db } = await import('../src/db/pool.js');
const { soporteRouter } = await import('../src/modules/soporte/soporte.routes.js');
const { signToken } = await import('../src/modules/auth/jwt.js');
const { ACCIONES } = await import('../src/modules/auth/permisos.js');
const { restablecerContrasena } = await import('../src/modules/auth/recuperacion.js');
const { hashIdentificador } = await import('../src/modules/auth/accesoGuard.js');
const { config } = await import('../src/config/env.js');

const sufijo = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const correo = (n: string) => `own.${n}.${sufijo}@test.local`;
const claves: Record<string, string> = {};
const ids: Record<string, number> = {};
const tokens: Record<string, string> = {};
const ips: string[] = [];
const ipUnica = () => { const ip = `2001:db8:0a0a:${sufijo.slice(-4)}::${ips.length + 1}`; ips.push(ip); return ip; };
let server: Server;
let base = '';

async function crear(nombre: string, rol: 'admin' | 'operador', uuid?: string): Promise<void> {
  claves[nombre] = randomBytes(10).toString('base64url');
  const [r] = await db().query<ResultSetHeader>(
    uuid
      ? "INSERT INTO staff_users (uuid, email, password_hash, nombre, rol, paginas, activo) VALUES (?, ?, ?, ?, ?, NULL, 1)"
      : "INSERT INTO staff_users (email, password_hash, nombre, rol, paginas, activo) VALUES (?, ?, ?, ?, NULL, 1)",
    uuid ? [uuid, correo(nombre), await bcrypt.hash(claves[nombre]!, 4), nombre, rol] : [correo(nombre), await bcrypt.hash(claves[nombre]!, 4), nombre, rol],
  );
  ids[nombre] = r.insertId;
  tokens[nombre] = signToken({ sub: r.insertId, email: correo(nombre), nombre, rol, paginas: null, sv: 0 });
}

const llamar = (token: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ipUnica(), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const login = (nombre: string, password = claves[nombre]!) =>
  llamar(null, 'POST', '/api/auth/login', { email: correo(nombre), password });
async function fila(nombre: string): Promise<RowDataPacket> {
  const [r] = await db().query<RowDataPacket[]>('SELECT email, password_hash, rol, activo, uuid, nombre FROM staff_users WHERE id = ?', [ids[nombre]]);
  return r[0]!;
}

describe.skipIf(!RUN)('propietario único del módulo de soporte', () => {
  beforeAll(async () => {
    server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await crear('dueno', 'admin', OWNER_UUID);
    await crear('adminb', 'admin');
    await crear('adminc', 'admin');
    await crear('operador', 'operador');
  });

  afterAll(async () => {
    const todos = Object.values(ids);
    const hashes = Object.keys(ids).map((n) => hashIdentificador(correo(n)));
    await db().query('DELETE FROM auth_intentos WHERE identificador_hash IN (?) OR ip LIKE ? OR identificador_hash = ?', [hashes, `2001:db8:0a0a:${sufijo.slice(-4)}%`, hashIdentificador(`reauth-propietario:${ids.dueno}`)]);
    await db().query('DELETE FROM auth_auditoria WHERE usuario_id IN (?) OR ip LIKE ?', [todos, `2001:db8:0a0a:${sufijo.slice(-4)}%`]);
    await db().query('DELETE FROM auditoria WHERE usuario_id IN (?)', [todos]);
    await db().query('DELETE FROM password_resets WHERE usuario_id IN (?)', [todos]);
    await db().query('DELETE FROM recuperacion_solicitudes WHERE ip LIKE ?', [`2001:db8:0a0a:${sufijo.slice(-4)}%`]);
    await db().query('DELETE FROM staff_users WHERE id IN (?) OR email LIKE ?', [todos, `%.${sufijo}@test.local`]);
    await new Promise((r) => server.close(r));
    await db().end();
  });

  it('el propietario accede a la consola de soporte', async () => {
    const r = await llamar(tokens.dueno!, 'GET', '/api/soporte/estado');
    expect(r.status).toBe(200);
    expect(((await r.json()) as { ok: boolean }).ok).toBe(true);
  });

  it('otro administrador y un operador reciben 403 en CADA endpoint del módulo (se recorre el router: los futuros quedan cubiertos)', async () => {
    const rutas = (soporteRouter.stack as unknown as { route?: { path: string; methods: Record<string, boolean> } }[])
      .filter((l) => l.route)
      .flatMap((l) => Object.keys(l.route!.methods).map((m) => ({ metodo: m.toUpperCase(), ruta: l.route!.path })));
    expect(rutas.length).toBeGreaterThanOrEqual(3);
    for (const { metodo, ruta } of rutas) {
      for (const quien of ['adminb', 'adminc', 'operador']) {
        const r = await llamar(tokens[quien]!, metodo, `/api/soporte${ruta}`, metodo === 'GET' ? undefined : { passwordActual: 'x' });
        expect(r.status, `${metodo} ${ruta} como ${quien}`).toBe(403);
      }
      expect((await llamar(null, metodo, `/api/soporte${ruta}`)).status, `${metodo} ${ruta} sin sesión`).toBe(401);
    }
  });

  it('el router de soporte tiene el guardia como PRIMERA capa (denegado por defecto)', () => {
    const primera = (soporteRouter.stack as unknown as { name: string; route?: unknown }[])[0]!;
    expect(primera.route).toBeUndefined();
    expect(primera.name).toBe('requirePlatformOwner');
  });

  it('manipular el cliente no concede acceso: isOwner en el cuerpo, la consulta, cabeceras o el propio token', async () => {
    const t = tokens.adminb!;
    expect((await llamar(t, 'GET', '/api/soporte/estado?isOwner=true&owner=1')).status).toBe(403);
    expect((await llamar(t, 'GET', '/api/soporte/estado', undefined, { 'X-Is-Owner': 'true', 'X-Platform-Owner': OWNER_UUID })).status).toBe(403);
    expect((await llamar(t, 'PUT', '/api/soporte/perfil', { isOwner: true, passwordActual: claves.adminb })).status).toBe(403);
    // Un token con claims de propietario inventados (firmado con el secreto, como lo haría un atacante que lo conociera: aun así el servidor decide por la base)
    const falso = jwt.sign({ sub: ids.adminb, email: correo('adminb'), nombre: 'x', rol: 'admin', paginas: null, sv: 0, isOwner: true, supportOwner: true, uuid: OWNER_UUID }, config().auth.jwtSecret);
    expect((await llamar(falso, 'GET', '/api/soporte/estado')).status).toBe(403);
  });

  it('asignar acciones o páginas no concede acceso al soporte (ni siquiera todas las acciones)', async () => {
    const r = await llamar(tokens.adminb!, 'PUT', `/api/usuarios/${ids.operador}`, {
      email: correo('operador'), nombre: 'operador', rol: 'operador', paginas: null, acciones: [...ACCIONES], activo: true,
    });
    expect(r.status).toBe(200);
    expect((await llamar(tokens.operador!, 'GET', '/api/soporte/estado')).status).toBe(403);
    expect((await llamar(tokens.adminb!, 'GET', '/api/soporte/estado')).status).toBe(403);
  });

  it('otro administrador NO puede cambiar el correo, la contraseña, el rol ni el estado del propietario', async () => {
    const antes = await fila('dueno');
    const intentos = [
      { email: 'atacante@evil.test' },
      { password: 'ClaveDelAtacante-123' },
      { rol: 'operador' },
      { activo: false },
      { nombre: 'Suplantado' },
      { email: 'atacante@evil.test', password: 'ClaveDelAtacante-123', rol: 'operador', activo: false },
    ];
    for (const i of intentos) {
      const r = await llamar(tokens.adminb!, 'PUT', `/api/usuarios/${ids.dueno}`, { email: correo('dueno'), nombre: 'dueno', rol: 'admin', paginas: null, activo: true, ...i });
      expect(r.status, JSON.stringify(i)).toBe(403);
    }
    const despues = await fila('dueno');
    expect(despues).toEqual(antes);
    expect(await bcrypt.compare('ClaveDelAtacante-123', despues.password_hash)).toBe(false);
  });

  it('ni siquiera el propietario edita su cuenta por Usuarios (usa su flujo con reautenticación); no existe forma de eliminarla', async () => {
    const r = await llamar(tokens.dueno!, 'PUT', `/api/usuarios/${ids.dueno}`, { email: correo('dueno'), nombre: 'dueno', rol: 'admin', paginas: null, activo: false });
    expect(r.status).toBe(403);
    expect((await fila('dueno')).activo).toBe(1);
    expect((await llamar(tokens.adminb!, 'DELETE', `/api/usuarios/${ids.dueno}`)).status).toBe(404); // no hay ruta de borrado
  });

  it('el ataque por recuperación no funciona: no pueden cambiar el correo del propietario, así que el enlace solo llega a él', async () => {
    await llamar(tokens.adminb!, 'PUT', `/api/usuarios/${ids.dueno}`, { email: 'atacante@evil.test', nombre: 'x', rol: 'admin', paginas: null, activo: true });
    correos.length = 0;
    await llamar(null, 'POST', '/api/auth/forgot-password', { email: 'atacante@evil.test' });
    await llamar(null, 'POST', '/api/auth/forgot-password', { email: correo('dueno') });
    await new Promise((r) => setTimeout(r, 150));
    expect(correos.map((c) => c.para)).toEqual([correo('dueno')]);
  });

  it('crear o editar cuentas con campos reservados se rechaza y NO crea un segundo propietario', async () => {
    const antes = await db().query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM staff_users WHERE uuid = ?', [OWNER_UUID]);
    for (const extra of [{ uuid: OWNER_UUID }, { isOwner: true }, { supportOwner: true }, { sesion_version: 99 }, { platformOwner: OWNER_UUID }, { campoInventado: 1 }]) {
      const r = await llamar(tokens.adminb!, 'POST', '/api/usuarios', { email: correo(`falso${Object.keys(extra)[0]}`), password: 'Clave-larga-123', nombre: 'Falso', rol: 'admin', ...extra });
      expect(r.status, JSON.stringify(extra)).toBe(400);
      const e = await llamar(tokens.adminb!, 'PUT', `/api/usuarios/${ids.adminc}`, { email: correo('adminc'), nombre: 'adminc', rol: 'admin', paginas: null, activo: true, ...extra });
      expect(e.status, `PUT ${JSON.stringify(extra)}`).toBe(400);
    }
    const [despues] = await db().query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM staff_users WHERE uuid = ?', [OWNER_UUID]);
    expect(Number(despues[0]!.n)).toBe(Number(antes[0]![0]!.n));
    const [falsos] = await db().query<RowDataPacket[]>("SELECT id FROM staff_users WHERE email LIKE ?", [`own.falso%.${sufijo}@test.local`]);
    expect(falsos).toHaveLength(0);
    expect((await fila('adminc')).uuid).not.toBe(OWNER_UUID);
  });

  it('una cuenta nueva recibe su uuid de la base: nadie elige el suyo', async () => {
    const r = await llamar(tokens.adminb!, 'POST', '/api/usuarios', { email: correo('nuevo'), password: 'Clave-larga-123', nombre: 'Nuevo', rol: 'operador' });
    expect(r.status).toBe(201);
    const [f] = await db().query<RowDataPacket[]>('SELECT uuid FROM staff_users WHERE email = ?', [correo('nuevo')]);
    expect(f[0]!.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(f[0]!.uuid).not.toBe(OWNER_UUID);
  });

  it('configuración ausente o inválida: se deniega TODO, incluso al propietario (nunca se cae a "cualquier admin")', async () => {
    const original = process.env.PLATFORM_OWNER_UUID;
    try {
      for (const valor of [undefined, '', 'no-es-un-uuid', randomUUID()]) {
        if (valor === undefined) delete process.env.PLATFORM_OWNER_UUID; else process.env.PLATFORM_OWNER_UUID = valor;
        for (const quien of ['dueno', 'adminb']) {
          expect((await llamar(tokens[quien]!, 'GET', '/api/soporte/estado')).status, `${String(valor)} / ${quien}`).toBe(403);
        }
      }
    } finally {
      process.env.PLATFORM_OWNER_UUID = original;
    }
    expect((await llamar(tokens.dueno!, 'GET', '/api/soporte/estado')).status).toBe(200);
  });

  it('una cuenta desactivada que fue propietaria deja de serlo (aunque conserve su token)', async () => {
    await db().query('UPDATE staff_users SET activo = 0 WHERE id = ?', [ids.dueno]);
    try {
      // 401 si la caché de sesión ya lo sabe, 403 si no: lo que importa es que NO entra.
      expect([401, 403]).toContain((await llamar(tokens.dueno!, 'GET', '/api/soporte/estado')).status);
    } finally {
      await db().query('UPDATE staff_users SET activo = 1 WHERE id = ?', [ids.dueno]);
    }
  });

  it('/auth/me y el login traen la capacidad calculada por el servidor, sin filtrar uuid ni versión de sesión', async () => {
    const dueno = await (await llamar(tokens.dueno!, 'GET', '/api/auth/me')).text();
    const otro = await (await llamar(tokens.adminb!, 'GET', '/api/auth/me')).text();
    expect(JSON.parse(dueno).capabilities).toEqual({ supportOwner: true });
    expect(JSON.parse(otro).capabilities).toEqual({ supportOwner: false });
    for (const t of [dueno, otro]) { expect(t).not.toContain(OWNER_UUID); expect(t).not.toMatch(/sesion_version|"uuid"/); }
    const lg = await (await login('dueno')).text();
    expect(JSON.parse(lg).capabilities.supportOwner).toBe(true);
    expect(lg).not.toContain(OWNER_UUID);
    expect(JSON.parse(await (await login('adminb')).text()).capabilities.supportOwner).toBe(false);
  });

  it('la lista de usuarios marca la cuenta protegida pero no revela ningún uuid', async () => {
    const t = await (await llamar(tokens.adminb!, 'GET', '/api/usuarios')).text();
    expect(t).not.toContain(OWNER_UUID);
    expect(t).not.toMatch(/"uuid"|sesion_version/);
    const lista = JSON.parse(t) as { id: number; protegido: boolean }[];
    expect(lista.find((u) => u.id === ids.dueno)!.protegido).toBe(true);
    expect(lista.find((u) => u.id === ids.adminb)!.protegido).toBe(false);
  });

  it('cambiar la contraseña de otra cuenta, o recuperarla, cierra sus sesiones abiertas', async () => {
    const viejo = tokens.adminc!;
    expect((await llamar(viejo, 'GET', '/api/auth/me')).status).toBe(200);
    expect((await llamar(tokens.adminb!, 'PUT', `/api/usuarios/${ids.adminc}`, { email: correo('adminc'), nombre: 'adminc', rol: 'admin', paginas: null, activo: true, password: 'Otra-clave-larga-1' })).status).toBe(200);
    expect((await llamar(viejo, 'GET', '/api/auth/me')).status).toBe(401);
    // Recuperación por correo: la misma garantía.
    const sesionVieja = (await (await login('adminb')).json() as { token: string }).token;
    expect((await llamar(sesionVieja, 'GET', '/api/auth/me')).status).toBe(200);
    correos.length = 0;
    await llamar(null, 'POST', '/api/auth/forgot-password', { email: correo('adminb') });
    await new Promise((r) => setTimeout(r, 150));
    const enlace = /token=([\w-]+)/.exec((await db().query<RowDataPacket[]>('SELECT 1'))[0] ? 'x' : 'x');
    void enlace;
    // Se reclama el enlace desde la base: el token en claro solo existe en el correo, así que se emite uno de prueba.
    const tokenReset = randomBytes(32).toString('base64url');
    await db().query("INSERT INTO password_resets (usuario_id, token_hash, expira_en) VALUES (?, SHA2(?, 256), NOW() + INTERVAL 10 MINUTE)", [ids.adminb, tokenReset]);
    expect(await restablecerContrasena(tokenReset, 'Clave-recuperada-123', ipUnica(), null)).toBe('OK');
    expect((await llamar(sesionVieja, 'GET', '/api/auth/me')).status).toBe(401);
  });

  it('PERFIL del propietario: exige la contraseña actual; solo nombre, correo y contraseña; el resto se rechaza', async () => {
    const t = tokens.dueno!;
    expect((await llamar(t, 'PUT', '/api/soporte/perfil', { nombre: 'Otro nombre' })).status).toBe(400); // sin reautenticación
    expect((await llamar(t, 'PUT', '/api/soporte/perfil', { passwordActual: 'incorrecta', nombre: 'X' })).status).toBe(401);
    for (const extra of [{ rol: 'operador' }, { activo: false }, { uuid: randomUUID() }, { isOwner: false }]) {
      expect((await llamar(t, 'PUT', '/api/soporte/perfil', { passwordActual: claves.dueno, ...extra })).status, JSON.stringify(extra)).toBe(400);
    }
    const ok = await llamar(t, 'PUT', '/api/soporte/perfil', { passwordActual: claves.dueno, nombre: 'Propietario Real' });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { cerroSesiones: boolean }).cerroSesiones).toBe(false);
    const f = await fila('dueno');
    expect(f.nombre).toBe('Propietario Real');
    expect(f.rol).toBe('admin');
    expect(f.uuid).toBe(OWNER_UUID);
  });

  it('la reautenticación tiene tope de intentos fallidos (un token robado no sirve para adivinar la contraseña)', async () => {
    let ultimo = 0;
    for (let i = 0; i < 8; i++) ultimo = (await llamar(tokens.dueno!, 'PUT', '/api/soporte/perfil', { passwordActual: `mala-${i}`, nombre: 'X' })).status;
    expect(ultimo).toBe(429);
    await db().query('DELETE FROM auth_intentos WHERE identificador_hash = ?', [hashIdentificador(`reauth-propietario:${ids.dueno}`)]);
  });

  it('cambiar correo o contraseña cierra TODAS las sesiones del propietario; una sesión revocada no ejecuta nada', async () => {
    const t = tokens.dueno!;
    const nueva = 'Clave-del-dueno-nueva-1';
    const r = await llamar(t, 'PUT', '/api/soporte/perfil', { passwordActual: claves.dueno, passwordNueva: nueva });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { cerroSesiones: boolean }).cerroSesiones).toBe(true);
    for (const [m, p] of [['GET', '/api/soporte/estado'], ['PUT', '/api/soporte/perfil'], ['POST', '/api/soporte/sesiones/cerrar'], ['GET', '/api/auth/me']] as const) {
      expect((await llamar(t, m, p, m === 'GET' ? undefined : { passwordActual: nueva })).status, `${m} ${p}`).toBe(401);
    }
    claves.dueno = nueva;
    const nuevo = (await (await login('dueno')).json()) as { token: string };
    tokens.dueno = nuevo.token;
    expect((await llamar(nuevo.token, 'GET', '/api/soporte/estado')).status).toBe(200);
  });

  it('el propietario puede cerrar todas sus sesiones a propósito (con contraseña)', async () => {
    const t = tokens.dueno!;
    expect((await llamar(t, 'POST', '/api/soporte/sesiones/cerrar', {})).status).toBe(400);
    expect((await llamar(t, 'POST', '/api/soporte/sesiones/cerrar', { passwordActual: claves.dueno })).status).toBe(200);
    expect((await llamar(t, 'GET', '/api/soporte/estado')).status).toBe(401);
  });

  it('las acciones del propietario quedan en la auditoría', async () => {
    const [rows] = await db().query<RowDataPacket[]>("SELECT accion FROM auditoria WHERE usuario_id = ? AND accion LIKE 'propietario.%'", [ids.dueno]);
    expect(rows.map((r) => r.accion)).toEqual(expect.arrayContaining(['propietario.perfil', 'propietario.sesiones']));
  });
});
