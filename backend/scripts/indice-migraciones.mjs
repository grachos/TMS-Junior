#!/usr/bin/env node
/** Escribe dist/migraciones-indice.json con la MISMA función que usan las pruebas (la compilada en dist/). */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generarIndice } from '../dist/modules/diagnostico/indiceMigraciones.js';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const dirDatabase = path.resolve(aqui, '..', '..', 'database');
try {
  const indice = generarIndice(dirDatabase);
  mkdirSync(path.resolve(aqui, '..', 'dist'), { recursive: true });
  writeFileSync(path.resolve(aqui, '..', 'dist', 'migraciones-indice.json'), JSON.stringify(indice));
  console.log(`indice-migraciones: ${Object.keys(indice.objetos).length} objetos`);
} catch (e) {
  // Si no se puede generar, el diagnóstico lo dirá ("sin índice"); la compilación no debe fallar por esto.
  console.log(`indice-migraciones: no se pudo generar (${e.message})`);
}
