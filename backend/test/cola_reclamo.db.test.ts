/**
 * Hallazgo #2 (blindaje transaccional): una fila de cola_envios no debe
 * enviarse dos veces al RNDC cuando el cron (drenar) y un clic en "Procesar"
 * (procesarItem) — o dos drenar — corren a la vez.
 *
 * Corre contra una base MySQL/MariaDB REAL de pruebas (crea y borra filas):
 *   TEST_DB=1 DB_HOST=127.0.0.1 DB_NAME=tms_test DB_USER=... DB_PASS=... npx vitest run test/cola_reclamo.db.test.ts
 * Sin TEST_DB=1 se omite. NUNCA apuntar a producción.
 *
 * El cliente RNDC se reemplaza por uno falso que cuenta los envíos y tarda
 * 150 ms (como una llamada real), para que las peticiones se solapen.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const RUN = process.env.TEST_DB === '1';
process.env.COLA_ENVIO_HABILITADO = 'true';

const envios: number[] = [];

vi.mock('../src/rndc/RndcClient.js', async () => {
  const { RndcRespuesta } = await import('../src/rndc/RndcRespuesta.js');
  return {
    RndcClient: {
      desdeConfig: async () => ({
        ingresarXml: async (_proceso: number, xml: string) => {
          envios.push(Number(/fila=(\d+)/.exec(xml)?.[1] ?? 0));
          await new Promise((r) => setTimeout(r, 150));
          return RndcRespuesta.exito('999', 200, '<ok/>');
        },
      }),
    },
  };
});

const { db } = await import('../src/db/pool.js');
const cola = await import('../src/modules/cola/cola.repo.js');

// Solicitud ficticia por corrida: dependenciaPendiente() solo mira esta solicitud.
const solicitudId = 900_000_000 + (Date.now() % 1_000_000);

async function crearFila(): Promise<number> {
  const [res] = await db().query<import('mysql2').ResultSetHeader>(
    `INSERT INTO cola_envios (solicitud_id, manifiesto_id, tipo_documento, referencia_id, proceso_rndc, orden, payload_xml, estado)
     VALUES (?, NULL, 'remesa', 0, 3, 30, '', 'pendiente')`,
    [solicitudId],
  );
  await db().query('UPDATE cola_envios SET payload_xml = ? WHERE id = ?', [`<x>fila=${res.insertId}</x>`, res.insertId]);
  return res.insertId;
}

const enviosDe = (id: number) => envios.filter((e) => e === id).length;

describe.skipIf(!RUN)('cola_envios: reclamo atómico antes de enviar al RNDC', () => {
  beforeEach(async () => {
    envios.length = 0;
    await db().query('DELETE FROM cola_envios WHERE solicitud_id = ?', [solicitudId]);
  });

  afterAll(async () => {
    await db().query('DELETE FROM cola_envios WHERE solicitud_id = ?', [solicitudId]);
    await db().end();
  });

  it('dos clics en "Procesar" a la vez envían la fila una sola vez', async () => {
    const id = await crearFila();
    const r = await Promise.all([cola.procesarItem(id), cola.procesarItem(id)]);
    expect(enviosDe(id)).toBe(1);
    expect(r.filter((x) => x.ok)).toHaveLength(1);
  });

  it('el cron (drenar) y un clic en "Procesar" a la vez envían la fila una sola vez', async () => {
    const id = await crearFila();
    await Promise.all([cola.drenar(), cola.procesarItem(id)]);
    expect(enviosDe(id)).toBe(1);
  });

  it('dos drenar simultáneos envían cada fila una sola vez', async () => {
    const ids = [await crearFila(), await crearFila(), await crearFila()];
    await Promise.all([cola.drenar(), cola.drenar()]);
    for (const id of ids) expect(enviosDe(id)).toBe(1);
  });

  it('la fila queda enviada con su ingreso', async () => {
    const id = await crearFila();
    await cola.procesarItem(id);
    const [rows] = await db().query<import('mysql2').RowDataPacket[]>(
      'SELECT estado, rndc_ingreso_id, intentos FROM cola_envios WHERE id = ?',
      [id],
    );
    expect(rows[0]).toMatchObject({ estado: 'enviado', rndc_ingreso_id: '999', intentos: 1 });
  });
});
