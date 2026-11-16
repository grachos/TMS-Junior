/**
 * Fase 3b: diagnóstico por reglas contra la ruta HTTP real y una base REAL. El RNDC y el proveedor de IA se vigilan: el diagnóstico
 * NO puede llamar a ninguno (solo lecturas). Todo "secreto" se genera en tiempo de ejecución.
 *   TEST_DB=1 DB_HOST=127.0.0.1 DB_NAME=tms_test DB_USER=... DB_PASS=... npx vitest run test/diagnostico.db.test.ts
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';

const RUN = process.env.TEST_DB === '1';
const SITIO = 'sitio-test-diag';
process.env.SITE_ID = SITIO;
process.env.PLATFORM_OWNER_UUID = randomUUID();
process.env.CHAT_HABILITADO = 'true';
process.env.OPENROUTER_API_KEY = randomBytes(12).toString('hex');
process.env.OPENROUTER_BASE_URL = 'http://openrouter.test/api/v1';

// Vigilancia: el RNDC no debe construirse ni llamarse jamás; el proveedor de IA tampoco.
let llamadasRndc = 0;
vi.mock('../src/rndc/RndcClient.js', () => ({
  RndcClient: { desdeConfig: async () => { llamadasRndc += 1; throw new Error('el diagnóstico NO debe llamar al RNDC'); } },
}));
let llamadasIA = 0;
const fetchReal = globalThis.fetch;
globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
  if (String(url).startsWith('http://openrouter.test')) { llamadasIA += 1; return new Response('{}', { status: 502 }); }
  return fetchReal(url as string, init);
}) as typeof fetch;
const pushes: { ids: number[] }[] = [];
vi.mock('../src/modules/push/push.repo.js', async (orig) => {
  const real = await orig<typeof import('../src/modules/push/push.repo.js')>();
  return { ...real, enviarAUsuarios: async (ids: number[]) => { pushes.push({ ids: [...ids] }); } };
});
let falloListar: Error | null = null;
vi.mock('../src/modules/impuestos/impuestos.repo.js', async (orig) => {
  const real = await orig<typeof import('../src/modules/impuestos/impuestos.repo.js')>();
  return { ...real, listar: async (f: Parameters<typeof real.listar>[0]) => { if (falloListar) throw falloListar; return real.listar(f); } };
});

const { createApp } = await import('../src/app.js');
const { db, leerSoloLectura } = await import('../src/db/pool.js');
const { signToken } = await import('../src/modules/auth/jwt.js');
const { registrarOcurrencia } = await import('../src/modules/incidentes/incidentes.repo.js');
const { huella } = await import('../src/modules/incidentes/sanitizar.js');
const { reiniciarInterruptor } = await import('../src/modules/incidentes/captura.js');
const { reiniciarInterruptorDiagnostico, diagnosticarIncidente } = await import('../src/modules/diagnostico/servicio.js');

const sufijo = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const azar = (n = 6) => randomBytes(n).toString('hex');
const ids: Record<string, number> = {};
const tokens: Record<string, string> = {};
let server: Server; let base = ''; let ipN = 0;

async function crear(nombre: string, rol: 'admin' | 'operador', uuid?: string) {
  const [r] = await db().query<ResultSetHeader>(
    uuid ? "INSERT INTO staff_users (uuid, email, password_hash, nombre, rol, paginas, activo) VALUES (?, ?, ?, ?, ?, NULL, 1)" : "INSERT INTO staff_users (email, password_hash, nombre, rol, paginas, activo) VALUES (?, ?, ?, ?, NULL, 1)",
    uuid ? [uuid, `dg.${nombre}.${sufijo}@test.local`, await bcrypt.hash(azar(6), 4), nombre, rol] : [`dg.${nombre}.${sufijo}@test.local`, await bcrypt.hash(azar(6), 4), nombre, rol]);
  ids[nombre] = r.insertId;
  tokens[nombre] = signToken({ sub: r.insertId, email: `dg.${nombre}.${sufijo}@test.local`, nombre, rol, paginas: null, sv: 0 });
}
const llamar = (quien: string | null, method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `2001:db8:d1a6::${++ipN}`, ...(quien ? { Authorization: `Bearer ${tokens[quien]}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Crea un incidente (directo en la base, ya sanitizado como lo haría la captura) con su evidencia. */
async function incidente(o: { tipo: string; mensaje: string; pila?: string; origen?: 'servidor' | 'usuario'; operacion?: string; corregible?: boolean; version?: string }) {
  const operacion = o.operacion ?? `GET /api/${azar(3)}`;
  const r = await registrarOcurrencia({
    sitio: SITIO, huella: huella({ sitio: SITIO, tipo: o.tipo, operacion, codigo: null, mensaje: `${o.mensaje}${azar(2)}` }), tipo: o.tipo, origen: o.origen ?? 'servidor', severidad: 'media',
    corregible: o.corregible ?? true, titulo: `${operacion}: ${o.mensaje}`.slice(0, 200), operacion, codigo: null, version: o.version ?? 'v-test',
    evidencia: o.origen === 'usuario' ? undefined : { tipo: 'servidor', contenido: JSON.stringify({ metodo: 'GET', ruta: operacion, status: 500, codigo: null, mensaje: o.mensaje, pila: o.pila ?? '' }), usuarioId: null, requestId: null },
  });
  return r.id;
}
async function fila(id: number): Promise<RowDataPacket> { const [[f]] = await db().query<RowDataPacket[]>('SELECT * FROM incidentes WHERE id = ?', [id]); return f!; }
async function diagnosticos(id: number): Promise<RowDataPacket[]> { const [r] = await db().query<RowDataPacket[]>('SELECT * FROM incidente_diagnosticos WHERE incidente_id = ? ORDER BY id', [id]); return r; }
async function limpiarTodo() {
  const [inc] = await db().query<RowDataPacket[]>("SELECT id FROM incidentes WHERE sitio = ?", [SITIO]);
  const lista = inc.map((i) => Number(i.id));
  if (lista.length) for (const t of ['incidente_eventos', 'incidente_evidencias', 'incidente_reportes', 'incidente_mensajes', 'incidente_diagnosticos']) await db().query(`DELETE FROM ${t} WHERE incidente_id IN (?)`, [lista]);
  await db().query('DELETE FROM incidentes WHERE sitio = ?', [SITIO]);
}
const sumas = async () => { const r: Record<string, unknown> = {}; for (const t of ['cola_envios', 'manifiesto', 'remesa', 'solicitud_servicio', 'tercero']) { const [[x]] = await db().query<RowDataPacket[]>(`CHECKSUM TABLE ${t}`); r[t] = x!.Checksum; } return r; };

describe.skipIf(!RUN)('diagnóstico por reglas (fase 3b)', () => {
  beforeAll(async () => {
    server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await limpiarTodo();
    await crear('dueno', 'admin', process.env.PLATFORM_OWNER_UUID);
    await crear('admin', 'admin');
    await crear('opera', 'operador');
    await crear('reporta', 'operador');
  });
  beforeEach(() => { pushes.length = 0; llamadasRndc = 0; llamadasIA = 0; reiniciarInterruptor(); reiniciarInterruptorDiagnostico(); });
  afterAll(async () => {
    globalThis.fetch = fetchReal;
    await limpiarTodo();
    await db().query("DELETE FROM cola_envios WHERE ultimo_error LIKE '%diagtest%'");
    await db().query('DELETE FROM auditoria WHERE usuario_id IN (?)', [Object.values(ids)]);
    await db().query('DELETE FROM staff_users WHERE id IN (?)', [Object.values(ids)]);
    await new Promise((r) => server.close(r));
    await db().end();
  });

  it('migración pendiente: CONFIRMADA solo mientras el objeto falta AHORA; baja corregible, cambia el tipo y no avisa a nadie', async () => {
    const id = await incidente({ tipo: 'codigo', mensaje: "Table 'tms_ci.auth_intentos' doesn't exist" });
    expect((await fila(id)).corregible).toBe(1);
    await db().query('RENAME TABLE auth_intentos TO auth_intentos_apartada');
    try {
      const r = await llamar('dueno', 'POST', `/api/soporte/incidentes/${id}/diagnosticar`);
      expect(r.status).toBe(200);
      const d = (await r.json()) as { categoria: string; confianza: string; corregibleConCodigo: boolean; causaConfirmada: string };
      expect(d).toMatchObject({ categoria: 'migracion', confianza: 'confirmada', corregibleConCodigo: false });
      expect(d.causaConfirmada).toMatch(/migracion_v55_/);
    } finally { await db().query('RENAME TABLE auth_intentos_apartada TO auth_intentos'); }
    const f = await fila(id);
    expect(f).toMatchObject({ corregible: 0, tipo: 'migracion', estado: 'en_diagnostico' });
    // Con la tabla de vuelta ya NO se confirma (el estado actual manda), y corregible no vuelve a subir.
    const d2 = (await (await llamar('dueno', 'POST', `/api/soporte/incidentes/${id}/diagnosticar`)).json()) as { confianza: string; causaConfirmada: string | null };
    expect(d2.confianza).toBe('probable');
    expect(d2.causaConfirmada).toBeNull();
    expect((await fila(id)).corregible).toBe(0);
    expect(pushes).toHaveLength(0);
  });

  it('"corregible" solo BAJA: un diagnóstico de código no lo sube, ni uno confirmado no corregible lo deja arriba', async () => {
    const id = await incidente({ tipo: 'codigo', mensaje: 'Cannot read properties of undefined', pila: 'Error\n    at f (src/modules/x/y.ts:10:2)', corregible: false });
    const d = await diagnosticarIncidente(id);
    expect(d).toMatchObject({ categoria: 'codigo', corregibleConCodigo: true });
    expect((await fila(id)).corregible).toBe(0); // el diagnóstico NO lo subió
    const id2 = await incidente({ tipo: 'codigo', mensaje: 'Cannot read properties of null', pila: 'Error\n    at f (src/modules/x/y.ts:11:2)' });
    await diagnosticarIncidente(id2);
    expect((await fila(id2)).corregible).toBe(1); // sigue siendo corregible
  });

  it('el código NUNCA se confirma: se ubica el archivo y línea, la confianza es "probable" y la causa confirmada queda vacía', async () => {
    const id = await incidente({ tipo: 'codigo', mensaje: 'x is not a function', pila: 'Error\n    at f (src/modules/solicitudes/solicitud.repo.ts:77:3)\n    at g (node_modules/express/lib/router.js:5:1)' });
    const d = (await diagnosticarIncidente(id))!;
    expect(d.confianza).toBe('probable');
    expect(d.causaConfirmada).toBeNull();
    expect(d.referencias).toContainEqual({ tipo: 'codigo', valor: 'src/modules/solicitudes/solicitud.repo.ts:77' });
    expect(d.borradorPublico.causaConfirmada).toBeNull();
  });

  it('CAÍDA DEL RNDC: diagnóstico sin llamar al RNDC, sin tocar la cola ni los documentos, sin leer payload/respuesta, sin cambios de código', async () => {
    const marcaPayload = `payload-${azar(5)}`; const marcaRespuesta = `respuesta-${azar(5)}`;
    for (let i = 0; i < 3; i++) {
      await db().query("INSERT INTO cola_envios (tipo_documento, payload_xml, respuesta_rndc, estado, intentos, ultimo_error) VALUES ('manifiesto', ?, ?, 'error', 3, ?)",
        [`<root><acceso><password>${marcaPayload}</password></acceso></root>`, marcaRespuesta, `diagtest: connect ECONNREFUSED al servicio del RNDC (intento ${i})`]);
    }
    await db().query("INSERT INTO cola_envios (tipo_documento, payload_xml, estado, intentos, ultimo_error) VALUES ('remesa', '<x/>', 'error', 1, 'diagtest: rechazo REC045 en la remesa')");
    const antes = await sumas();
    const id = await incidente({ tipo: 'rndc', mensaje: 'No se pudo conectar con el servicio del RNDC (ECONNREFUSED)' });
    const r = await llamar('dueno', 'POST', `/api/soporte/incidentes/${id}/diagnosticar`);
    const crudo = await r.text();
    const d = JSON.parse(crudo) as { categoria: string; confianza: string; corregibleConCodigo: boolean; hechos: { texto: string }[]; borradorPublico: Record<string, string | null> };
    expect(d).toMatchObject({ categoria: 'rndc', confianza: 'confirmada', corregibleConCodigo: false });
    expect(d.hechos.some((h) => /por falla de conexión/.test(h.texto))).toBe(true);
    expect(d.hechos.some((h) => h.texto.includes('REC045'))).toBe(true);
    expect(JSON.stringify(d.hechos)).not.toContain('�'); // el catálogo trae mojibake: se corrige
    expect(llamadasRndc).toBe(0);
    expect(await sumas()).toEqual(antes); // cola, manifiestos, remesas, solicitudes, terceros: intactos
    const [[col]] = await db().query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM cola_envios WHERE estado = 'error' AND ultimo_error LIKE '%diagtest%'");
    expect(Number(col!.n)).toBe(4); // ninguna fila reintentada ni cambiada
    const volcado = crudo + JSON.stringify(await diagnosticos(id)) + JSON.stringify(await fila(id));
    expect(volcado).not.toContain(marcaPayload);
    expect(volcado).not.toContain(marcaRespuesta);
    expect(volcado).not.toMatch(/payload_xml|respuesta_rndc|<password>/);
    expect((await fila(id)).corregible).toBe(0); // un cambio de código no lo arregla
    expect(llamadasIA).toBe(0);
    expect(pushes).toHaveLength(0);
    await db().query("DELETE FROM cola_envios WHERE ultimo_error LIKE '%diagtest%'");
  });

  it('configuración: se confirma comprobando AHORA (sin leer valores); si la variable ya está definida no se confirma', async () => {
    const original = process.env.SMTP_HOST;
    delete process.env.SMTP_HOST;
    try {
      const id = await incidente({ tipo: 'configuracion', mensaje: 'Falta configurar SMTP_HOST: no se envió el correo' });
      const d1 = (await diagnosticarIncidente(id))!;
      expect(d1).toMatchObject({ categoria: 'configuracion', confianza: 'confirmada', corregibleConCodigo: false });
      const valor = `smtp.${azar(6)}.test`;
      process.env.SMTP_HOST = valor;
      const d2 = (await diagnosticarIncidente(id))!;
      expect(d2.confianza).toBe('probable');
      expect(JSON.stringify(d2) + JSON.stringify(await diagnosticos(id))).not.toContain(valor);
    } finally { if (original === undefined) delete process.env.SMTP_HOST; else process.env.SMTP_HOST = original; }
  });

  it('proveedor de IA caído: el diagnóstico funciona SIN llamar al proveedor (y no es corregible con código)', async () => {
    const id = await incidente({ tipo: 'proveedor_ia', mensaje: 'OpenRouter HTTP 400' });
    const d = (await diagnosticarIncidente(id))!;
    expect(d).toMatchObject({ categoria: 'proveedor_ia', corregibleConCodigo: false });
    expect(llamadasIA).toBe(0);
  });

  it('un reporte de usuario se correlaciona con incidentes cercanos de la misma pantalla, solo como "posible" y solo para el propietario', async () => {
    const cerca = await incidente({ tipo: 'codigo', mensaje: 'falla en solicitudes', operacion: 'POST /api/solicitudes' });
    const rep = await incidente({ tipo: 'otro', origen: 'usuario', mensaje: 'reporte', operacion: '/solicitudes/:id/editar' });
    const d = (await diagnosticarIncidente(rep))!;
    expect(d.confianza).toBe('probable');
    expect(d.hechos.some((h) => h.texto.includes(`#${cerca}`))).toBe(true);
    expect(d.causaConfirmada).toBeNull();
  });

  it('un error del NAVEGADOR (telemetría) también se diagnostica solo, y una repetición no duplica el diagnóstico', async () => {
    const msg = `PRUEBA navegador ${azar(3).replace(/\d/g, 'z')}`;
    const enviar = () => llamar('opera', 'POST', '/api/reportes/telemetria', { tipo: 'error_js', mensaje: msg, ruta: '/pagina', pila: 'Error: x\n    at f (https://sitio.test/assets/index-abc.js:1:1)' });
    expect((await enviar()).status).toBe(204);
    let inc: RowDataPacket | undefined;
    for (let k = 0; k < 40 && !inc; k++) {
      const [r] = await db().query<RowDataPacket[]>("SELECT i.id, i.estado FROM incidentes i JOIN incidente_diagnosticos d ON d.incidente_id = i.id WHERE i.sitio = ? AND i.titulo LIKE ? LIMIT 1", [SITIO, `%${msg}%`]);
      inc = r[0]; if (!inc) await espera(100);
    }
    expect(inc, 'el diagnóstico automático no corrió para el error del navegador').toBeDefined();
    expect((await fila(inc!.id)).estado).toBe('en_diagnostico');
    expect((await enviar()).status).toBe(204);
    await espera(400);
    expect(await diagnosticos(inc!.id)).toHaveLength(1);
  });

  it('automático: un incidente NUEVO se diagnostica solo; una repetición no; una REAPERTURA sí; nunca pisa un estado que el propietario ya movió', async () => {
    falloListar = new Error(`falla diagnosticable ${azar(3).replace(/\d/g, 'z')}`);
    try { await llamar('admin', 'GET', '/api/impuestos/ica'); } finally { falloListar = null; }
    let inc: RowDataPacket | undefined;
    for (let i = 0; i < 60 && !inc; i++) { const [r] = await db().query<RowDataPacket[]>("SELECT * FROM incidentes WHERE sitio = ? AND titulo LIKE '%falla diagnosticable%'", [SITIO]); inc = r[0]; if (!inc) await espera(50); }
    expect(inc).toBeTruthy();
    for (let i = 0; i < 60 && (await diagnosticos(inc!.id)).length < 1; i++) await espera(50);
    expect(await diagnosticos(inc!.id)).toHaveLength(1);
    expect((await fila(inc!.id)).estado).toBe('en_diagnostico');
    // repetición con el mismo mensaje → no hay otro diagnóstico
    falloListar = new Error(String(inc!.titulo).split(': ').slice(1).join(': ')); // mismo mensaje normalizado
    try { await llamar('admin', 'GET', '/api/impuestos/ica'); } finally { falloListar = null; }
    await espera(400);
    expect(await diagnosticos(inc!.id)).toHaveLength(1);
    // el propietario mueve el estado; una reapertura vuelve a diagnosticar pero NO pisa su estado
    await db().query("UPDATE incidentes SET estado = 'verificado' WHERE id = ?", [inc!.id]);
    falloListar = new Error(String(inc!.titulo).split(': ').slice(1).join(': '));
    try { await llamar('admin', 'GET', '/api/impuestos/ica'); } finally { falloListar = null; }
    for (let i = 0; i < 60 && (await diagnosticos(inc!.id)).length < 2; i++) await espera(50);
    expect((await diagnosticos(inc!.id)).length).toBe(2);
    expect((await fila(inc!.id)).estado).toBe('en_diagnostico'); // se reabrió (nuevo) y el diagnóstico automático lo pasó a en_diagnostico
    await db().query("UPDATE incidentes SET estado = 'corrigiendo' WHERE id = ?", [inc!.id]);
    await diagnosticarIncidente(inc!.id);
    expect((await fila(inc!.id)).estado).toBe('corrigiendo'); // el propietario mandó: no se pisa
    expect(pushes.every((p) => p.ids.length === 1 && p.ids[0] === ids.dueno)).toBe(true); // solo avisos técnicos al propietario
  });

  it('solo el propietario diagnostica y aplica borradores (otro admin y un operador reciben 403); y se conservan los últimos 5', async () => {
    const id = await incidente({ tipo: 'infraestructura', mensaje: 'ENOSPC no space left' });
    for (const quien of ['admin', 'opera']) {
      expect((await llamar(quien, 'POST', `/api/soporte/incidentes/${id}/diagnosticar`)).status, quien).toBe(403);
      expect((await llamar(quien, 'POST', `/api/soporte/incidentes/${id}/diagnosticos/1/aplicar`, {})).status, quien).toBe(403);
    }
    for (let i = 0; i < 7; i++) await llamar('dueno', 'POST', `/api/soporte/incidentes/${id}/diagnosticar`);
    expect((await diagnosticos(id)).length).toBe(5);
    expect((await llamar('dueno', 'POST', '/api/soporte/incidentes/99999999/diagnosticar')).status).toBe(404);
  });

  it('aplicar el borrador: texto de PLANTILLAS (no de lo guardado), causa confirmada solo si es "confirmada", sin pisar lo escrito, sin avisar', async () => {
    const id = await incidente({ tipo: 'configuracion', mensaje: 'Falta configurar SMTP_PASS' });
    const original = process.env.SMTP_PASS; delete process.env.SMTP_PASS;
    let d: { id: number };
    try { d = (await diagnosticarIncidente(id))!; } finally { if (original !== undefined) process.env.SMTP_PASS = original; }
    // Manipular lo guardado no cambia lo público: el borrador sale de plantillas por categoría/confianza.
    await db().query('UPDATE incidente_diagnosticos SET resumen = ?, posible_causa = ?, siguiente_paso = ? WHERE id = ?', ['TEXTO-INYECTADO-/etc/passwd', 'otra cosa', 'src/secreto.ts', d.id]);
    await db().query("UPDATE incidentes SET exp_hecho = 'Lo escribió el propietario.' WHERE id = ?", [id]);
    const r = await llamar('dueno', 'POST', `/api/soporte/incidentes/${id}/diagnosticos/${d.id}/aplicar`, {});
    expect(r.status).toBe(200);
    expect(((await r.json()) as { campos: string[] }).campos.sort()).toEqual(['accionTemporal', 'causaConfirmada', 'estadoCorreccion']);
    const f = await fila(id);
    expect(f.exp_hecho).toBe('Lo escribió el propietario.'); // no se pisó
    expect(f.exp_causa_confirmada).toMatch(/configuración de este sitio/);
    expect(f.exp_posible_causa).toBeNull(); // confirmada: no hay "posible causa"
    const publico = [f.exp_hecho, f.exp_posible_causa, f.exp_causa_confirmada, f.exp_accion_temporal, f.exp_estado_correccion].join(' ');
    expect(publico).not.toMatch(/INYECTADO|passwd|secreto|SMTP_|\.ts|\//);
    expect(pushes).toHaveLength(0);
    // con sobrescribir sí reemplaza
    await llamar('dueno', 'POST', `/api/soporte/incidentes/${id}/diagnosticos/${d.id}/aplicar`, { sobrescribir: true });
    expect((await fila(id)).exp_hecho).toBe('Una función de la aplicación no pudo completarse.');
    expect((await llamar('dueno', 'POST', `/api/soporte/incidentes/${id}/diagnosticos/${d.id}/aplicar`, { sobrescribir: true, texto: 'x' })).status).toBe(400); // el navegador no manda texto
    const [ev] = await db().query<RowDataPacket[]>("SELECT tipo FROM incidente_eventos WHERE incidente_id = ? AND tipo = 'diagnostico_aplicado'", [id]);
    expect(ev.length).toBeGreaterThanOrEqual(2);
  });

  it('un diagnóstico NO confirmado nunca llena "causa confirmada" al aplicarse, y el usuario ve solo el texto de plantilla', async () => {
    const id = await incidente({ tipo: 'codigo', mensaje: 'x', pila: 'Error\n    at f (src/modules/a/b.ts:5:1)' });
    const d = (await diagnosticarIncidente(id))!;
    await llamar('dueno', 'POST', `/api/soporte/incidentes/${id}/diagnosticos/${d.id}/aplicar`, {});
    const f = await fila(id);
    expect(f.exp_causa_confirmada).toBeNull();
    expect(f.exp_posible_causa).toBe('Un error en la aplicación.');
  });

  it('los datos del detalle del propietario incluyen los diagnósticos; los usuarios nunca los ven', async () => {
    const id = await incidente({ tipo: 'infraestructura', mensaje: 'ECONNRESET' });
    await diagnosticarIncidente(id);
    const det = (await (await llamar('dueno', 'GET', `/api/soporte/incidentes/${id}`)).json()) as { diagnosticos: { categoria: string; hechos: unknown[] }[] };
    expect(det.diagnosticos[0]).toMatchObject({ categoria: 'infraestructura' });
    expect(det.diagnosticos[0]!.hechos.length).toBeGreaterThan(0);
    const [[rep]] = await db().query<RowDataPacket[]>('SELECT 1 AS x');
    void rep;
    expect((await llamar('opera', 'GET', `/api/soporte/incidentes/${id}`)).status).toBe(403);
  });

  it('la sesión de lectura del diagnóstico es de SOLO LECTURA: una escritura dentro de ella falla (1792)', async () => {
    await expect(leerSoloLectura((c) => c.query("INSERT INTO incidente_eventos (incidente_id, tipo) VALUES (0, 'x-ro')"))).rejects.toMatchObject({ errno: 1792 });
    await expect(leerSoloLectura((c) => c.query("UPDATE cola_envios SET estado = estado WHERE id = 0"))).rejects.toMatchObject({ errno: 1792 });
  });
});
