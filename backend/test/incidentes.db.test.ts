/**
 * Fase 2a: incidentes, reportes de usuarios y avisos. Ruta HTTP real contra una base REAL; el push se simula.
 * Todo "secreto" de estas pruebas se genera en tiempo de ejecución (sin literales).
 *   TEST_DB=1 DB_HOST=127.0.0.1 DB_NAME=tms_test DB_USER=... DB_PASS=... npx vitest run test/incidentes.db.test.ts
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';

const RUN = process.env.TEST_DB === '1';
const OWNER_UUID = randomUUID();
process.env.PLATFORM_OWNER_UUID = OWNER_UUID;
process.env.SITE_ID = 'sitio-test-a';
process.env.APP_COMMIT = `commit${randomBytes(4).toString('hex')}`;
delete process.env.OPENROUTER_API_KEY;

let falloListar: Error | null = null;
vi.mock('../src/modules/impuestos/impuestos.repo.js', async (orig) => {
  const real = await orig<typeof import('../src/modules/impuestos/impuestos.repo.js')>();
  return { ...real, listar: async (f: Parameters<typeof real.listar>[0]) => { if (falloListar) throw falloListar; return real.listar(f); } };
});
const pushes: { ids: number[]; payload: { title: string; body: string } }[] = [];
vi.mock('../src/modules/push/push.repo.js', async (orig) => {
  const real = await orig<typeof import('../src/modules/push/push.repo.js')>();
  return { ...real, enviarAUsuarios: async (ids: number[], payload: { title: string; body: string }) => { pushes.push({ ids: [...ids].sort((a, b) => a - b), payload }); } };
});

const { createApp } = await import('../src/app.js');
const { db } = await import('../src/db/pool.js');
const { signToken } = await import('../src/modules/auth/jwt.js');
const { reiniciarInterruptor, capturarErrorServidor } = await import('../src/modules/incidentes/captura.js');
const { registrarOcurrencia } = await import('../src/modules/incidentes/incidentes.repo.js');
const { huella } = await import('../src/modules/incidentes/sanitizar.js');

const sufijo = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const correo = (n: string) => `inc.${n}.${sufijo}@test.local`;
const azar = (n = 8) => randomBytes(n).toString('hex');
const ids: Record<string, number> = {};
const tokens: Record<string, string> = {};
let server: Server;
let base = '';
let ipN = 0;

async function crear(nombre: string, rol: 'admin' | 'operador', uuid?: string) {
  const [r] = await db().query<ResultSetHeader>(
    uuid
      ? "INSERT INTO staff_users (uuid, email, password_hash, nombre, rol, paginas, activo) VALUES (?, ?, ?, ?, ?, NULL, 1)"
      : "INSERT INTO staff_users (email, password_hash, nombre, rol, paginas, activo) VALUES (?, ?, ?, ?, NULL, 1)",
    uuid ? [uuid, correo(nombre), await bcrypt.hash(azar(6), 4), nombre, rol] : [correo(nombre), await bcrypt.hash(azar(6), 4), nombre, rol]);
  ids[nombre] = r.insertId;
  tokens[nombre] = signToken({ sub: r.insertId, email: correo(nombre), nombre, rol, paginas: null, sv: 0 });
}
const llamar = (quien: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `2001:db8:1c1c::${++ipN}`, ...(quien ? { Authorization: `Bearer ${tokens[quien]}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function incidentes(sitio = 'sitio-test-a'): Promise<RowDataPacket[]> {
  const [r] = await db().query<RowDataPacket[]>('SELECT * FROM incidentes WHERE sitio = ? ORDER BY id', [sitio]);
  return r;
}
async function esperarIncidentes(n: number, sitio = 'sitio-test-a'): Promise<RowDataPacket[]> {
  for (let i = 0; i < 40; i++) { const r = await incidentes(sitio); if (r.length >= n) return r; await espera(50); }
  return incidentes(sitio);
}
/** Crea un reporte y EXIGE 201 (si el tope o la validación lo rechazan, la prueba lo dice claro). */
async function reportar(quien: string, cuerpo: Record<string, unknown>): Promise<{ id: number; texto: string }> {
  const r = await llamar(quien, 'POST', '/api/reportes', cuerpo);
  expect(r.status, `reporte de ${quien}`).toBe(201);
  return (await r.json()) as { id: number; texto: string };
}
/** Espera a que la evidencia de ese X-Request-Id ya esté escrita (la captura ocurre después de responder). */
async function esperarEvidencia(rid: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const [r] = await db().query<RowDataPacket[]>('SELECT id FROM incidente_evidencias WHERE request_id = ?', [rid]);
    if (r.length) return;
    await espera(50);
  }
}
/** Provoca un 500 real en la ruta GET /api/impuestos/ica (el repositorio simulado lanza). */
async function provocar500(mensaje: string, requestId?: string) {
  falloListar = new Error(mensaje);
  try { return await llamar('admin1', 'GET', '/api/impuestos/ica', undefined, requestId ? { 'X-Request-Id': requestId } : {}); } finally { falloListar = null; }
}
async function limpiarTodo() {
  const [inc] = await db().query<RowDataPacket[]>("SELECT id FROM incidentes WHERE sitio LIKE 'sitio-test-%'");
  const lista = inc.map((i) => Number(i.id));
  if (lista.length) for (const t of ['incidente_eventos', 'incidente_evidencias', 'incidente_reportes', 'incidente_mensajes']) await db().query(`DELETE FROM ${t} WHERE incidente_id IN (?)`, [lista]);
  await db().query("DELETE FROM incidentes WHERE sitio LIKE 'sitio-test-%'");
}

describe.skipIf(!RUN)('incidentes y reportes (fase 2a)', () => {
  beforeAll(async () => {
    server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await limpiarTodo();
    await crear('dueno', 'admin', OWNER_UUID);
    await crear('admin1', 'admin');
    await crear('admin2', 'admin');
    await crear('opera', 'operador');
    await crear('opera2', 'operador');
    for (const n of ['opera3', 'opera4', 'opera5', 'opera6', 'opera7']) await crear(n, 'operador');
  });
  beforeEach(() => { pushes.length = 0; reiniciarInterruptor(); });

  afterAll(async () => {
    await limpiarTodo();
    const todos = Object.values(ids);
    await db().query('DELETE FROM auditoria WHERE usuario_id IN (?)', [todos]);
    await db().query('DELETE FROM incidente_reportes WHERE usuario_id IN (?)', [todos]);
    await db().query('DELETE FROM staff_users WHERE id IN (?)', [todos]);
    await new Promise((r) => server.close(r));
    await db().end();
  });

  // ------------------------------------------------------------------ captura del servidor
  it('un error 500 del servidor → incidente con evidencia SANITIZADA, versión y el mismo id de correlación', async () => {
    const secreto = azar(6); const mail = `${azar(4)}@${azar(3)}.com`; const rid = `req-${azar(6)}`;
    const r = await provocar500(`falló la consulta password=${secreto} del usuario ${mail}`, rid);
    expect(r.status).toBe(500);
    expect(r.headers.get('x-request-id')).toBe(rid);
    const cuerpo = (await r.json()) as { error: string; requestId: string };
    expect(cuerpo.error).toBe('Ocurrió un error.'); // la respuesta actual sigue igual…
    expect(cuerpo.requestId).toBe(rid); // …con un campo extra
    await esperarEvidencia(rid);
    const lista = await esperarIncidentes(1);
    expect(lista).toHaveLength(1);
    const i = lista[0]!;
    expect(i).toMatchObject({ tipo: 'codigo', origen: 'servidor', corregible: 1, ocurrencias: 1, estado: 'nuevo', sitio: 'sitio-test-a', version_despliegue: process.env.APP_COMMIT });
    expect(i.operacion).toBe('GET /api/impuestos/ica');
    const [ev] = await db().query<RowDataPacket[]>('SELECT * FROM incidente_evidencias WHERE incidente_id = ?', [i.id]);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.request_id).toBe(rid);
    expect(ev[0]!.usuario_id).toBe(ids.admin1);
    const volcado = JSON.stringify(ev) + JSON.stringify(i);
    expect(volcado).not.toContain(secreto);
    expect(volcado).not.toContain(mail);
  });

  it('el mismo fallo con otros números se agrupa (ocurrencias suma) y OTRO sitio es otro incidente', async () => {
    await provocar500(`falló la consulta ${Math.floor(Math.random() * 1e6)}`);
    await provocar500(`falló la consulta ${Math.floor(Math.random() * 1e6)}`);
    for (let i = 0; i < 40; i++) { if (Number((await incidentes())[0]?.ocurrencias) >= 3) break; await espera(50); }
    const lista = await incidentes();
    expect(lista).toHaveLength(2); // el de la prueba anterior (mensaje distinto) + este grupo
    expect(lista.map((x) => Number(x.ocurrencias)).sort()).toEqual([1, 2]);
    const h = lista[1]!.huella as string;
    await registrarOcurrencia({ sitio: 'sitio-test-b', huella: huella({ sitio: 'sitio-test-b', tipo: 'codigo', operacion: 'GET /api/impuestos/ica', codigo: null, mensaje: 'falló la consulta 1' }), tipo: 'codigo', origen: 'servidor', severidad: 'media', corregible: true, titulo: 'x', operacion: 'GET /api/impuestos/ica', codigo: null, version: 'v' });
    expect(await incidentes('sitio-test-b')).toHaveLength(1);
    expect(await incidentes()).toHaveLength(2); // el otro sitio no tocó los de este
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('solo se capturan los 5xx: un 403 o un 400 no crean incidentes; tampoco los errores de /api/reportes ni /api/soporte', async () => {
    const antes = (await incidentes()).length;
    expect((await llamar('opera', 'GET', '/api/impuestos/ica')).status).toBe(403);
    expect((await llamar('opera', 'POST', '/api/reportes', { texto: 'x' })).status).toBe(400);
    for (const status of [400, 403, 404, 409]) await capturarErrorServidor({ err: new Error(`boom ${status}`), status, metodo: 'GET', ruta: '/api/solicitudes/5' });
    await capturarErrorServidor({ err: new Error('boom'), status: 500, metodo: 'POST', ruta: '/api/reportes' });
    await capturarErrorServidor({ err: new Error('boom'), status: 500, metodo: 'GET', ruta: '/api/soporte/incidentes/5' });
    await espera(150);
    expect((await incidentes()).length).toBe(antes);
  });

  it('un rechazo de negocio del RNDC NO se convierte en incidente (ya vive en la cola de envíos)', async () => {
    const antes = (await incidentes()).length;
    await provocar500('El RNDC rechazó el documento: dato inválido');
    await espera(200);
    expect((await incidentes()).length).toBe(antes);
  });

  it('una caída del RNDC se clasifica como "rndc" y NO es corregible con código', async () => {
    await provocar500('No se pudo conectar con el servicio del RNDC (ECONNREFUSED)');
    const lista = await esperarIncidentes(3);
    const i = lista.find((x) => x.tipo === 'rndc');
    expect(i).toBeTruthy();
    expect(i!.corregible).toBe(0);
  });

  it('si registrar el incidente FALLA, la respuesta al usuario no cambia y se deja de capturar ~60 s (sin tormenta de errores)', async () => {
    await db().query('RENAME TABLE incidentes TO incidentes_apartada');
    try {
      const r = await provocar500(`fallo con la base caída ${azar(3)}`);
      expect(r.status).toBe(500);
      expect(((await r.json()) as { error: string }).error).toBe('Ocurrió un error.');
      await espera(150);
    } finally {
      await db().query('RENAME TABLE incidentes_apartada TO incidentes');
    }
    const antes = (await incidentes()).length;
    await provocar500(`otro fallo ${azar(3)}`); // el interruptor sigue abierto: no captura
    await espera(200);
    expect((await incidentes()).length).toBe(antes);
    reiniciarInterruptor();
    await provocar500(`fallo tras el interruptor ${azar(3)}`);
    expect((await esperarIncidentes(antes + 1)).length).toBe(antes + 1);
  });

  it('un incidente verificado que reaparece se reabre; y las evidencias se acotan a ~20', async () => {
    const huellaX = huella({ sitio: 'sitio-test-a', tipo: 'codigo', operacion: 'GET /x', codigo: null, mensaje: 'reaparece' });
    const o = { sitio: 'sitio-test-a', huella: huellaX, tipo: 'codigo', origen: 'servidor' as const, severidad: 'media', corregible: true, titulo: 'reaparece', operacion: 'GET /x', codigo: null, version: 'v1' };
    const ev = { tipo: 'servidor' as const, contenido: '{}', usuarioId: null, requestId: null };
    const { id } = await registrarOcurrencia({ ...o, evidencia: ev });
    for (let n = 0; n < 24; n++) await registrarOcurrencia({ ...o, evidencia: ev });
    const [[cuenta]] = await db().query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM incidente_evidencias WHERE incidente_id = ?', [id]);
    expect(Number(cuenta!.n)).toBeLessThanOrEqual(21);
    await db().query("UPDATE incidentes SET estado = 'verificado' WHERE id = ?", [id]);
    await registrarOcurrencia({ ...o });
    const [[f]] = await db().query<RowDataPacket[]>('SELECT estado, ocurrencias FROM incidentes WHERE id = ?', [id]);
    expect(f!.estado).toBe('nuevo');
    expect(Number(f!.ocurrencias)).toBe(26);
  });

  // ------------------------------------------------------------------ avisos al propietario
  it('un incidente NUEVO avisa solo al propietario (no a todos); una repetición no vuelve a avisar', async () => {
    await provocar500(`incidente que avisa ${azar(4)} password=${azar(5)}`.replace(/\d+/g, ''));
    await esperarIncidentes(1);
    for (let i = 0; i < 40 && pushes.length === 0; i++) await espera(50);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.ids).toEqual([ids.dueno]);
    expect(pushes[0]!.payload.title).toMatch(/incidente/i);
  });

  it('sin propietario configurado no se avisa a nadie', async () => {
    const original = process.env.PLATFORM_OWNER_UUID;
    delete process.env.PLATFORM_OWNER_UUID;
    try {
      await provocar500(`fallo sin dueño ${'x'.repeat(5)} unico${azar(3).replace(/\d/g, 'q')}`);
      await espera(300);
      expect(pushes).toHaveLength(0);
    } finally { process.env.PLATFORM_OWNER_UUID = original; }
  });

  // ------------------------------------------------------------------ reportes de usuarios
  it('el reporte funciona aunque el chat de IA esté apagado o caído (no depende de OpenRouter)', async () => {
    const chat = await (await llamar('opera', 'GET', '/api/chat/estado')).json() as { habilitado: boolean };
    expect(chat.habilitado).toBe(false);
    const r = await llamar('opera', 'POST', '/api/reportes', { texto: 'No me deja guardar la solicitud', pantalla: '/solicitudes/123/editar' });
    expect(r.status).toBe(201);
    const v = (await r.json()) as { id: number; estado: { codigo: string; etiqueta: string }; pantalla: string };
    expect(v.estado).toEqual({ codigo: 'nuevo', etiqueta: 'Recibido' });
    expect(v.pantalla).toBe('/solicitudes/:id/editar');
  });

  it('el texto del usuario se sanitiza (la gente pega contraseñas y tokens)', async () => {
    const secreto = azar(6);
    const v = await reportar('opera3', { texto: `Me falla el ingreso, mi password=${secreto} y mi token: ${azar(14)}`, pantalla: '/login' });
    expect(v.texto).not.toContain(secreto);
    const [[f]] = await db().query<RowDataPacket[]>('SELECT texto FROM incidente_reportes WHERE id = ?', [v.id]);
    expect(f!.texto).not.toContain(secreto);
  });

  it('cada usuario ve SOLO sus reportes: otro usuario —aunque sea administrador— recibe 404, no 403', async () => {
    const mio = await reportar('opera2', { texto: `Reporte privado de opera2 ${azar(4)}`, pantalla: '/cola' });
    for (const otro of ['opera', 'admin1', 'admin2']) {
      expect((await llamar(otro, 'GET', `/api/reportes/${mio.id}`)).status, otro).toBe(404);
      const lista = (await (await llamar(otro, 'GET', '/api/reportes')).json()) as { id: number }[];
      expect(lista.map((x) => x.id)).not.toContain(mio.id);
    }
    expect((await llamar('opera2', 'GET', `/api/reportes/${mio.id}`)).status).toBe(200);
    expect((await llamar('opera2', 'GET', '/api/reportes/abc')).status).toBe(404);
    expect((await llamar(null, 'GET', `/api/reportes/${mio.id}`)).status).toBe(401);
  });

  it('la vista del usuario sale de una lista blanca: ni evidencias, ni pilas, ni notas internas, ni datos de otros', async () => {
    const rid = `req-${azar(6)}`;
    const marcaPila = `pila-secreta-${azar(5)}`.replace(/\d/g, 'z');
    await provocar500(`${marcaPila} fallo`, rid);
    await esperarIncidentes(1);
    await esperarEvidencia(rid);
    const a = await reportar('opera', { texto: `Texto de opera ${azar(3)}`, requestId: rid });
    const b = await reportar('opera2', { texto: `TEXTO-AJENO-${azar(4)}`, requestId: rid });
    const [[inc]] = await db().query<RowDataPacket[]>('SELECT incidente_id AS id FROM incidente_reportes WHERE id = ?', [a.id]);
    const nota = `NOTA-INTERNA-${azar(4)}`;
    expect((await llamar('dueno', 'POST', `/api/soporte/incidentes/${inc!.id}/mensajes`, { visibilidad: 'interno', texto: nota })).status).toBe(201);
    const crudo = await (await llamar('opera', 'GET', `/api/reportes/${a.id}`)).text();
    const v = JSON.parse(crudo) as Record<string, unknown>;
    expect(Object.keys(v).sort()).toEqual(['actualizado', 'creado', 'estado', 'explicacion', 'id', 'mensajes', 'pantalla', 'texto']);
    for (const prohibido of [nota, marcaPila, b.texto, 'huella', 'sitio-test', 'stack', 'evidencia', 'request_id', 'usuario_id', process.env.APP_COMMIT!, rid, correo('opera2')]) {
      expect(crudo, prohibido).not.toContain(prohibido);
    }
  });

  it('tope de reportes por usuario (5 cada 10 min): el siguiente recibe 429', async () => {
    let ultimo = 0;
    for (let i = 0; i < 7; i++) ultimo = (await llamar('admin2', 'POST', '/api/reportes', { texto: `reporte de prueba número ${i} sin detalle`, pantalla: '/informe' })).status;
    expect(ultimo).toBe(429);
  });

  // ------------------------------------------------------------------ telemetría del navegador
  it('la telemetría del navegador exige sesión, valida los campos, sanitiza y tiene tope por usuario', async () => {
    expect((await llamar(null, 'POST', '/api/reportes/telemetria', { tipo: 'error_js', mensaje: 'x' })).status).toBe(401);
    expect((await llamar('opera', 'POST', '/api/reportes/telemetria', { tipo: 'error_js', mensaje: 'x', extra: 1 })).status).toBe(400);
    expect((await llamar('opera', 'POST', '/api/reportes/telemetria', { tipo: 'error_js', mensaje: 'x'.repeat(501) })).status).toBe(400);
    expect((await llamar('opera', 'POST', '/api/reportes/telemetria', { tipo: 'desconocido', mensaje: 'x' })).status).toBe(400);
    const secreto = azar(6);
    const r = await llamar('opera', 'POST', '/api/reportes/telemetria', { tipo: 'react', mensaje: `Cannot read x of undefined password=${secreto}`, ruta: '/despachos/123', pila: `Error\n   at f (/home/x/app/src/a.tsx:1:1) token=${azar(8)}` });
    expect(r.status).toBe(204);
    const [rows] = await db().query<RowDataPacket[]>("SELECT i.origen, e.contenido FROM incidentes i JOIN incidente_evidencias e ON e.incidente_id = i.id WHERE e.tipo = 'cliente' AND e.usuario_id = ? ORDER BY e.id DESC LIMIT 1", [ids.opera]);
    expect(rows[0]!.origen).toBe('navegador');
    expect(rows[0]!.contenido).not.toContain(secreto);
    expect(rows[0]!.contenido).not.toContain('/home/x');
    expect(rows[0]!.contenido).toContain('/despachos/:id');
    let ultimo = 204;
    for (let i = 0; i < 14; i++) ultimo = (await llamar('opera', 'POST', '/api/reportes/telemetria', { tipo: 'error_js', mensaje: `fallo ${i} distinto ${azar(2).replace(/\d/g, 'k')}` })).status;
    expect(ultimo).toBe(429);
  });

  it('un 5xx ya capturado por el servidor no se duplica desde el navegador (mismo X-Request-Id)', async () => {
    const rid = `req-${azar(6)}`;
    await provocar500(`fallo duplicado potencial ${azar(3).replace(/\d/g, 'm')}`, rid);
    await esperarEvidencia(rid);
    const [[antes]] = await db().query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM incidente_evidencias WHERE tipo = 'cliente'");
    expect((await llamar('admin2', 'POST', '/api/reportes/telemetria', { tipo: 'http_5xx', mensaje: 'HTTP 500', ruta: '/impuestos', requestId: rid })).status).toBe(204);
    const [[despues]] = await db().query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM incidente_evidencias WHERE tipo = 'cliente'");
    expect(Number(despues!.n)).toBe(Number(antes!.n));
  });

  // ------------------------------------------------------------------ consola del propietario y avisos al usuario
  it('solo el propietario ve la consola de incidentes: otro admin y un operador reciben 403 en cada ruta nueva', async () => {
    const rutas: [string, string, unknown?][] = [['GET', '/api/soporte/incidentes'], ['GET', '/api/soporte/incidentes/1'], ['PATCH', '/api/soporte/incidentes/1', { estado: 'cerrado' }], ['POST', '/api/soporte/incidentes/1/mensajes', { visibilidad: 'publico', texto: 'hola' }]];
    for (const [m, p, b] of rutas) {
      for (const quien of ['admin1', 'admin2', 'opera']) expect((await llamar(quien, m, p, b)).status, `${m} ${p} ${quien}`).toBe(403);
      expect((await llamar(null, m, p, b)).status).toBe(401);
    }
    const lista = await llamar('dueno', 'GET', '/api/soporte/incidentes');
    expect(lista.status).toBe(200);
    expect(((await lista.json()) as { items: unknown[] }).items.length).toBeGreaterThan(0);
  });

  it('un cambio de estado guardado avisa SOLO a quienes reportaron ESE incidente, con el estado releído; sin cambio o sin "notificar" no avisa', async () => {
    const rid = `req-${azar(6)}`;
    await provocar500(`fallo para avisar ${azar(3).replace(/\d/g, 'p')}`, rid);
    await esperarEvidencia(rid);
    const a = await reportar('opera4', { texto: `me pasó a mí ${azar(3)}`, requestId: rid });
    await reportar('opera5', { texto: `y a mí ${azar(3)}`, requestId: rid });
    const [[inc]] = await db().query<RowDataPacket[]>('SELECT incidente_id AS id FROM incidente_reportes WHERE id = ?', [a.id]);
    pushes.length = 0;
    // sin notificar → no avisa
    expect((await llamar('dueno', 'PATCH', `/api/soporte/incidentes/${inc!.id}`, { estado: 'en_diagnostico' })).status).toBe(200);
    expect(pushes).toHaveLength(0);
    // con notificar y cambio real → avisa solo a los dos que reportaron
    const r = await llamar('dueno', 'PATCH', `/api/soporte/incidentes/${inc!.id}`, { estado: 'causa_identificada', notificar: true });
    expect(((await r.json()) as { avisados: number; estado: string }).estado).toBe('causa_identificada');
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.ids).toEqual([ids.opera4, ids.opera5].sort((x, y) => x! - y!));
    expect(pushes[0]!.payload.body).toBe('Causa identificada');
    expect(pushes[0]!.ids).not.toContain(ids.admin1);
    expect(pushes[0]!.ids).not.toContain(ids.dueno);
    // el usuario ve el estado y el mensaje público
    const v = (await (await llamar('opera4', 'GET', `/api/reportes/${a.id}`)).json()) as { estado: { etiqueta: string }; mensajes: { texto: string }[] };
    expect(v.estado.etiqueta).toBe('Causa identificada');
    expect(v.mensajes.map((m) => m.texto)).toContain('Estado: Causa identificada');
    // mismo estado otra vez, con notificar → no cambió: no avisa
    pushes.length = 0;
    await llamar('dueno', 'PATCH', `/api/soporte/incidentes/${inc!.id}`, { estado: 'causa_identificada', notificar: true });
    expect(pushes).toHaveLength(0);
    // incidente inexistente / estado inválido → nada se guarda ni se avisa
    expect((await llamar('dueno', 'PATCH', '/api/soporte/incidentes/99999999', { estado: 'cerrado', notificar: true })).status).toBe(404);
    expect((await llamar('dueno', 'PATCH', `/api/soporte/incidentes/${inc!.id}`, { estado: 'inventado', notificar: true })).status).toBe(400);
    expect((await llamar('dueno', 'PATCH', `/api/soporte/incidentes/${inc!.id}`, { campoRaro: 1 })).status).toBe(400);
    expect(pushes).toHaveLength(0);
  });

  it('una nota interna no avisa a nadie ni la ve el usuario; un mensaje público va SOLO al reporte destinatario', async () => {
    const rid = `req-${azar(6)}`;
    await provocar500(`fallo mensajes ${azar(3).replace(/\d/g, 'h')}`, rid);
    await esperarEvidencia(rid);
    const a = await reportar('opera6', { texto: `A ${azar(3)}`, requestId: rid });
    const b = await reportar('opera7', { texto: `B ${azar(3)}`, requestId: rid });
    const [[inc]] = await db().query<RowDataPacket[]>('SELECT incidente_id AS id FROM incidente_reportes WHERE id = ?', [a.id]);
    pushes.length = 0;
    const interna = `INTERNA-${azar(4)}`;
    await llamar('dueno', 'POST', `/api/soporte/incidentes/${inc!.id}/mensajes`, { visibilidad: 'interno', texto: interna });
    expect(pushes).toHaveLength(0);
    const soloA = `Para A: ya estamos revisándolo ${azar(2)}`;
    expect((await llamar('dueno', 'POST', `/api/soporte/incidentes/${inc!.id}/mensajes`, { visibilidad: 'publico', texto: soloA, reporteId: a.id })).status).toBe(201);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.ids).toEqual([ids.opera6]);
    const vistaA = await (await llamar('opera6', 'GET', `/api/reportes/${a.id}`)).text();
    const vistaB = await (await llamar('opera7', 'GET', `/api/reportes/${b.id}`)).text();
    expect(vistaA).toContain(soloA);
    expect(vistaB).not.toContain(soloA); // lo que se le responde a A no llega a B aunque compartan incidente
    expect(vistaA + vistaB).not.toContain(interna);
  });

  it('la explicación pública (5 campos) la edita solo el propietario y el usuario la ve sin lo técnico', async () => {
    const rid = `req-${azar(6)}`;
    await provocar500(`fallo explicación ${azar(3).replace(/\d/g, 'e')}`, rid);
    await esperarEvidencia(rid);
    const a = await reportar('opera3', { texto: `explícame ${azar(3)}`, requestId: rid });
    const [[inc]] = await db().query<RowDataPacket[]>('SELECT incidente_id AS id FROM incidente_reportes WHERE id = ?', [a.id]);
    const sinSesion = (await (await llamar('opera3', 'GET', `/api/reportes/${a.id}`)).json()) as { explicacion: Record<string, unknown> };
    expect(Object.values(sinSesion.explicacion)).toEqual([null, null, null, null, null]); // sin diagnóstico no se inventa nada
    const exp = { hecho: 'Al abrir Impuestos, la pantalla falló.', posibleCausa: 'Posible dato incompleto.', causaConfirmada: null, accionTemporal: 'Revisa en la pantalla si quedó registrada antes de repetir.', estadoCorreccion: 'Aún no hay corrección.' };
    expect((await llamar('admin1', 'PATCH', `/api/soporte/incidentes/${inc!.id}`, { explicacion: exp })).status).toBe(403);
    expect((await llamar('dueno', 'PATCH', `/api/soporte/incidentes/${inc!.id}`, { explicacion: exp })).status).toBe(200);
    const v = (await (await llamar('opera3', 'GET', `/api/reportes/${a.id}`)).json()) as { explicacion: Record<string, string | null> };
    expect(v.explicacion).toEqual(exp);
  });
});
