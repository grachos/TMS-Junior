#!/usr/bin/env node
/**
 * Genera UN solo archivo SQL para una instalación nueva (base vacía), con todo
 * en el orden de DEPLOY.md: schema, maestros, catálogos (incluida la
 * configuración de vehículos), municipios, todas las
 * migraciones y al final productos.sql. Así un sitio nuevo se importa en un
 * solo paso por phpMyAdmin en vez de ~55 archivos.
 *
 * Omite migracion_v21.sql: schema.sql ya trae ese cambio y en una base nueva
 * falla ("Unknown column 'cantidad_cargada'"), lo que detendría la importación.
 *
 * Uso:  node database/generar_instalacion.mjs [salida.sql]
 * (por defecto: database/instalacion_nueva.sql, que no se versiona)
 *
 * SOLO para bases VACÍAS. Una base existente se actualiza corriendo únicamente
 * las migraciones nuevas.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const salida = path.resolve(process.argv[2] ?? path.join(dir, 'instalacion_nueva.sql'));

const numero = (f) => Number(/^migracion_v(\d+)/.exec(f)?.[1] ?? NaN);
const migraciones = readdirSync(dir)
  .filter((f) => /^migracion_v\d+.*\.sql$/.test(f))
  .sort((a, b) => numero(a) - numero(b));
const OMITIR = new Set(['migracion_v21.sql']);
const archivos = ['schema.sql', 'maestros.sql', 'catalogos.sql', 'catalogo_configuracion.sql', 'municipios.sql',
  ...migraciones.filter((f) => !OMITIR.has(f)), 'productos.sql'];

const partes = [
  '-- instalacion_nueva.sql — GENERADO por generar_instalacion.mjs. No editar a mano.',
  '-- Instalación completa para una base de datos VACÍA (un sitio nuevo).',
  `-- Incluye, en orden: ${archivos.join(', ')}.`,
  `-- Omitido a propósito: ${[...OMITIR].join(', ')} (schema.sql ya lo incluye).`,
  '',
  'SET NAMES utf8mb4;',
];
for (const f of archivos) {
  partes.push('', `-- =====================================================================`, `-- ${f}`, `-- =====================================================================`, readFileSync(path.join(dir, f), 'utf8').trimEnd());
}
partes.push('', "SELECT 'Instalación completa' AS resultado,", '  (SELECT COUNT(*) FROM producto) AS productos,', '  (SELECT COUNT(*) FROM municipio) AS municipios,', '  (SELECT COUNT(*) FROM error_rndc) AS errores_rndc;', '');
writeFileSync(salida, partes.join('\n'));
console.log(`${path.relative(process.cwd(), salida)}: ${archivos.length} archivos (sin ${[...OMITIR].join(', ')}).`);
