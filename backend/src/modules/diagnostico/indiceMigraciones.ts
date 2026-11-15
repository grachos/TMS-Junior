/**
 * Light TMS - Índice "tabla/columna → migración que la crea".
 *
 * En el servidor NO existen los archivos del repositorio (solo se publica la salida de la compilación), así que este índice se
 * GENERA AL COMPILAR (scripts/indice-migraciones.mjs → dist/migraciones-indice.json) con ESTA misma función; en el CI y en las
 * pruebas, donde no se compila, se genera leyendo `database/` del repositorio. Una sola implementación para los dos caminos.
 *
 * Se leen `CREATE TABLE [IF NOT EXISTS] x` y `ALTER TABLE x … ADD COLUMN [IF NOT EXISTS] y`. Lo que crea `schema.sql` se marca con
 * "schema.sql" (instalación incompleta: no es una migración suelta). Gana el primer archivo que lo crea (orden del instalador).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface IndiceMigraciones {
  /** "tabla" o "tabla.columna" → archivo que la crea. */
  objetos: Record<string, string>;
  generado: string;
}

const numero = (f: string) => Number(/^migracion_v(\d+)/.exec(f)?.[1] ?? NaN);
const ID = '`?([A-Za-z_][A-Za-z0-9_]*)`?';

export function generarIndice(dirDatabase: string): IndiceMigraciones {
  const objetos: Record<string, string> = {};
  const poner = (clave: string, archivo: string) => { if (!(clave in objetos)) objetos[clave] = archivo; };
  const archivos = ['schema.sql', ...readdirSync(dirDatabase).filter((f) => /^migracion_v\d+.*\.sql$/.test(f)).sort((a, b) => numero(a) - numero(b))];
  for (const archivo of archivos) {
    const ruta = path.join(dirDatabase, archivo);
    if (!existsSync(ruta)) continue;
    const sql = readFileSync(ruta, 'utf8').replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of sql.matchAll(new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${ID}`, 'gi'))) poner(m[1]!.toLowerCase(), archivo);
    for (const alter of sql.matchAll(new RegExp(`ALTER\\s+TABLE\\s+${ID}\\s+([^;]*);`, 'gi'))) {
      const tabla = alter[1]!.toLowerCase();
      for (const col of alter[2]!.matchAll(new RegExp(`ADD\\s+COLUMN\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${ID}`, 'gi'))) poner(`${tabla}.${col[1]!.toLowerCase()}`, archivo);
    }
  }
  return { objetos, generado: new Date().toISOString() };
}

let cache: IndiceMigraciones | null | undefined;

/** dist/migraciones-indice.json (escrito al compilar) o, sin compilar, el generado leyendo `database/` del repositorio; null si no hay ninguno. */
export function cargarIndice(): IndiceMigraciones | null {
  if (cache !== undefined) return cache;
  try {
    const aqui = path.dirname(fileURLToPath(import.meta.url));
    for (const r of [path.resolve(aqui, '..', '..', 'migraciones-indice.json'), path.resolve(aqui, '..', '..', '..', 'dist', 'migraciones-indice.json')]) {
      if (existsSync(r)) return (cache = JSON.parse(readFileSync(r, 'utf8')) as IndiceMigraciones);
    }
    const db = path.resolve(aqui, '..', '..', '..', '..', 'database');
    if (existsSync(path.join(db, 'schema.sql'))) return (cache = generarIndice(db));
  } catch {
    /* sin índice */
  }
  return (cache = null);
}
