import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decidir, globARegExp, seguro, validarPolitica, type EntradaIntegracion, type PoliticaIntegracion } from '../src/modules/agente/politicaIntegracion';

const politica = JSON.parse(readFileSync(new URL('../../.github/agente-politica.json', import.meta.url), 'utf8')) as PoliticaIntegracion;
const SHA = 'a'.repeat(40);
const ok = (): EntradaIntegracion => ({
  modo: 'activo', propietario: 'dueno', autorIssues: 'dueno', repo: 'org/repo',
  pr: { numero: 40, base: 'main', headRef: 'agente/incidente-39', headRepo: 'org/repo', draft: false, autor: 'dueno', headSha: SHA, cambiados: 2, abierto: true },
  archivos: [
    { filename: 'backend/src/modules/impuestos/ica.ts', status: 'modified', additions: 3, deletions: 1, patch: '@@ -1 +1 @@\n-  const a = b;\n+  const a = b ?? 0;' },
    { filename: 'backend/test/ica_nuevo.test.ts', status: 'added', additions: 10, deletions: 0, patch: '@@ -0,0 +1,10 @@\n+it("x", () => { expect(1).toBe(1); });' },
  ],
  issue: { numero: 39, esPr: false, autor: 'dueno', etiquetas: ['incidente-soporte', 'agente-corregir'], etiquetadoPor: 'dueno' },
  checks: ['build', 'db-tests', 'GitGuardian Security Checks'].map((nombre) => ({ nombre, conclusion: 'success', sha: SHA })),
  integradosHoy: 0,
});
const con = (f: (e: EntradaIntegracion) => void): EntradaIntegracion => { const e = ok(); f(e); return e; };
const no = (e: EntradaIntegracion, texto: RegExp) => { const d = decidir(politica, e); expect(d.elegible, d.motivos.join(' | ')).toBe(false); expect(d.accion).toBe('no'); expect(d.motivos.join(' | ')).toMatch(texto); };

describe('política de integración automática (fase 5)', () => {
  it('el archivo de política es válido y está en .github (fuera de lo permitido)', () => {
    expect(validarPolitica(politica)).toBe(true);
    const permitido = (r: string) => politica.permitidos.some((g) => globARegExp(g).test(r));
    for (const r of ['.github/agente-politica.json', '.github/workflows/ci.yml', 'database/migracion_v99.sql', 'package.json', 'backend/package.json', 'backend/scripts/x.mjs', 'backend/src/config/env.ts', 'backend/src/modules/auth/jwt.ts', 'backend/src/rndc/RndcClient.ts', 'backend/src/modules/agente/politicaIntegracion.ts', 'backend/src/modules/soporte/soporte.routes.ts', 'backend/src/modules/incidentes/captura.ts', 'backend/src/modules/chat/chat.service.ts', 'backend/src/modules/empresa/empresa.repo.ts', 'backend/src/modules/usuarios/usuarios.routes.ts', 'backend/src/modules/solicitudes/x.ts', 'backend/src/modules/cola/x.ts', 'backend/vitest.config.ts', 'frontend/src/lib/api.ts', 'frontend/src/store/auth.ts', 'backend/src/db/pool.ts']) expect(permitido(r), r).toBe(false);
  });

  it('un cambio pequeño, con prueba nueva, en una ruta permitida y con todo en verde es elegible: "activo" integra, "observar" solo observa', () => {
    expect(decidir(politica, ok())).toMatchObject({ elegible: true, accion: 'integrar', motivos: [] });
    expect(decidir(politica, con((e) => { e.modo = 'observar'; }))).toMatchObject({ elegible: true, accion: 'observar' });
  });

  it('modo apagado, ausente o desconocido: nunca integra', () => {
    for (const modo of ['', 'apagado', 'ACTIVO ', 'true', 'activo,observar']) { const d = decidir(politica, con((e) => { e.modo = modo; })); expect(d.accion).toBe('no'); expect(d.elegible).toBe(false); }
  });

  it('origen: base, borrador, cerrado, fork, autor, rama, commit', () => {
    no(con((e) => { e.pr.base = 'produccion'; }), /base/);
    no(con((e) => { e.pr.draft = true; }), /borrador/);
    no(con((e) => { e.pr.abierto = false; }), /abierto/);
    no(con((e) => { e.pr.headRepo = 'otro/repo'; }), /rama de este repositorio/);
    no(con((e) => { e.pr.autor = 'intruso'; }), /autor del PR/);
    no(con((e) => { e.pr.headSha = 'zz'; }), /commit/);
    for (const ref of ['agente/incidente-39:main', 'agente/incidente-39/x', 'agente/incidente-', 'agente/incidente-39 ', 'feature/x', 'agente/incidente-39;rm', 'AGENTE/incidente-39']) no(con((e) => { e.pr.headRef = ref; }), /rama/);
  });

  it('autorización: el issue debe ser de la app, con las dos etiquetas, y la de autorización puesta por el propietario', () => {
    no(con((e) => { e.issue = null; }), /issue/);
    no(con((e) => { e.issue!.autor = 'intruso'; }), /no lo creó la app/);
    no(con((e) => { e.issue!.etiquetas = ['agente-corregir']; }), /etiqueta de incidente/);
    no(con((e) => { e.issue!.etiquetas = ['incidente-soporte']; }), /etiqueta de autorización/);
    no(con((e) => { e.issue!.etiquetadoPor = 'intruso'; }), /no la puso el propietario/);
    no(con((e) => { e.issue!.etiquetadoPor = null; }), /no la puso el propietario/);
    no(con((e) => { e.issue!.numero = 12; }), /no corresponde/);
    no(con((e) => { e.issue!.esPr = true; }), /PR, no de un issue/);
    no(con((e) => { e.propietario = ''; }), /Faltan/);
  });

  it('rutas: solo la lista permitida, nada prohibido, nada raro; los nombres con trampas no pasan', () => {
    const rutas = ['.github/workflows/ci.yml', '.github/agente-politica.json', 'database/migracion_v99.sql', 'package.json', 'backend/src/config/env.ts', 'backend/src/modules/auth/jwt.ts', 'BACKEND/SRC/MODULES/AUTH/jwt.ts',
      'backend/src/rndc/RndcClient.ts', 'backend/src/modules/agente/politicaIntegracion.ts', 'frontend/src/pages/soporte/IncidentesPanel.tsx', 'frontend/src/lib/api.ts', 'backend/src/modules/impuestos/../auth/jwt.ts',
      '/etc/passwd', 'backend\\src\\modules\\auth\\jwt.ts', 'backend/src/modules/impuestos/./x.ts', 'backend//src/modules/impuestos/x.ts', 'backend/src/modules/impuestos/x.ts\n.github/x'];
    for (const r of rutas) no(con((e) => { e.archivos[0]!.filename = r; }), /Ruta|ruta/);
  });

  it('un rename desde una ruta no permitida descalifica (se revisa previous_filename)', () => {
    no(con((e) => { e.archivos[0] = { ...e.archivos[0]!, status: 'renamed', previous_filename: 'backend/src/modules/auth/jwt.ts' }; }), /Renombra|Estado de archivo/);
    no(con((e) => { e.archivos[0] = { ...e.archivos[0]!, status: 'modified', previous_filename: 'backend/src/modules/auth/jwt.ts' }; }), /Renombra/);
  });

  it('estados: solo added/modified; borrar o renombrar descalifica', () => {
    for (const status of ['removed', 'renamed', 'copied', 'changed', 'unchanged', '']) no(con((e) => { e.archivos[0]!.status = status; }), /Estado de archivo/);
  });

  it('pruebas: se exige al menos una NUEVA, y las existentes no se tocan (no se debilita una prueba para dar verde)', () => {
    no(con((e) => { e.archivos = [e.archivos[0]!]; e.pr.cambiados = 1; }), /ninguna prueba/);
    for (const status of ['modified', 'removed', 'renamed']) no(con((e) => { e.archivos[1]!.status = status; }), /AÑADIR pruebas|Estado de archivo/);
    no(con((e) => { e.archivos[1]!.filename = 'frontend/src/pages/x.test.tsx'; }), /ninguna prueba/); // una prueba fuera de backend/test no cuenta
  });

  it('contenido: .skip/.only/skipIf/process.env/child_process/eval en líneas añadidas descalifica; sin patch (no revisable) también', () => {
    for (const mal of ['it.skip("x", () => {})', 'it.only("x", () => {})', 'describe.skipIf(true)("x", () => {})', 'const k = process.env.JWT_SECRET', "import { exec } from 'node:child_process'", 'eval(x)', 'new Function("x")']) {
      no(con((e) => { e.archivos[1]!.patch = `@@ -0,0 +1 @@\n+${mal}`; }), /Contenido no permitido/);
      no(con((e) => { e.archivos[0]!.patch = `@@ -0,0 +1 @@\n+${mal}`; }), /Contenido no permitido/);
    }
    no(con((e) => { e.archivos[0]!.patch = null; }), /No se pudo revisar/);
    no(con((e) => { delete e.archivos[1]!.patch; }), /No se pudo revisar/);
    // Una línea BORRADA con ese texto no descalifica (se está quitando).
    expect(decidir(politica, con((e) => { e.archivos[0]!.patch = '@@ -1 +1 @@\n-  eval(x)\n+  const a = 1;'; })).elegible).toBe(true);
  });

  it('tamaño: máximo de archivos y de líneas; la lista de archivos debe cuadrar con el PR (si no, podría estar truncada)', () => {
    no(con((e) => { e.archivos[0]!.additions = 100; }), /demasiado grande/);
    no(con((e) => { e.archivos = Array.from({ length: 5 }, (_, i) => ({ ...e.archivos[0]!, filename: `backend/src/modules/impuestos/a${i}.ts` })); e.pr.cambiados = 5; e.archivos[4]!.filename = 'backend/test/n.test.ts'; }), /Demasiados archivos/);
    no(con((e) => { e.pr.cambiados = 3; }), /no coincide/);
    no(con((e) => { e.archivos = []; e.pr.cambiados = 0; }), /No hay archivos/);
  });

  it('checks: los tres deben existir y estar en verde sobre el MISMO commit; cualquier otra cosa, no', () => {
    for (const nombre of ['build', 'db-tests', 'GitGuardian Security Checks']) {
      no(con((e) => { e.checks = e.checks.filter((c) => c.nombre !== nombre); }), /Falta el check/);
      for (const conclusion of ['failure', 'cancelled', 'skipped', 'neutral', 'timed_out', null, 'success ']) no(con((e) => { e.checks.find((c) => c.nombre === nombre)!.conclusion = conclusion; }), /no está en verde/);
      no(con((e) => { e.checks.find((c) => c.nombre === nombre)!.sha = 'b'.repeat(40); }), /no está en verde/);
    }
    // Si un check con el mismo nombre falló y otro pasó, no vale (se exigen todos).
    no(con((e) => { e.checks.push({ nombre: 'build', conclusion: 'failure', sha: SHA }); }), /no está en verde/);
  });

  it('tope diario: llegando al tope, o sin poder contar, no integra', () => {
    no(con((e) => { e.integradosHoy = 3; }), /tope/);
    no(con((e) => { e.integradosHoy = null; }), /No se pudo contar/);
    expect(decidir(politica, con((e) => { e.integradosHoy = 2; })).elegible).toBe(true);
  });

  it('los motivos no repiten texto del agente sin neutralizar (nombres de archivo con @, #, backticks, saltos de línea)', () => {
    const d = decidir(politica, con((e) => { e.archivos[0]!.filename = 'backend/src/@mencion #12 `x`\n.ts'; }));
    expect(d.elegible).toBe(false);
    expect(d.motivos.join('\n')).not.toMatch(/[@#`]|\n\./);
    expect(seguro('a b@c#1`d\ne')).toBe('a?b?c?1?d?e');
  });

  it('falla cerrado: datos con formas inesperadas no integran ni lanzan', () => {
    expect(validarPolitica({})).toBe(false);
    expect(validarPolitica(null)).toBe(false);
    expect(validarPolitica({ ...politica, checksRequeridos: [] })).toBe(false);
    expect(validarPolitica({ ...politica, maxLineas: '80' })).toBe(false);
    const raro = ok() as unknown as { archivos: unknown };
    raro.archivos = [{ filename: 5 }];
    expect(decidir(politica, raro as unknown as EntradaIntegracion).elegible).toBe(false);
  });
});
