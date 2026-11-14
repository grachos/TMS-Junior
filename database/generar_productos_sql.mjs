#!/usr/bin/env node
/**
 * Genera database/productos.sql a partir del catálogo oficial del RNDC
 * (database/catalogo_productos.csv, separado por tabulaciones, UTF-8).
 *
 * Reemplaza a importar_productos_csv.php, que necesitaba PHP y una conexión
 * directa a la base: el .sql generado se importa por phpMyAdmin como el resto.
 * Mismas reglas que el importador PHP: valores recortados, vacío -> NULL,
 * nombre = NOMBREYDESCRIPCION o, si falta, CAPITULO; filas sin nombre se omiten.
 *
 * Uso (cuando el RNDC publique un CSV nuevo, reemplazar el archivo y correr):
 *   node database/generar_productos_sql.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const lineas = readFileSync(path.join(dir, 'catalogo_productos.csv'), 'utf8').split(/\r?\n/).slice(1);

// Orden de columnas del CSV -> columna de la tabla producto.
const COLUMNAS = [
  'fecha_ingreso', 'tipo', 'codigo', 'capitulo', 'partida', 'aplica_sicetac',
  'necesita_subpartida', 'hidrocarburo', 'unidad_galones', 'impoconsumo', 'peligrosa',
  'clase_division', 'peligro_secundario', 'grupo_embalaje', 'nombre', 'alerta',
];
// Longitud máxima de cada columna (migracion_v12 + v49); se valida para no
// generar un archivo que falle a mitad de la importación.
const LIMITE = {
  tipo: 4, codigo: 10, capitulo: 200, partida: 400, aplica_sicetac: 3, necesita_subpartida: 3,
  hidrocarburo: 3, unidad_galones: 3, impoconsumo: 3, peligrosa: 3, clase_division: 10,
  peligro_secundario: 10, grupo_embalaje: 20, nombre: 600, alerta: 255,
};

const sql = (v) => (v === null ? 'NULL' : `'${v.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`);

const filas = [];
for (const [i, linea] of lineas.entries()) {
  if (!linea.trim()) continue;
  const celdas = linea.split('\t').map((c) => c.trim());
  const v = (idx) => (celdas[idx] ? celdas[idx] : null);
  const valores = Object.fromEntries(COLUMNAS.map((c, idx) => [c, v(idx)]));
  valores.nombre = valores.nombre ?? valores.capitulo;
  if (valores.nombre === null || valores.codigo === null) continue;
  if (valores.fecha_ingreso) valores.fecha_ingreso = valores.fecha_ingreso.replace(/\//g, '-');
  for (const [col, max] of Object.entries(LIMITE)) {
    const largo = valores[col] === null ? 0 : [...valores[col]].length;
    if (largo > max) throw new Error(`Línea ${i + 2}: ${col} tiene ${largo} caracteres (máximo ${max}). Ajusta la columna con una migración.`);
  }
  filas.push(`(${COLUMNAS.map((c) => sql(valores[c])).join(',')})`);
}

const LOTE = 500;
const inserts = [];
for (let i = 0; i < filas.length; i += LOTE) {
  inserts.push(`INSERT INTO tmp_producto_csv (${COLUMNAS.join(', ')}) VALUES\n${filas.slice(i, i + LOTE).join(',\n')};`);
}

const salida = `-- productos.sql — GENERADO por generar_productos_sql.mjs desde catalogo_productos.csv.
-- No editar a mano: actualizar el CSV y volver a generar.
-- ${filas.length} productos del catálogo oficial del RNDC.
--
-- Importar DESPUÉS de todas las migraciones (migracion_v12 recrea la tabla
-- producto y v49 amplía sus columnas).
--
-- Solo carga si la tabla producto está VACÍA (instalación nueva): en una base
-- que ya tiene catálogo no cambia nada, así no pisa productos editados (p.ej.
-- codigo_un / estado_producto). Repetible.

SET NAMES utf8mb4;

DROP TEMPORARY TABLE IF EXISTS tmp_producto_csv;
CREATE TEMPORARY TABLE tmp_producto_csv LIKE producto;

${inserts.join('\n\n')}

INSERT INTO producto (${COLUMNAS.join(', ')})
SELECT ${COLUMNAS.join(', ')} FROM tmp_producto_csv
WHERE NOT EXISTS (SELECT 1 FROM producto);

DROP TEMPORARY TABLE IF EXISTS tmp_producto_csv;

SELECT COUNT(*) AS productos_en_catalogo FROM producto;
`;
writeFileSync(path.join(dir, 'productos.sql'), salida);
console.log(`productos.sql: ${filas.length} productos.`);
