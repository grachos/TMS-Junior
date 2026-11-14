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

  // Hallazgo #5: si el proceso muere a mitad del envío, la fila queda en
  // 'enviando' para siempre. drenar() debe recuperarla pasado el umbral.
  async function atascar(id: number, minutosAtras: number, intentos = 0): Promise<void> {
    await db().query(
      `UPDATE cola_envios SET estado = 'enviando', intentos = ?, updated_at = NOW() - INTERVAL ? MINUTE WHERE id = ?`,
      [intentos, minutosAtras, id],
    );
  }
  async function leer(id: number) {
    const [rows] = await db().query<import('mysql2').RowDataPacket[]>(
      'SELECT estado, intentos, ultimo_error FROM cola_envios WHERE id = ?',
      [id],
    );
    return rows[0]!;
  }

  it('una fila atascada en "enviando" (proceso caído) se recupera y se envía en el siguiente drenar', async () => {
    const id = await crearFila();
    await atascar(id, 30);
    const r = await cola.drenar();
    expect(enviosDe(id)).toBe(1);
    expect(r.recuperados).toBe(1);
    expect(await leer(id)).toMatchObject({ estado: 'enviado', intentos: 2 }); // el intento interrumpido cuenta
  });

  it('una fila que se está enviando ahora mismo (reciente) no se toca', async () => {
    const id = await crearFila();
    await atascar(id, 1);
    await cola.drenar();
    expect(enviosDe(id)).toBe(0);
    expect(await leer(id)).toMatchObject({ estado: 'enviando' });
  });

  it('si el intento interrumpido era el último, queda en error visible y no se reenvía', async () => {
    const id = await crearFila();
    await atascar(id, 30, 9); // max_intentos = 10
    await cola.drenar();
    expect(enviosDe(id)).toBe(0);
    const f = await leer(id);
    expect(f).toMatchObject({ estado: 'error', intentos: 10 });
    expect(String(f.ultimo_error)).toMatch(/interrumpid/i);
  });

  it('dos drenar a la vez recuperan y envían la fila atascada una sola vez', async () => {
    const id = await crearFila();
    await atascar(id, 30);
    await Promise.all([cola.drenar(), cola.drenar()]);
    expect(enviosDe(id)).toBe(1);
  });

  // Hallazgo #8: marcar la fila 'enviado' y el documento origen ('aceptado')
  // debe ser atómico. Si la segunda escritura falla, antes quedaba la cola en
  // 'enviado' y la remesa en 'pendiente' para siempre.
  it('si falla marcar el documento origen, la fila NO queda "enviado" y se recupera luego', async () => {
    const [s] = await db().query<import('mysql2').ResultSetHeader>(
      "INSERT INTO solicitud_servicio (fecha_solicitud, cantidad_vehiculos, cantidad_vehiculos_original, estado) VALUES (CURDATE(), 0, 1, 'procesada')",
    );
    const [r] = await db().query<import('mysql2').ResultSetHeader>(
      "INSERT INTO remesa (solicitud_id, num_remesa, estado_rndc) VALUES (?, ?, 'pendiente')",
      [s.insertId, `REM-ATOM-${s.insertId}`],
    );
    const [c] = await db().query<import('mysql2').ResultSetHeader>(
      `INSERT INTO cola_envios (solicitud_id, manifiesto_id, tipo_documento, referencia_id, proceso_rndc, orden, payload_xml, estado)
       VALUES (?, NULL, 'remesa', ?, 3, 30, '<x>fila=0</x>', 'pendiente')`,
      [solicitudId, r.insertId],
    );
    const trigger = `falla_remesa_${r.insertId}`;
    await db().query(
      `CREATE TRIGGER ${trigger} BEFORE UPDATE ON remesa FOR EACH ROW
       BEGIN IF NEW.id = ${r.insertId} AND NEW.estado_rndc = 'aceptado' THEN
         SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'falla simulada al marcar la remesa'; END IF; END`,
    );
    try {
      await expect(cola.procesarItem(c.insertId)).rejects.toThrow(/falla simulada/);
      const [[fila]] = await db().query<import('mysql2').RowDataPacket[]>('SELECT estado FROM cola_envios WHERE id = ?', [c.insertId]);
      expect(fila!.estado).toBe('enviando'); // no 'enviado': el cambio se revirtió junto con el de la remesa
    } finally {
      await db().query(`DROP TRIGGER IF EXISTS ${trigger}`);
    }

    // La recuperación de #5 la reenvía (el RNDC respondería DUPLICADO) y ahora sí queda todo consistente.
    await db().query("UPDATE cola_envios SET updated_at = NOW() - INTERVAL 30 MINUTE WHERE id = ?", [c.insertId]);
    await cola.drenar();
    const [[fila]] = await db().query<import('mysql2').RowDataPacket[]>('SELECT estado FROM cola_envios WHERE id = ?', [c.insertId]);
    const [[rem]] = await db().query<import('mysql2').RowDataPacket[]>('SELECT estado_rndc FROM remesa WHERE id = ?', [r.insertId]);
    expect(fila!.estado).toBe('enviado');
    expect(rem!.estado_rndc).toBe('aceptado');

    await db().query('DELETE FROM remesa WHERE id = ?', [r.insertId]);
    await db().query('DELETE FROM solicitud_servicio WHERE id = ?', [s.insertId]);
  });
});
