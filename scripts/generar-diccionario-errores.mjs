#!/usr/bin/env node
/**
 * Genera backend/src/modules/chat/diccionarioErroresRndc.data.ts a partir de docs/diccionario_errores_rndc.tsv (el "Maestro Diccionario
 * de Errores RNDC" del Ministerio, exportado tal cual: TSV con encabezado FECHAINGRESO, DDEPROCESOID, DDECODIGOERROR, DDEMENSAJEERROR,
 * DDEVARIABLE, DDETIPOERROR, DDEPROCESO, DDESOLUCION).
 *
 *   node scripts/generar-diccionario-errores.mjs [--verificar]
 *
 * Para actualizar el diccionario: reemplaza el .tsv (UTF-8) por el nuevo maestro y ejecuta este script. Con --verificar no escribe: sale
 * con error si el archivo generado no coincide con el .tsv (una prueba lo usa para que nunca queden desfasados).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ORIGEN = path.join(raiz, 'docs', 'diccionario_errores_rndc.tsv');
export const DESTINO = path.join(raiz, 'backend', 'src', 'modules', 'chat', 'diccionarioErroresRndc.data.ts');
const ENCABEZADO = ['FECHAINGRESO', 'DDEPROCESOID', 'DDECODIGOERROR', 'DDEMENSAJEERROR', 'DDEVARIABLE', 'DDETIPOERROR', 'DDEPROCESO', 'DDESOLUCION'];

export function generar(tsv) {
  const lineas = tsv.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  const cab = lineas[0].split('\t').map((c) => c.trim()).filter(Boolean);
  if (ENCABEZADO.some((c, i) => cab[i] !== c)) throw new Error(`Encabezado inesperado: ${cab.join(',')}`);
  const filas = [];
  for (const [i, l] of lineas.slice(1).entries()) {
    const c = l.split('\t').map((x) => x.trim());
    const [, proceso, codigo, mensaje, variable, tipo, nombreProceso, solucion] = c;
    if (!codigo || !/^[A-Z]{3,6}\d{0,3}$/.test(codigo)) throw new Error(`Fila ${i + 2}: código inválido "${codigo}"`);
    if (!['E', 'A', 'I'].includes(tipo)) throw new Error(`Fila ${i + 2}: tipo inválido "${tipo}"`);
    filas.push([codigo, Number(proceso) || 0, nombreProceso ?? '', tipo, variable ?? '', mensaje ?? '', solucion ?? '']);
  }
  return [
    '// GENERADO por scripts/generar-diccionario-errores.mjs desde docs/diccionario_errores_rndc.tsv. NO editar a mano.',
    '// [código, id de proceso, proceso, tipo (E error · A alerta · I información), variable, mensaje, solución]',
    'export type FilaDiccionario = readonly [string, number, string, string, string, string, string];',
    `export const DICCIONARIO_ERRORES_RNDC: readonly FilaDiccionario[] = ${JSON.stringify(filas)};`,
    '',
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ts = generar(readFileSync(ORIGEN, 'utf8'));
  if (process.argv.includes('--verificar')) {
    if (!existsSync(DESTINO) || readFileSync(DESTINO, 'utf8') !== ts) { console.error('✖ diccionarioErroresRndc.data.ts no coincide con el .tsv: ejecuta node scripts/generar-diccionario-errores.mjs'); process.exit(1); }
    console.log('✔ El diccionario generado coincide con el .tsv.');
  } else { writeFileSync(DESTINO, ts); console.log(`Escrito ${path.relative(raiz, DESTINO)} (${ts.length} bytes).`); }
}
