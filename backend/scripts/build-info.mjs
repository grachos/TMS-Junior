#!/usr/bin/env node
/**
 * Escribe dist/build-info.json con el commit que se está compilando, para que cada incidente registre la versión
 * DESPLEGADA. Si git no está disponible en el entorno de compilación, queda "desconocida": no se adivina.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = path.dirname(fileURLToPath(import.meta.url));
let commit = 'desconocida';
try {
  const c = execSync('git rev-parse HEAD', { cwd: aqui, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  if (/^[0-9a-f]{40}$/.test(c)) commit = c;
} catch {
  /* sin git: queda "desconocida" */
}
const destino = path.resolve(aqui, '..', 'dist');
mkdirSync(destino, { recursive: true });
writeFileSync(path.join(destino, 'build-info.json'), JSON.stringify({ commit, compilado: new Date().toISOString() }));
console.log(`build-info: ${commit.slice(0, 12)}`);
