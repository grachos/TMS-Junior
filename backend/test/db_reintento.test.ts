/**
 * Conexiones cortadas por el servidor o un intermediario (ECONNRESET): las LECTURAS se repiten una vez; las escrituras no.
 * La primera parte no necesita base de datos; la segunda prueba withTransaction / leerSoloLectura contra una base real.
 *   TEST_DB=1 DB_HOST=... DB_NAME=... DB_USER=... DB_PASS=... npx vitest run test/db_reintento.test.ts
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';

const RUN = process.env.TEST_DB === '1';
const { conReintentoDeLectura, esErrorDeConexion, esLectura, db, leerSoloLectura, withTransaction } = await import('../src/db/pool.js');
const cortada = (codigo = 'ECONNRESET') => Object.assign(new Error(`read ${codigo}`), { code: codigo });

describe('esLectura / esErrorDeConexion', () => {
  it('solo las lecturas puras se pueden repetir', () => {
    for (const q of ['SELECT 1', '  select * from t where id = ?', 'SHOW TABLES', 'DESCRIBE t', 'EXPLAIN SELECT 1', { sql: 'SELECT 1' }]) expect(esLectura(q), JSON.stringify(q)).toBe(true);
    for (const q of ['INSERT INTO t VALUES (1)', 'UPDATE t SET a = 1', 'DELETE FROM t', 'CALL p()', 'SET @a = 1', 'START TRANSACTION', 'COMMIT', 'REPLACE INTO t VALUES (1)',
      'SELECT * FROM t FOR UPDATE', 'SELECT * FROM t LOCK IN SHARE MODE', "SELECT GET_LOCK('x', 1)", 'SELECT SLEEP(1)', "SELECT 1 INTO OUTFILE '/tmp/x'", 'SELECT 1; DELETE FROM t', 'SELECT NEXTVAL(s)',
      'WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x', '', undefined, null, 5, {}]) expect(esLectura(q), JSON.stringify(q)).toBe(false);
  });
  it('solo los errores de conexión cortada cuentan', () => {
    for (const c of ['ECONNRESET', 'EPIPE', 'PROTOCOL_CONNECTION_LOST']) expect(esErrorDeConexion(cortada(c))).toBe(true);
    for (const e of [new Error('x'), cortada('ER_DUP_ENTRY'), cortada('ECONNREFUSED'), cortada('ETIMEDOUT'), { errno: 1213 }, null, undefined]) expect(esErrorDeConexion(e)).toBe(false);
  });
});

describe('conReintentoDeLectura (pool simulado)', () => {
  const crear = (respuestas: (() => unknown)[]) => {
    const query = vi.fn(async () => { const r = respuestas.shift(); if (!r) throw new Error('sin respuesta'); return r(); });
    const getConnection = vi.fn(async () => 'conexion');
    return { query, execute: query, getConnection, propio: 7 } as unknown as Pool & { query: typeof query; getConnection: typeof getConnection; propio: number };
  };

  it('una lectura cortada se repite UNA vez y devuelve el resultado', async () => {
    const p = crear([() => { throw cortada(); }, () => [[{ n: 1 }]]]);
    expect(await conReintentoDeLectura(p).query('SELECT 1')).toEqual([[{ n: 1 }]]);
    expect(p.query).toHaveBeenCalledTimes(2);
    const p2 = crear([() => { throw cortada('EPIPE'); }, () => 'ok']);
    expect(await conReintentoDeLectura(p2).execute({ sql: 'SELECT ?' })).toBe('ok');
  });
  it('si vuelve a fallar, el error sale (no hay bucle): exactamente 2 intentos', async () => {
    const p = crear([() => { throw cortada(); }, () => { throw cortada(); }, () => 'no debe llegar']);
    await expect(conReintentoDeLectura(p).query('SELECT 1')).rejects.toMatchObject({ code: 'ECONNRESET' });
    expect(p.query).toHaveBeenCalledTimes(2);
  });
  it('una ESCRITURA nunca se repite (no se sabe si se aplicó)', async () => {
    for (const q of ['INSERT INTO t VALUES (1)', 'UPDATE t SET a = 1', 'SELECT * FROM t FOR UPDATE', 'DELETE FROM t']) {
      const p = crear([() => { throw cortada(); }, () => 'no debe llegar']);
      await expect(conReintentoDeLectura(p).query(q), q).rejects.toMatchObject({ code: 'ECONNRESET' });
      expect(p.query, q).toHaveBeenCalledTimes(1);
    }
  });
  it('otros errores (clave duplicada, sintaxis, deadlock) no se repiten', async () => {
    for (const e of [cortada('ER_DUP_ENTRY'), cortada('ER_PARSE_ERROR'), Object.assign(new Error('dl'), { errno: 1213 })]) {
      const p = crear([() => { throw e; }, () => 'no debe llegar']);
      await expect(conReintentoDeLectura(p).query('SELECT 1')).rejects.toBe(e);
      expect(p.query).toHaveBeenCalledTimes(1);
    }
  });
  it('lo demás del pool sigue funcionando (getConnection, propiedades)', async () => {
    const p = crear([]);
    const w = conReintentoDeLectura(p);
    expect(await w.getConnection()).toBe('conexion');
    expect((w as unknown as { propio: number }).propio).toBe(7);
  });
});

describe.skipIf(!RUN)('transacciones con conexión cortada (base real)', () => {
  afterAll(async () => { await db().end(); });

  it('leerSoloLectura repite UNA vez si la conexión se corta; con otro error no', async () => {
    let n = 0;
    expect(await leerSoloLectura(async (c) => { n += 1; if (n === 1) throw cortada(); const [[r]] = await c.query('SELECT 7 AS x'); return (r as { x: number }).x; })).toBe(7);
    expect(n).toBe(2);
    let m = 0;
    await expect(leerSoloLectura(async () => { m += 1; throw cortada(); })).rejects.toMatchObject({ code: 'ECONNRESET' });
    expect(m).toBe(2);
    let k = 0;
    await expect(leerSoloLectura(async () => { k += 1; throw new Error('otro'); })).rejects.toThrow('otro');
    expect(k).toBe(1);
  });

  it('withTransaction repite UNA vez la transacción entera si la conexión se corta ANTES del commit', async () => {
    let n = 0;
    expect(await withTransaction(async (c) => { n += 1; if (n === 1) throw cortada(); const [[r]] = await c.query('SELECT 5 AS x'); return (r as { x: number }).x; })).toBe(5);
    expect(n).toBe(2);
    let m = 0;
    await expect(withTransaction(async () => { m += 1; throw cortada(); })).rejects.toMatchObject({ code: 'ECONNRESET' });
    expect(m).toBe(2);
  });

  it('si la conexión se corta DURANTE el commit NO se repite (no se sabe si se aplicó)', async () => {
    let n = 0;
    await expect(withTransaction(async (c) => { n += 1; c.commit = async () => { throw cortada(); }; return 1; })).rejects.toMatchObject({ code: 'ECONNRESET' });
    expect(n).toBe(1);
  });

  it('el deadlock sigue reintentándose como antes y un error común no se repite', async () => {
    let d = 0;
    expect(await withTransaction(async () => { d += 1; if (d === 1) throw Object.assign(new Error('deadlock'), { errno: 1213 }); return 'ok'; })).toBe('ok');
    expect(d).toBe(2);
    let o = 0;
    await expect(withTransaction(async () => { o += 1; throw new Error('negocio'); })).rejects.toThrow('negocio');
    expect(o).toBe(1);
  });

  it('una lectura por el pool principal funciona igual (el envoltorio no la rompe)', async () => {
    const [rows] = await db().query('SELECT 1 AS uno');
    expect((rows as { uno: number }[])[0]!.uno).toBe(1);
  });
});
