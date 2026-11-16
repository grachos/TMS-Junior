#!/usr/bin/env node
/**
 * Liberar a producción: adelanta la rama de un sitio de producción a un commit YA PROBADO de `main`.
 *
 *   node scripts/release.mjs <rama|todos> [--sha=<commit>] [--confirmar]
 *
 *   <rama>   `produccion` o `prod-<id>` (un sitio de producción por rama; ver DEPLOY.md). `todos` = todas las que existan en origin.
 *   --sha    commit a liberar; por defecto, la punta de origin/main. Debe estar en origin/main (ya pasó por pruebas).
 *   --confirmar  sin esto solo MUESTRA lo que haría (no empuja nada).
 *
 * Garantías (todas se comprueban antes de empujar, y cualquier fallo aborta SIN tocar nada):
 *  - solo se escribe en ramas con nombre `produccion` o `prod-<id>`; nunca en `main` ni en ramas del agente;
 *  - el commit pertenece a origin/main;
 *  - es un AVANCE DIRECTO de la rama (nunca reescribe historia; no existe --force);
 *  - muestra las migraciones nuevas del rango: deben estar aplicadas en la base de ese sitio ANTES de liberar.
 *
 * Los nombres de rama son públicos (el repositorio lo es): usa identificadores neutros (`prod-01`), no el nombre del cliente.
 */
import { execFileSync } from 'node:child_process';

const NOMBRE_RAMA = /^(produccion|prod-[a-z0-9]{1,20}(-[a-z0-9]{1,20})?)$/;
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const falla = (m) => { console.error(`✖ ${m}`); process.exit(1); };
const esAncestro = (a, b) => { try { execFileSync('git', ['merge-base', '--is-ancestor', a, b], { stdio: 'ignore' }); return true; } catch { return false; } };

const args = process.argv.slice(2);
const confirmar = args.includes('--confirmar');
const sha = args.find((a) => a.startsWith('--sha='))?.slice(6);
const objetivo = args.find((a) => !a.startsWith('--'));
const desconocidas = args.filter((a) => a.startsWith('--') && a !== '--confirmar' && !a.startsWith('--sha='));
if (!objetivo || desconocidas.length) falla('Uso: node scripts/release.mjs <produccion|prod-ID|todos> [--sha=COMMIT] [--confirmar]');

try { git('fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main'); } catch { falla('No pude traer origin/main.'); }

let commit;
try { commit = git('rev-parse', '--verify', `${sha ?? 'origin/main'}^{commit}`); } catch { falla(`No existe el commit ${sha}.`); }
if (!esAncestro(commit, 'origin/main')) falla(`El commit ${commit.slice(0, 12)} no está en origin/main: solo se libera código que ya pasó por pruebas.`);

let ramas;
if (objetivo === 'todos') {
  const salida = git('ls-remote', '--heads', 'origin', 'produccion', 'prod-*');
  ramas = salida.split('\n').filter(Boolean).map((l) => l.split('\t')[1].replace('refs/heads/', '')).filter((r) => NOMBRE_RAMA.test(r)).sort();
  if (!ramas.length) falla('No hay ramas de producción en origin.');
} else {
  if (!NOMBRE_RAMA.test(objetivo)) falla(`"${objetivo}" no es una rama de producción válida (produccion o prod-<id>). Nunca se escribe en main ni en otras ramas.`);
  ramas = [objetivo];
}

// 1) Comprobar TODAS antes de empujar cualquiera.
const plan = [];
for (const rama of ramas) {
  const actual = git('ls-remote', '--heads', 'origin', `refs/heads/${rama}`).split('\t')[0] || null;
  if (actual === commit) { console.log(`= ${rama}: ya está en ${commit.slice(0, 12)}.`); continue; }
  if (actual) {
    try { git('fetch', '--quiet', 'origin', `+refs/heads/${rama}:refs/remotes/origin/${rama}`); } catch { falla(`No pude traer ${rama}.`); }
    if (!esAncestro(actual, commit)) falla(`${rama} (${actual.slice(0, 12)}) NO es ancestro de ${commit.slice(0, 12)}: no sería un avance directo. No se reescribe historia.`);
  }
  plan.push({ rama, actual });
}

// 2) Mostrar qué se libera.
for (const { rama, actual } of plan) {
  console.log(`\n→ ${rama}: ${actual ? actual.slice(0, 12) : '(rama nueva)'} → ${commit.slice(0, 12)}`);
  if (!actual) {
    // Sitio nuevo: no hay "cambios desde" ni migraciones pendientes que listar; su base se instala entera de una vez.
    console.log(`    ${git('log', '--oneline', '--no-decorate', '-n', '1', commit)}`);
    console.log('  ℹ Sitio nuevo: su base de datos se instala con instalacion_nueva.sql (node database/generar_instalacion.mjs), no con migraciones sueltas.');
    continue;
  }
  const cambios = git('log', '--oneline', '--no-decorate', '-n', '30', `${actual}..${commit}`);
  console.log(cambios ? cambios.split('\n').map((l) => `    ${l}`).join('\n') : '    (sin commits nuevos)');
  const migraciones = git('diff', '--name-only', actual, commit, '--', 'database/').split('\n').filter((f) => /migracion_v\d+.*\.sql$/.test(f));
  if (migraciones.length) console.log(`  ⚠ Migraciones nuevas o cambiadas: aplícalas en la base de ESTE sitio ANTES de liberar:\n${migraciones.map((m) => `      ${m}`).join('\n')}`);
}
if (!plan.length) { console.log('\nNada que liberar.'); process.exit(0); }

if (!confirmar) { console.log('\n(Simulación: no se empujó nada. Repite con --confirmar para liberar.)'); process.exit(0); }

// 3) Empujar: siempre el commit exacto, a la rama exacta, sin --force.
for (const { rama } of plan) {
  try { git('push', 'origin', `${commit}:refs/heads/${rama}`); } catch (e) { falla(`GitHub rechazó el push a ${rama}: ${String(e.stderr ?? e.message).split('\n').slice(0, 3).join(' | ')}`); }
  console.log(`✔ ${rama} ahora en ${commit.slice(0, 12)}. Verifica el despliegue de ese sitio.`);
}
