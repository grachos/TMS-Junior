/**
 * database/verificar_migraciones.mjs: genera una consulta de SOLO LECTURA que dice qué migraciones están aplicadas en una base.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2';
import { generarIndice } from '../src/modules/diagnostico/indiceMigraciones.js';

const RUN = process.env.TEST_DB === '1';
const carpeta = new URL('../../database/', import.meta.url).pathname;
// @ts-expect-error módulo .mjs sin tipos
const { generarSql, objetosPorMigracion } = (await import('../../database/verificar_migraciones.mjs')) as { generarSql: (d: string, desde?: number) => string; objetosPorMigracion: (d: string) => Record<string, string> };

describe('verificar_migraciones.mjs', () => {
  it('lee las mismas tablas y columnas que el índice de la app (no se desincroniza)', () => {
    expect(objetosPorMigracion(carpeta)).toEqual(generarIndice(carpeta).objetos);
  });

  it('el SQL generado es una sola consulta SELECT de solo lectura (nada de escribir, borrar o cambiar)', () => {
    const sql = generarSql(carpeta, 54);
    const sinComentarios = sql.replace(/--[^\n]*/g, '').trim();
    expect(sinComentarios).toMatch(/^SELECT /);
    expect(sinComentarios.split(';').filter((x) => x.trim()).length).toBe(1);
    expect(sinComentarios).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|RENAME|REPLACE|GRANT|CALL|SET|LOAD|INTO\s+OUTFILE)\b/i);
    // cubre cada migración del rango que crea algo
    for (const v of ['v54_', 'v57_', 'v58_', 'v59_', 'v60_', 'v61_']) expect(sql, v).toContain(`migracion_${v}`);
    expect(sql).toContain("'staff_users.uuid'");
  });

  it('todo literal del SQL es un identificador simple (los nombres solo pueden tener letras, dígitos y _ por cómo se leen): sin forma de inyectar', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mig-'));
    writeFileSync(path.join(dir, 'schema.sql'), 'CREATE TABLE base (id INT);');
    writeFileSync(path.join(dir, 'migracion_v99_x.sql'), "CREATE TABLE `a'b; DROP TABLE x` (id INT);\nCREATE TABLE ok_1 (id INT);");
    const sql = generarSql(dir, 99);
    const literales = [...sql.replace(/--[^\n]*/g, '').matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]!);
    for (const l of literales) expect(l, l).toMatch(/^[A-Za-z0-9_.]+$|^ APLICADA$|^APLICADA$|^FALTA$|^, $/);
    expect(sql).not.toMatch(/DROP TABLE x/i);
    // y todo literal de comprobación mira SOLO la base actual
    const dir2 = generarSql(carpeta, 54);
    const existencias = dir2.match(/information_schema\.(COLUMNS|TABLES) WHERE/g) ?? [];
    expect(existencias.length).toBeGreaterThan(10);
    expect((dir2.match(/TABLE_SCHEMA = DATABASE\(\)/g) ?? []).length).toBe(existencias.length);
  });

  it('si una tabla o columna la crean dos archivos, gana el PRIMERO, igual que en el índice de la app', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mig-'));
    writeFileSync(path.join(dir, 'schema.sql'), 'CREATE TABLE base (id INT);');
    writeFileSync(path.join(dir, 'migracion_v10_a.sql'), 'CREATE TABLE IF NOT EXISTS compartida (id INT);\nALTER TABLE base ADD COLUMN IF NOT EXISTS extra INT;');
    writeFileSync(path.join(dir, 'migracion_v11_b.sql'), 'CREATE TABLE IF NOT EXISTS compartida (id INT);\nALTER TABLE base ADD COLUMN IF NOT EXISTS extra INT;');
    const propio = objetosPorMigracion(dir);
    expect(propio).toEqual(generarIndice(dir).objetos);
    expect(propio.compartida).toBe('migracion_v10_a.sql');
    expect(propio['base.extra']).toBe('migracion_v10_a.sql');
  });

  describe.skipIf(!RUN)('contra una base real', () => {
    afterAll(async () => { const { db } = await import('../src/db/pool.js'); await db().end(); });

    it('la base armada con el instalador tiene todas las migraciones del rango como APLICADA', async () => {
      const { db } = await import('../src/db/pool.js');
      const [filas] = await db().query<RowDataPacket[]>(generarSql(carpeta, 54));
      expect(filas.length).toBeGreaterThanOrEqual(8);
      for (const f of filas) expect(f.estado, `${f.migracion}: ${f.objetos_que_faltan}`).toBe('APLICADA');
    });

    it('detecta lo que falta: una tabla que no existe sale como FALTA y una que sí existe, como APLICADA', async () => {
      const { db } = await import('../src/db/pool.js');
      const dir = mkdtempSync(path.join(tmpdir(), 'mig-'));
      writeFileSync(path.join(dir, 'schema.sql'), 'CREATE TABLE staff_users (id INT);');
      writeFileSync(path.join(dir, 'migracion_v90_falta.sql'), 'CREATE TABLE zz_tabla_que_no_existe_9 (id INT);\nALTER TABLE staff_users ADD COLUMN IF NOT EXISTS zz_columna_que_no_existe INT;');
      writeFileSync(path.join(dir, 'migracion_v91_esta.sql'), 'ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS uuid CHAR(36);');
      const [filas] = await db().query<RowDataPacket[]>(generarSql(dir, 90));
      const por = Object.fromEntries(filas.map((f) => [f.migracion, f]));
      expect(por.migracion_v90_falta).toMatchObject({ estado: 'FALTA', objetos: 2 });
      expect(String(por.migracion_v90_falta.objetos_que_faltan)).toContain('zz_tabla_que_no_existe_9');
      expect(String(por.migracion_v90_falta.objetos_que_faltan)).toContain('staff_users.zz_columna_que_no_existe');
      expect(por.migracion_v91_esta).toMatchObject({ estado: 'APLICADA', faltan: '0' });
    });
  });
});
