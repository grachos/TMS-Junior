/** Identidad de la instalación y de la versión desplegada (se registran en cada incidente). */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Una instalación = un sitio: SITE_ID, o el dominio de APP_URL, o "local". Los incidentes NUNCA se mezclan entre sitios. */
export function sitioId(env: NodeJS.ProcessEnv = process.env): string {
  const explicito = (env.SITE_ID ?? '').trim();
  if (explicito) return explicito.slice(0, 80);
  try {
    const host = new URL(env.APP_URL ?? '').hostname;
    if (host) return host.slice(0, 80);
  } catch {
    /* sin APP_URL válida */
  }
  return 'local';
}

let cache: string | null = null;
/** Commit desplegado: APP_COMMIT, o dist/build-info.json (escrito al compilar), o "desconocida". */
export function versionDespliegue(): string {
  if (cache) return cache;
  const env = (process.env.APP_COMMIT ?? '').trim();
  if (env) return (cache = env.slice(0, 64));
  try {
    const aqui = path.dirname(fileURLToPath(import.meta.url));
    const ruta = path.resolve(aqui, '..', '..', '..', 'dist', 'build-info.json');
    const alterna = path.resolve(aqui, '..', '..', 'build-info.json');
    for (const r of [alterna, ruta]) {
      if (existsSync(r)) {
        const j = JSON.parse(readFileSync(r, 'utf8')) as { commit?: string };
        if (j.commit) return (cache = String(j.commit).slice(0, 64));
      }
    }
  } catch {
    /* sin build-info */
  }
  return (cache = 'desconocida');
}
