/**
 * Solicitud interna: "nada viaja al RNDC" también como barrera, no solo por el
 * flujo de despacho. Si por un error futuro algo intentara encolar o enviar un
 * documento de una solicitud interna, debe fallar de forma ruidosa:
 * - encolar (cualquier camino pasa por insertarCola) lanza un error;
 * - si una fila ya estuviera en la cola, procesarla o drenarla NO llama al RNDC.
 *
 * Base MySQL/MariaDB REAL de pruebas; el cliente RNDC es falso y cuenta envíos:
 *   TEST_DB=1 DB_HOST=127.0.0.1 DB_NAME=tms_test DB_USER=... DB_PASS=... npx vitest run test/interna_guardas.db.test.ts
 * Sin TEST_DB=1 se omite. NUNCA apuntar a producción.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';

const RUN = process.env.TEST_DB === '1';
process.env.COLA_ENVIO_HABILITADO = 'true';

const envios: string[] = [];
vi.mock('../src/rndc/RndcClient.js', async () => {
  const { RndcRespuesta } = await import('../src/rndc/RndcRespuesta.js');
  return {
    RndcClient: {
      desdeConfig: async () => ({
        ingresarXml: async (_p: number, xml: string) => {
          envios.push(xml);
          return RndcRespuesta.exito('999', 200, '<ok/>');
        },
        previewXmlInterno: () => '<preview/>',
      }),
    },
  };
});

const { db } = await import('../src/db/pool.js');
const cola = await import('../src/modules/cola/cola.repo.js');

let solicitudId = 0;
let manifiestoId = 0;
let remesaId = 0;

describe.skipIf(!RUN)('solicitud interna: barreras contra el envío al RNDC', () => {
  beforeAll(async () => {
    const [s] = await db().query<ResultSetHeader>(
      "INSERT INTO solicitud_servicio (fecha_solicitud, cantidad_vehiculos, cantidad_vehiculos_original, estado, interna) VALUES (CURDATE(), 0, 1, 'despachada', 1)",
    );
    solicitudId = s.insertId;
    const [m] = await db().query<ResultSetHeader>(
      "INSERT INTO manifiesto (solicitud_id, num_manifiesto, estado_rndc) VALUES (?, ?, 'interno')",
      [solicitudId, `INT-M-G${solicitudId}`],
    );
    manifiestoId = m.insertId;
    const [r] = await db().query<ResultSetHeader>(
      "INSERT INTO remesa (solicitud_id, num_remesa, estado_rndc, peso) VALUES (?, ?, 'interno', 10)",
      [solicitudId, `INT-R-G${solicitudId}`],
    );
    remesaId = r.insertId;
    await db().query('INSERT INTO manifiesto_remesa (manifiesto_id, remesa_id) VALUES (?, ?)', [manifiestoId, remesaId]);
  });

  afterAll(async () => {
    await db().query('DELETE FROM cola_envios WHERE solicitud_id = ?', [solicitudId]);
    await db().query('DELETE FROM remesa WHERE solicitud_id = ?', [solicitudId]);
    await db().query('DELETE FROM manifiesto WHERE solicitud_id = ?', [solicitudId]);
    await db().query('DELETE FROM solicitud_servicio WHERE id = ?', [solicitudId]);
    await db().end();
  });

  it('encolar el cumplido de una solicitud interna lanza un error y no deja filas', async () => {
    await expect(cola.encolarCumplido(db(), solicitudId, manifiestoId, [remesaId])).rejects.toThrow(/interna/i);
    const [[n]] = await db().query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM cola_envios WHERE solicitud_id = ?', [solicitudId]);
    expect(Number(n!.n)).toBe(0);
  });

  it('encolar el despacho de una solicitud interna también lanza un error', async () => {
    await expect(cola.encolar(db(), solicitudId, manifiestoId, [remesaId])).rejects.toThrow(/interna/i);
  });

  it('una fila que se colara en la cola no llega al RNDC (procesarla)', async () => {
    const [c] = await db().query<ResultSetHeader>(
      `INSERT INTO cola_envios (solicitud_id, manifiesto_id, tipo_documento, referencia_id, proceso_rndc, orden, payload_xml, estado)
       VALUES (?, ?, 'remesa', ?, 3, 30, '<x>fuga</x>', 'pendiente')`,
      [solicitudId, manifiestoId, remesaId],
    );
    envios.length = 0;
    await cola.procesarItem(c.insertId);
    expect(envios).toHaveLength(0);
    const [[f]] = await db().query<RowDataPacket[]>('SELECT estado FROM cola_envios WHERE id = ?', [c.insertId]);
    expect(f!.estado).not.toBe('enviado');
    await db().query('DELETE FROM cola_envios WHERE id = ?', [c.insertId]);
  });

  it('una fila que se colara en la cola no llega al RNDC (drenar y procesar el despacho)', async () => {
    const [c] = await db().query<ResultSetHeader>(
      `INSERT INTO cola_envios (solicitud_id, manifiesto_id, tipo_documento, referencia_id, proceso_rndc, orden, payload_xml, estado)
       VALUES (?, ?, 'manifiesto', ?, 4, 40, '<x>fuga</x>', 'pendiente')`,
      [solicitudId, manifiestoId, manifiestoId],
    );
    envios.length = 0;
    await cola.drenar();
    await cola.procesarDespacho(manifiestoId);
    expect(envios).toHaveLength(0);
    const [[f]] = await db().query<RowDataPacket[]>('SELECT estado FROM cola_envios WHERE id = ?', [c.insertId]);
    expect(f!.estado).not.toBe('enviado');
    await db().query('DELETE FROM cola_envios WHERE id = ?', [c.insertId]);
  });
});
