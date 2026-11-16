/**
 * Simula el script que reúne los datos de la política (con un `gh` falso) y comprueba que el resultado, pasado por el evaluador,
 * decide bien. Así se prueba el "pegamento" (jq, paginación, quién puso la etiqueta, etc.) sin tocar GitHub.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decidir, type PoliticaIntegracion } from '../src/modules/agente/politicaIntegracion';

const tieneJq = spawnSync('jq', ['--version']).status === 0;
const politicaRuta = new URL('../../.github/agente-politica.json', import.meta.url).pathname;
const politica = JSON.parse(readFileSync(politicaRuta, 'utf8')) as PoliticaIntegracion;
const script = new URL('../scripts/reunir-integracion.sh', import.meta.url).pathname;
const SHA = 'c'.repeat(40);

/** Escribe un `gh` falso (node) que responde según el escenario. */
function escenario(o: { etiquetadoPor?: string; autorIssue?: string; checks?: { name: string; conclusion: string; head_sha: string }[]; fallaApi?: boolean; sinPr?: boolean }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ghfalso-'));
  const datos = {
    pulls: o.sinPr ? [] : [{ number: 40, state: 'open', head: { ref: 'agente/incidente-39' } }],
    pr: { number: 40, state: 'open', merged: false, draft: false, changed_files: 2, user: { login: 'dueno' }, base: { ref: 'main' }, head: { ref: 'agente/incidente-39', sha: SHA, repo: { full_name: 'org/repo' } } },
    files: [
      { filename: 'backend/src/modules/impuestos/ica.ts', status: 'modified', additions: 2, deletions: 1, patch: '@@\n-a\n+b ?? 0' },
      { filename: 'backend/test/ica_nuevo.test.ts', status: 'added', additions: 8, deletions: 0, patch: '@@\n+it("x", () => {});' },
    ],
    issue: { number: 39, user: { login: o.autorIssue ?? 'dueno' }, labels: [{ name: 'incidente-soporte' }, { name: 'agente-corregir' }] },
    eventos: [
      { event: 'labeled', label: { name: 'incidente-soporte' }, actor: { login: 'github-actions[bot]' } },
      { event: 'labeled', label: { name: 'agente-corregir' }, actor: { login: o.etiquetadoPor ?? 'dueno' } },
    ],
    checks: o.checks ?? ['build', 'db-tests', 'GitGuardian Security Checks'].map((name) => ({ name, conclusion: 'success', head_sha: SHA })),
    merged: [{ headRefName: 'agente/incidente-1', mergedAt: new Date(Date.now() - 3600_000).toISOString() }, { headRefName: 'agente/incidente-2', mergedAt: new Date(Date.now() - 3 * 86400_000).toISOString() }, { headRefName: 'otra-rama', mergedAt: new Date().toISOString() }],
  };
  writeFileSync(path.join(dir, 'datos.json'), JSON.stringify(datos));
  const fake = `#!/usr/bin/env node
const d = JSON.parse(require('fs').readFileSync(${JSON.stringify(path.join(dir, 'datos.json'))}, 'utf8'));
const a = process.argv.slice(2).join(' ');
const out = (v) => console.log(JSON.stringify(v));
const lines = (arr) => arr.forEach(out);
if (${o.fallaApi ? 'true' : 'false'} && a === 'api repos/org/repo/issues/39' ) { process.exit(1); }
if (a.startsWith('api repos/org/repo/commits/') && a.endsWith('/pulls')) out(d.pulls);
else if (a === 'api repos/org/repo/pulls/40') out(d.pr);
else if (a.startsWith('api --paginate repos/org/repo/pulls/40/files')) lines(d.files);
else if (a === 'api repos/org/repo/issues/39') out(d.issue);
else if (a.startsWith('api --paginate repos/org/repo/issues/39/events')) lines(d.eventos);
else if (a.startsWith('api --paginate repos/org/repo/commits/') && a.includes('/check-runs')) lines(d.checks);
else if (a.startsWith('pr list')) out(d.merged);
else { console.error('gh falso: no sé responder a', a); process.exit(1); }
`;
  writeFileSync(path.join(dir, 'gh'), fake); chmodSync(path.join(dir, 'gh'), 0o755);
  return dir;
}
function correr(dir: string, extra: Record<string, string> = {}) {
  const salida = path.join(dir, 'entrada.json');
  const r = spawnSync('bash', [script], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, REPO: 'org/repo', HEAD_BRANCH: 'agente/incidente-39', HEAD_SHA: SHA, MODO: 'activo', PROPIETARIO: 'dueno', AUTOR_ISSUES: 'dueno', POLITICA: politicaRuta, OUT: salida, ...extra }, encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr, entrada: r.status === 0 ? JSON.parse(readFileSync(salida, 'utf8')) : null };
}

describe.skipIf(!tieneJq)('script que reúne los datos de la integración (gh simulado)', () => {
  it('con todo en regla produce una entrada que el evaluador acepta (y cuenta solo las integraciones de agente/ de las últimas 24 h)', () => {
    const r = correr(escenario({}));
    expect(r.status, r.stderr).toBe(0);
    expect(r.entrada.integradosHoy).toBe(1);
    expect(r.entrada.issue.etiquetadoPor).toBe('dueno'); // la ÚLTIMA vez que se puso la etiqueta de autorización
    expect(r.entrada.pr).toMatchObject({ numero: 40, headRepo: 'org/repo', abierto: true, draft: false, headSha: SHA, cambiados: 2 });
    expect(decidir(politica, r.entrada)).toMatchObject({ elegible: true, accion: 'integrar' });
  });

  it('si la etiqueta de autorización la puso otra persona, o el issue es de otro autor, o un check no está en verde, no se integra', () => {
    expect(decidir(politica, correr(escenario({ etiquetadoPor: 'intruso' })).entrada).elegible).toBe(false);
    expect(decidir(politica, correr(escenario({ autorIssue: 'intruso' })).entrada).elegible).toBe(false);
    const rojo = ['build', 'db-tests', 'GitGuardian Security Checks'].map((name) => ({ name, conclusion: name === 'db-tests' ? 'failure' : 'success', head_sha: SHA }));
    expect(decidir(politica, correr(escenario({ checks: rojo })).entrada).elegible).toBe(false);
    const otroCommit = ['build', 'db-tests', 'GitGuardian Security Checks'].map((name) => ({ name, conclusion: 'success', head_sha: 'd'.repeat(40) }));
    expect(decidir(politica, correr(escenario({ checks: otroCommit })).entrada).elegible).toBe(false);
  });

  it('falla CERRADO: sin PR abierto, con la API caída o con entradas raras, el script termina con error y no produce decisión', () => {
    expect(correr(escenario({ sinPr: true })).status).not.toBe(0);
    expect(correr(escenario({ fallaApi: true })).status).not.toBe(0);
    const d = escenario({});
    for (const extra of [{ HEAD_BRANCH: 'agente/incidente-39:main' }, { HEAD_BRANCH: 'main' }, { HEAD_BRANCH: 'agente/incidente-39;id' }, { HEAD_SHA: 'xyz' }, { HEAD_BRANCH: '$(id)' }]) expect(correr(d, extra).status, JSON.stringify(extra)).not.toBe(0);
  });
});
