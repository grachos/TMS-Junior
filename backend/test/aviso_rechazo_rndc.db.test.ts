/**
 * Aviso al soporte AL MOMENTO del rechazo del Ministerio: si el error no está en el diccionario se registra un incidente `rndc`
 * (uno por error, sin repetirse en 10 min); si está, o no trae código (falla de conexión), no se avisa. Base REAL; cliente RNDC falso.
 *   TEST_DB=1 DB_HOST=127.0.0.1 DB_NAME=tms_test DB_USER=... DB_PASS=... npx vitest run test/aviso_rechazo_rndc.db.test.ts
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';

const RUN = process.env.TEST_DB === '1';
process.env.COLA_ENVIO_HABILITADO = 'true';
process.env.SITE_ID = 'sitio-test-rechazo';

let mensajeDelMinisterio = '';
vi.mock('../src/rndc/RndcClient.js', async () => {
  const { RndcRespuesta } = await import('../src/rndc/RndcRespuesta.js');
  return { RndcClient: { desdeConfig: async () => ({ ingresarXml: async () => RndcRespuesta.fallo(mensajeDelMinisterio, 200, '<error/>') }) } };
});

const { db } = await import('../src/db/pool.js');
const cola = await import('../src/modules/cola/cola.repo.js');
const { reiniciarRechazosRecientes } = await import('../src/modules/chat/avisoErrorSinGuia.js');

const solicitudId = 900_000_000 + (Date.now() % 1_000_000);
const sufijo = () => String(Math.floor(Math.random() * 900) + 100);
const codigosCreados: string[] = [];

async function rechazar(mensaje: string): Promise<void> {
  mensajeDelMinisterio = mensaje;
  const [r] = await db().query<ResultSetHeader>(
    "INSERT INTO cola_envios (solicitud_id, manifiesto_id, tipo_documento, referencia_id, proceso_rndc, orden, payload_xml, estado) VALUES (?, NULL, 'remesa', 0, 3, 30, '<x/>', 'pendiente')", [solicitudId]);
  await cola.procesarItem(r.insertId);
}
const incidentes = async (codigo: string) => (await db().query<RowDataPacket[]>("SELECT id, ocurrencias, corregible, tipo FROM incidentes WHERE sitio = ? AND tipo = 'rndc' AND codigo = ?", [process.env.SITE_ID, codigo]))[0];
/** El aviso no espera (fire-and-forget): se sondea hasta que aparezca o se agote el tiempo. */
async function esperarIncidente(codigo: string): Promise<RowDataPacket[]> {
  for (let i = 0; i < 40; i++) { const r = await incidentes(codigo); if (r.length) return r; await new Promise((x) => setTimeout(x, 50)); }
  return [];
}

describe.skipIf(!RUN)('aviso al soporte al momento del rechazo del Ministerio', () => {
  beforeEach(() => { reiniciarRechazosRecientes(); });
  afterAll(async () => {
    await db().query('DELETE FROM cola_envios WHERE solicitud_id = ?', [solicitudId]);
    for (const c of codigosCreados) await db().query("DELETE FROM incidentes WHERE sitio = ? AND codigo = ?", [process.env.SITE_ID, c]);
    await db().end();
  });

  it('un error que el diccionario no tiene crea UN incidente rndc no corregible, aunque el rechazo se repita', async () => {
    const codigo = `QZY${sufijo()}`; codigosCreados.push(codigo);
    await rechazar(`${codigo} regla nueva que el Ministerio acaba de publicar`);
    const inc = await esperarIncidente(codigo);
    expect(inc).toHaveLength(1);
    expect(Number(inc[0]!.corregible)).toBe(0);
    await rechazar(`${codigo} regla nueva que el Ministerio acaba de publicar`); // reintento: no se vuelve a avisar
    await new Promise((x) => setTimeout(x, 300));
    expect(Number((await incidentes(codigo))[0]!.ocurrencias)).toBe(1);
  });

  it('un error que SÍ está en el diccionario no avisa a nadie', async () => {
    await rechazar('MAN045 La Empresa de Transporte únicamente podrá expedir Manifiestos de Carga que registren un valor a pagar igual o superior a los costos eficientes de operación de SiceTac.');
    await new Promise((x) => setTimeout(x, 300));
    expect(await incidentes('MAN045')).toHaveLength(0);
  });

  it('una falla de conexión (sin código del Ministerio) no avisa', async () => {
    const antes = (await db().query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM incidentes WHERE sitio = ? AND tipo = 'rndc'", [process.env.SITE_ID]))[0][0]!.n;
    await rechazar('Error de conexión: ETIMEDOUT');
    await new Promise((x) => setTimeout(x, 300));
    const despues = (await db().query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM incidentes WHERE sitio = ? AND tipo = 'rndc'", [process.env.SITE_ID]))[0][0]!.n;
    expect(Number(despues)).toBe(Number(antes));
  });

  it('un código conocido con un significado nuevo también avisa (variante nueva)', async () => {
    codigosCreados.push('MAN055');
    await rechazar('MAN055 xilófono quimera tambor lunático');
    expect((await esperarIncidente('MAN055')).length).toBeGreaterThanOrEqual(1);
  });

  it('el aviso está conectado en los tres puntos donde se guarda un rechazo (cola, terceros, vehículos)', () => {
    for (const f of ['cola/cola.repo.ts', 'terceros/tercero.repo.ts', 'vehiculos/vehiculo.repo.ts']) {
      expect(readFileSync(new URL(`../src/modules/${f}`, import.meta.url), 'utf8'), f).toMatch(/revisarRechazoRndc\(resp\.error\)/);
    }
  });
});
