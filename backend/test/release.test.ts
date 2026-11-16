/**
 * scripts/release.mjs: liberar a producción solo con avances directos de commits ya probados (en main), solo a ramas de producción.
 * Usa repositorios de git temporales (un "origin" local): no toca GitHub.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

const script = new URL('../../scripts/release.mjs', import.meta.url).pathname;
const entorno = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: entorno, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let origen = ''; let trabajo = '';
const c: Record<string, string> = {};
const remoto = (rama: string) => git(origen, 'rev-parse', '--verify', '-q', `refs/heads/${rama}`);
const existeRemoto = (rama: string) => spawnSync('git', ['rev-parse', '--verify', '-q', `refs/heads/${rama}`], { cwd: origen, env: entorno }).status === 0;
const correr = (...args: string[]) => { const r = spawnSync('node', [script, ...args], { cwd: trabajo, env: entorno, encoding: 'utf8' }); return { codigo: r.status, salida: `${r.stdout}${r.stderr}` }; };
function commit(archivo: string, texto: string, msg: string): string {
  mkdirSync(path.dirname(path.join(trabajo, archivo)), { recursive: true });
  writeFileSync(path.join(trabajo, archivo), texto);
  git(trabajo, 'add', '-A'); git(trabajo, 'commit', '-q', '-m', msg);
  return git(trabajo, 'rev-parse', 'HEAD');
}

beforeEach(() => {
  const base = mkdtempSync(path.join(tmpdir(), 'release-'));
  origen = path.join(base, 'origen.git'); trabajo = path.join(base, 'trabajo');
  mkdirSync(origen); git(origen, 'init', '-q', '--bare', '-b', 'main');
  mkdirSync(trabajo); git(trabajo, 'init', '-q', '-b', 'main'); git(trabajo, 'remote', 'add', 'origin', origen);
  c.c1 = commit('a.txt', '1', 'c1: base');
  c.c2 = commit('database/migracion_v70_nueva.sql', '-- migracion', 'c2: migración nueva');
  c.c3 = commit('b.txt', '3', 'c3: cambio');
  git(trabajo, 'push', '-q', 'origin', 'main');
  git(trabajo, 'push', '-q', 'origin', `${c.c1}:refs/heads/produccion`);
  git(trabajo, 'push', '-q', 'origin', `${c.c2}:refs/heads/prod-02`);
});

describe('scripts/release.mjs', () => {
  it('sin --confirmar solo SIMULA: muestra los commits y las migraciones nuevas y no empuja nada', () => {
    const r = correr('produccion');
    expect(r.codigo).toBe(0);
    expect(r.salida).toMatch(/c2: migración nueva/);
    expect(r.salida).toMatch(/migracion_v70_nueva\.sql/);
    expect(r.salida).toMatch(/ANTES de liberar/);
    expect(r.salida).toMatch(/Simulación/);
    expect(remoto('produccion')).toBe(c.c1);
  });

  it('con --confirmar adelanta la rama al commit exacto, sin tocar main ni las demás', () => {
    const r = correr('produccion', '--confirmar');
    expect(r.codigo, r.salida).toBe(0);
    expect(remoto('produccion')).toBe(c.c3);
    expect(remoto('main')).toBe(c.c3);
    expect(remoto('prod-02')).toBe(c.c2); // otro sitio: sin tocar
  });

  it('--sha libera un commit anterior de main; un commit que NO está en main se rechaza', () => {
    expect(correr('produccion', `--sha=${c.c2}`, '--confirmar').codigo).toBe(0);
    expect(remoto('produccion')).toBe(c.c2);
    // un commit que solo existe en una rama del agente (no pasó por main)
    git(trabajo, 'checkout', '-q', '-b', 'agente/incidente-9');
    const malo = commit('malo.txt', 'x', 'commit del agente sin integrar');
    git(trabajo, 'push', '-q', 'origin', 'agente/incidente-9'); git(trabajo, 'checkout', '-q', 'main');
    const r = correr('produccion', `--sha=${malo}`, '--confirmar');
    expect(r.codigo).not.toBe(0);
    expect(r.salida).toMatch(/no está en origin\/main/);
    expect(remoto('produccion')).toBe(c.c2);
    expect(correr('produccion', '--sha=deadbeefdeadbeefdeadbeef', '--confirmar').codigo).not.toBe(0);
  });

  it('nunca reescribe historia: una rama que no es ancestro (divergente o adelantada) se rechaza y no se toca', () => {
    git(trabajo, 'checkout', '-q', '-b', 'desvio', c.c1);
    const d1 = commit('desvio.txt', 'd', 'd1: commit solo en producción');
    git(trabajo, 'push', '-q', 'origin', `${d1}:refs/heads/prod-03`); git(trabajo, 'checkout', '-q', 'main');
    const r = correr('prod-03', '--confirmar');
    expect(r.codigo).not.toBe(0);
    expect(r.salida).toMatch(/avance directo/);
    expect(remoto('prod-03')).toBe(d1);
    // si hay una rama inválida entre `todos`, NO se empuja ninguna (se comprueba todo antes)
    const t = correr('todos', '--confirmar');
    expect(t.codigo).not.toBe(0);
    expect(remoto('produccion')).toBe(c.c1);
    expect(remoto('prod-02')).toBe(c.c2);
  });

  it('solo escribe en ramas de producción: main, ramas del agente, mayúsculas, rutas y comandos se rechazan', () => {
    for (const nombre of ['main', 'prod-', 'prod-ABC', 'prod-a-b-c', 'agente/incidente-1', 'claude/x', '../x', 'produccion;id', 'produccion x', 'refs/heads/produccion', 'prod-0123456789012345678901', 'Produccion']) {
      const r = correr(nombre, '--confirmar');
      expect(r.codigo, nombre).not.toBe(0);
    }
    expect(remoto('main')).toBe(c.c3);
    expect(remoto('produccion')).toBe(c.c1);
    expect(correr().codigo).not.toBe(0);
    expect(correr('produccion', '--force', '--confirmar').codigo).not.toBe(0); // no existe --force
    expect(remoto('produccion')).toBe(c.c1);
  });

  it('`todos` adelanta todas las ramas de producción que existan y solo esas', () => {
    git(trabajo, 'push', '-q', 'origin', `${c.c1}:refs/heads/agente/incidente-5`);
    git(trabajo, 'push', '-q', 'origin', `${c.c1}:refs/heads/otra-rama`);
    // nombres que el patrón de git (`produccion`, `prod-*`) alcanza pero que NO son ramas de producción válidas
    for (const raro of ['agente/produccion', 'x/y/produccion', 'prod-ABC', 'prod-a-b-c', 'prod-']) git(trabajo, 'push', '-q', 'origin', `${c.c1}:refs/heads/${raro}`);
    const r = correr('todos', '--confirmar');
    expect(r.codigo, r.salida).toBe(0);
    expect(remoto('produccion')).toBe(c.c3);
    expect(remoto('prod-02')).toBe(c.c3);
    expect(remoto('agente/incidente-5')).toBe(c.c1);
    expect(remoto('otra-rama')).toBe(c.c1);
    for (const raro of ['agente/produccion', 'x/y/produccion', 'prod-ABC', 'prod-a-b-c', 'prod-']) expect(remoto(raro), raro).toBe(c.c1);
  });

  it('el script no contiene ninguna forma de push forzado (ni --force, ni --force-with-lease, ni refspec con +)', () => {
    const codigo = readFileSync(script, 'utf8').split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
    expect(codigo).not.toMatch(/--force|-f\b|--mirror|--delete|\+\$\{|:refs\/heads\/main/);
    expect(codigo.match(/git\('push'[^)]*\)/g)).toEqual(["git('push', 'origin', `${commit}:refs/heads/${rama}`)"]);
  });

  it('una rama de sitio nueva (prod-09) se crea con el commit probado; si ya está al día no hace nada', () => {
    expect(existeRemoto('prod-09')).toBe(false);
    expect(correr('prod-09', '--confirmar').codigo).toBe(0);
    expect(remoto('prod-09')).toBe(c.c3);
    const otra = correr('prod-09', '--confirmar');
    expect(otra.codigo).toBe(0);
    expect(otra.salida).toMatch(/ya está en/);
  });
});
