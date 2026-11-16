/**
 * Guardia de regresión del workflow del agente (.github/workflows/agente-correccion.yml): sus permisos son la última línea de defensa
 * frente a un agente engañado, así que NO deben aflojarse sin que una prueba lo diga. Es una comprobación estática del texto: no ejecuta nada.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const texto = readFileSync(new URL('../../.github/workflows/agente-correccion.yml', import.meta.url), 'utf8');
const lista = (flag: string): string[] => {
  const m = new RegExp(`--${flag} "([^"]*)"`).exec(texto);
  expect(m, `falta --${flag}`).not.toBeNull();
  return m![1]!.split(/,(?![^()]*\))/).map((x) => x.trim()).filter(Boolean);
};
const permitidas = lista('allowedTools');
const denegadas = lista('disallowedTools');

describe('workflow del agente: permisos', () => {
  it('solo puede publicar en la rama EXACTA de su issue y abrir PR contra main (sin comodines que admitan `rama:main`)', () => {
    const bash = permitidas.filter((p) => p.startsWith('Bash(git push') || p.startsWith('Bash(gh '));
    expect(bash).toEqual([
      'Bash(git push origin agente/incidente-${{ github.event.issue.number }})',
      'Bash(gh pr create --base main --head agente/incidente-${{ github.event.issue.number }}:*)',
    ]);
    expect(texto).not.toMatch(/git push origin agente\/\*/);
    for (const p of permitidas) expect(p, p).not.toMatch(/gh (pr merge|issue edit|api|release|workflow|secret|repo)|git (push --force|push -f|remote|config|reset|rebase|merge)/);
  });

  it('no puede tocar lo que cambia la compilación, la configuración del agente ni el despliegue (reglas de denegación por ruta)', () => {
    for (const r of ['Edit(package.json)', 'Edit(package-lock.json)', 'Edit(.npmrc)', 'Edit(vite.config.*)', 'Edit(vitest.config.*)', 'Edit(tsconfig*.json)', 'Edit(/.github/**)', 'Edit(/.claude/**)', 'Edit(CLAUDE.md)', 'Edit(/database/**)', 'Edit(/backend/scripts/**)', 'Edit(**/.env*)']) expect(denegadas, r).toContain(r);
  });

  it('no puede instalar dependencias, ejecutar paquetes ni usar la red desde la terminal', () => {
    for (const r of ['Bash(npm install:*)', 'Bash(npm ci:*)', 'Bash(npx:*)', 'Bash(curl:*)', 'Bash(wget:*)']) expect(denegadas, r).toContain(r);
  });

  it('las reglas de escritura usan Edit(...) (Write(...) por ruta no se aplica) y ninguna denegación contradice un permiso', () => {
    expect(denegadas.filter((r) => r.startsWith('Write('))).toEqual([]);
    for (const d of denegadas) expect(permitidas, d).not.toContain(d);
  });

  it('no deja la salida completa del agente (los logs de un repo público lo son) ni usa el token por defecto para abrir el PR', () => {
    expect(texto).not.toMatch(/^\s*show_full_output:\s*true/m);
    expect(texto).toMatch(/GH_TOKEN: \$\{\{ secrets\.AGENTE_GITHUB_TOKEN \}\}/);
  });
});
