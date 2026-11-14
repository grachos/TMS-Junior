/**
 * La clave del RNDC no debe quedar guardada en la cola ni salir por "Ver XML":
 * - Modo seguro: la previsualización que se guarda en respuesta_rndc va enmascarada.
 * - GET /api/cola/:id/xml la muestra enmascarada.
 * - migracion_v51 limpia filas guardadas antes del arreglo (y es repetible).
 *
 * Base MySQL/MariaDB REAL de pruebas (modifica maestro_empresa y la restaura):
 *   TEST_DB=1 DB_HOST=127.0.0.1 DB_NAME=tms_test DB_USER=... DB_PASS=... npx vitest run test/cola_clave.db.test.ts
 * Sin TEST_DB=1 se omite. NUNCA apuntar a producción.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';

const RUN = process.env.TEST_DB === '1';
process.env.COLA_ENVIO_HABILITADO = 'false'; // modo seguro: solo previsualiza

const { db } = await import('../src/db/pool.js');
const cola = await import('../src/modules/cola/cola.repo.js');

const secreto = `k-${randomBytes(9).toString('hex')}`;
const solicitudId = 910_000_000 + (Date.now() % 1_000_000);
let claveOriginal: string | null = null;

async function filaCola(respuesta: string | null = null): Promise<number> {
  const [r] = await db().query<ResultSetHeader>(
    `INSERT INTO cola_envios (solicitud_id, tipo_documento, referencia_id, proceso_rndc, orden, payload_xml, estado, respuesta_rndc)
     VALUES (?, 'remesa', 0, 3, 30, '<CONSECUTIVOREMESA>1</CONSECUTIVOREMESA>', 'pendiente', ?)`,
    [solicitudId, respuesta],
  );
  return r.insertId;
}
const respuestaDe = async (id: number) =>
  String((await db().query<RowDataPacket[]>('SELECT respuesta_rndc FROM cola_envios WHERE id = ?', [id]))[0][0]!.respuesta_rndc);

describe.skipIf(!RUN)('cola: la clave del RNDC no se guarda ni se muestra', () => {
  beforeAll(async () => {
    const [[e]] = await db().query<RowDataPacket[]>('SELECT rndc_password FROM maestro_empresa WHERE id = 1');
    claveOriginal = (e?.rndc_password as string | null) ?? null;
    await db().query('UPDATE maestro_empresa SET rndc_password = ? WHERE id = 1', [secreto]);
  });
  afterAll(async () => {
    await db().query('DELETE FROM cola_envios WHERE solicitud_id = ?', [solicitudId]);
    await db().query('UPDATE maestro_empresa SET rndc_password = ? WHERE id = 1', [claveOriginal]);
    await db().end();
  });

  it('el modo seguro guarda la previsualización con la clave enmascarada', async () => {
    const id = await filaCola();
    await cola.drenar();
    const r = await respuestaDe(id);
    expect(r).toContain('<password>********</password>');
    expect(r).not.toContain(secreto);
  });

  it('"Ver XML" muestra la clave enmascarada', async () => {
    const id = await filaCola();
    const { text } = await cola.xmlDe(id);
    expect(text).toContain('<password>********</password>');
    expect(text).not.toContain(secreto);
  });

  it('migracion_v51 limpia una previsualización vieja con la clave, y es repetible', async () => {
    const id = await filaCola(`<root><acceso><username>u</username><password>${secreto}</password></acceso></root>`);
    const sql = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'database', 'migracion_v51_ocultar_clave_rndc.sql'), 'utf8');
    const sentencia = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim().replace(/;$/, '');
    await db().query(sentencia);
    await db().query(sentencia);
    const r = await respuestaDe(id);
    expect(r).toBe('<root><acceso><username>u</username><password>********</password></acceso></root>');
  });
});
