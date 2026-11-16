#!/usr/bin/env node
/**
 * Genera una consulta SQL de SOLO LECTURA que dice qué migraciones están aplicadas en una base (por las tablas y columnas que crean).
 *
 *   node database/verificar_migraciones.mjs [--desde=54] [salida.sql]
 *
 * Se pega el resultado en phpMyAdmin → pestaña SQL, con la base del sitio seleccionada. Devuelve una fila por migración:
 * `faltan` = objetos (tablas/columnas) que esa migración crea y que NO existen en la base; `faltan = 0` = aplicada.
 * Solo consulta information_schema: no crea, modifica ni borra nada.
 *
 * Limitación: solo ve tablas y columnas nuevas. Una migración que solo cambia datos o índices (no crea nada) no se puede
 * comprobar así; se lista aparte en un comentario del SQL y hay que revisarla a mano.
 * Usa la misma lectura de migraciones que el índice de la app (backend/src/modules/diagnostico/indiceMigraciones.ts); una prueba
 * comprueba que ambas coinciden.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const ID = '`?([A-Za-z_][A-Za-z0-9_]*)`?';
const numero = (f) => Number(/^migracion_v(\d+)/.exec(f)?.[1] ?? NaN);

/** "tabla" / "tabla.columna" → migración que la crea (la primera, como el instalador). */
export function objetosPorMigracion(dir) {
  const objetos = {};
  const poner = (clave, archivo) => { if (!(clave in objetos)) objetos[clave] = archivo; };
  const archivos = ['schema.sql', ...readdirSync(dir).filter((f) => /^migracion_v\d+.*\.sql$/.test(f)).sort((a, b) => numero(a) - numero(b))];
  for (const archivo of archivos) {
    const ruta = path.join(dir, archivo);
    if (!existsSync(ruta)) continue;
    const sql = readFileSync(ruta, 'utf8').replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of sql.matchAll(new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${ID}`, 'gi'))) poner(m[1].toLowerCase(), archivo);
    for (const alter of sql.matchAll(new RegExp(`ALTER\\s+TABLE\\s+${ID}\\s+([^;]*);`, 'gi'))) {
      const tabla = alter[1].toLowerCase();
      for (const col of alter[2].matchAll(new RegExp(`ADD\\s+COLUMN\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${ID}`, 'gi'))) poner(`${tabla}.${col[1].toLowerCase()}`, archivo);
    }
  }
  return objetos;
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

export function generarSql(dir, desde = 54) {
  const objetos = objetosPorMigracion(dir);
  const migraciones = readdirSync(dir).filter((f) => /^migracion_v\d+.*\.sql$/.test(f) && numero(f) >= desde).sort((a, b) => numero(a) - numero(b));
  const filas = [];
  const sinObjetos = [];
  for (const m of migraciones) {
    const propios = Object.entries(objetos).filter(([, archivo]) => archivo === m).map(([k]) => k);
    if (!propios.length) { sinObjetos.push(m); continue; }
    for (const o of propios) {
      const [tabla, columna] = o.split('.');
      const existe = columna
        ? `SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND LOWER(TABLE_NAME) = ${q(tabla)} AND LOWER(COLUMN_NAME) = ${q(columna)}`
        : `SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND LOWER(TABLE_NAME) = ${q(tabla)}`;
      filas.push(`  SELECT ${q(m.replace(/\.sql$/, ''))} AS migracion, ${q(o)} AS objeto, (${existe}) AS presente`);
    }
  }
  return [
    // Comentarios en ASCII puro (sin acentos ni símbolos): phpMyAdmin con otra codificación no debe fallar por ellos.
    `-- Verificacion de migraciones desde la v${desde} (SOLO LECTURA: solo consulta information_schema, no cambia nada).`,
    '-- Pegala en phpMyAdmin, pestana SQL, con la base del sitio seleccionada. faltan = 0 significa migracion aplicada.',
    sinObjetos.length ? `-- No verificables por esquema (no crean tablas ni columnas; revisalas a mano): ${sinObjetos.join(', ')}` : '-- Todas las migraciones del rango crean tablas o columnas.',
    'SELECT migracion, COUNT(*) AS objetos, SUM(presente = 0) AS faltan,',
    "       IF(SUM(presente = 0) = 0, 'APLICADA', 'FALTA') AS estado,",
    "       GROUP_CONCAT(IF(presente = 0, objeto, NULL) SEPARATOR ', ') AS objetos_que_faltan",
    'FROM (',
    filas.join('\n  UNION ALL\n'),
    ') t',
    'GROUP BY migracion',
    'ORDER BY migracion;',
    '',
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const desde = Number(args.find((a) => a.startsWith('--desde='))?.slice(8) ?? 54);
  const salida = args.find((a) => !a.startsWith('--'));
  const sql = generarSql(aqui, Number.isInteger(desde) && desde > 0 ? desde : 54);
  if (salida) { writeFileSync(salida, sql); console.log(`Escrito ${salida}`); } else process.stdout.write(sql);
}
