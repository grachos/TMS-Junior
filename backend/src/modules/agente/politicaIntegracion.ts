/**
 * Light TMS - Política de INTEGRACIÓN automática de los PR del agente (fase 5). PURA y sin I/O: decide con datos que el workflow
 * reúne por API (nunca ejecuta código del PR). La política es un archivo (`.github/agente-politica.json`) que se lee de `main`.
 *
 * Todo falla CERRADO: un dato ausente, un estado desconocido o una cantidad que no cuadra dejan el PR para revisión humana.
 * Reglas de fondo:
 *  - solo rutas de una LISTA PERMITIDA (y fuera de la lista de prohibidas); `.github/**`, migraciones, configuración, autenticación,
 *    RNDC y el propio módulo de soporte nunca están permitidos;
 *  - solo se AÑADEN pruebas: modificar/borrar/renombrar una prueba existente descalifica (no se debilita una prueba para dar verde);
 *  - los checks (incluido GitGuardian) deben estar en verde sobre EL MISMO commit que se va a integrar;
 *  - el issue debe haberlo creado la app y la etiqueta de autorización debe haberla puesto el propietario.
 */

export interface PoliticaIntegracion {
  version: number;
  base: string;
  prefijoRama: string;
  maxArchivos: number;
  maxLineas: number;
  maxPorDia: number;
  checksRequeridos: string[];
  etiquetaIncidente: string;
  etiquetaDisparador: string;
  permitidos: string[];
  prohibidos: string[];
  archivosDePrueba: string[];
  patronesProhibidos: string[];
}

export interface ArchivoPR { filename: string; status: string; additions: number; deletions: number; previous_filename?: string | null; patch?: string | null }

export interface EntradaIntegracion {
  /** Valor de la variable AGENTE_INTEGRACION: "observar" | "activo"; cualquier otra cosa = apagado. */
  modo: string;
  propietario: string;
  autorIssues: string;
  repo: string;
  pr: { numero: number; base: string; headRef: string; headRepo: string; draft: boolean; autor: string; headSha: string; cambiados: number; abierto: boolean };
  archivos: ArchivoPR[];
  issue: { numero: number; esPr: boolean; autor: string; etiquetas: string[]; etiquetadoPor: string | null } | null;
  checks: { nombre: string; conclusion: string | null; sha: string }[];
  integradosHoy: number | null;
}

export interface Decision { accion: 'integrar' | 'observar' | 'no'; elegible: boolean; motivos: string[] }

export function validarPolitica(p: unknown): p is PoliticaIntegracion {
  const o = p as Partial<PoliticaIntegracion> | null;
  const lista = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  return Boolean(o && o.version === 1 && typeof o.base === 'string' && typeof o.prefijoRama === 'string'
    && Number.isInteger(o.maxArchivos) && Number.isInteger(o.maxLineas) && Number.isInteger(o.maxPorDia)
    && lista(o.checksRequeridos) && (o.checksRequeridos as string[]).length > 0 && typeof o.etiquetaIncidente === 'string' && typeof o.etiquetaDisparador === 'string'
    && lista(o.permitidos) && lista(o.prohibidos) && lista(o.archivosDePrueba) && lista(o.patronesProhibidos));
}

/** `**` cruza carpetas, `*` no; todo lo demás es literal. Sin distinguir mayúsculas (más estricto, no menos). */
export function globARegExp(glob: string): RegExp {
  let r = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') { r += '.*'; i += 1; if (glob[i + 1] === '/') i += 1; } else r += '[^/]*';
    } else r += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${r}$`, 'i');
}

const coincide = (ruta: string, globs: string[]) => globs.some((g) => globARegExp(g).test(ruta));

/** Una ruta rara (absoluta, con `..`, contrabarra, caracteres de control) no se evalúa: descalifica. */
function rutaValida(r: unknown): r is string {
  return typeof r === 'string' && r.length > 0 && r.length < 300 && !r.startsWith('/') && !r.includes('..') && !r.includes('\\')
    // eslint-disable-next-line no-control-regex
    && !/[\u0000-\u001f]/.test(r) && !r.split('/').some((s) => s === '' || s === '.');
}

/** Texto seguro para repetir en un comentario (el nombre de un archivo lo elige el agente). */
export const seguro = (v: unknown): string => String(v ?? '').replace(/[^\w./-]/g, '?').slice(0, 120);

const HEX40 = /^[0-9a-f]{40}$/;

export function decidir(politica: PoliticaIntegracion, e: EntradaIntegracion): Decision {
  const m: string[] = [];
  const modo = e.modo === 'activo' || e.modo === 'observar' ? e.modo : null;
  if (!modo) m.push('La integración automática está apagada.');

  // --- identidad y origen
  if (!e.propietario || !e.autorIssues) m.push('Faltan AGENTE_PROPIETARIO / AGENTE_AUTOR_ISSUES.');
  if (e.pr.base !== politica.base) m.push(`La base no es ${seguro(politica.base)}.`);
  if (!e.pr.abierto) m.push('El PR no está abierto.');
  if (e.pr.draft) m.push('El PR es un borrador.');
  if (!e.repo || e.pr.headRepo !== e.repo) m.push('El PR no viene de una rama de este repositorio.');
  if (!e.autorIssues || e.pr.autor !== e.autorIssues) m.push('El autor del PR no es la cuenta del agente.');
  if (!HEX40.test(e.pr.headSha)) m.push('El commit del PR no es válido.');
  const rama = /^agente\/incidente-(\d{1,9})$/.exec(e.pr.headRef);
  if (!e.pr.headRef.startsWith(politica.prefijoRama) || !rama) m.push('La rama no tiene el formato esperado.');

  // --- autorización del propietario sobre ESTE issue
  const num = rama ? Number(rama[1]) : -1;
  if (!e.issue) m.push('No se pudo leer el issue.');
  else {
    if (e.issue.numero !== num) m.push('El issue no corresponde a la rama.');
    if (e.issue.esPr) m.push('El número de la rama es de un PR, no de un issue.');
    if (!e.autorIssues || e.issue.autor !== e.autorIssues) m.push('El issue no lo creó la app.');
    if (!e.issue.etiquetas.includes(politica.etiquetaIncidente)) m.push('El issue no tiene la etiqueta de incidente.');
    if (!e.issue.etiquetas.includes(politica.etiquetaDisparador)) m.push('El issue no tiene la etiqueta de autorización.');
    if (!e.propietario || e.issue.etiquetadoPor !== e.propietario) m.push('La etiqueta de autorización no la puso el propietario.');
  }

  // --- archivos
  const a = e.archivos;
  if (!Array.isArray(a) || a.length === 0) m.push('No hay archivos que evaluar.');
  else {
    if (a.length !== e.pr.cambiados) m.push('La lista de archivos no coincide con el PR (podría estar incompleta).');
    if (a.length > politica.maxArchivos) m.push(`Demasiados archivos (${a.length} > ${politica.maxArchivos}).`);
    const lineas = a.reduce((s, f) => s + Number(f.additions || 0) + Number(f.deletions || 0), 0);
    if (!Number.isFinite(lineas) || lineas > politica.maxLineas) m.push(`Cambio demasiado grande (${lineas} líneas > ${politica.maxLineas}).`);
    let pruebasNuevas = 0;
    const patrones = politica.patronesProhibidos.map((p) => new RegExp(p));
    for (const f of a) {
      if (!rutaValida(f.filename)) { m.push('Hay una ruta de archivo no válida.'); continue; }
      const n = seguro(f.filename);
      if (f.previous_filename && (!rutaValida(f.previous_filename) || coincide(f.previous_filename, politica.prohibidos) || !coincide(f.previous_filename, politica.permitidos))) m.push(`Renombra desde una ruta no permitida: ${n}.`);
      if (!coincide(f.filename, politica.permitidos)) m.push(`Ruta fuera de la lista permitida: ${n}.`);
      if (coincide(f.filename, politica.prohibidos)) m.push(`Ruta prohibida: ${n}.`);
      const esPrueba = coincide(f.filename, politica.archivosDePrueba);
      if (f.status !== 'added' && f.status !== 'modified') m.push(`Estado de archivo no permitido (${seguro(f.status)}): ${n}.`);
      if (esPrueba) {
        if (f.status !== 'added') m.push(`Solo se pueden AÑADIR pruebas, no modificar ni borrar las existentes: ${n}.`);
        else pruebasNuevas += 1;
      }
      // Líneas añadidas: sin patrones peligrosos. Sin `patch` (diff grande o binario) no se puede revisar: descalifica.
      if (typeof f.patch !== 'string') m.push(`No se pudo revisar el contenido de ${n}.`);
      else {
        const anadidas = f.patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
        for (const re of patrones) if (re.test(anadidas)) m.push(`Contenido no permitido en ${n} (${seguro(re.source)}).`);
      }
    }
    if (pruebasNuevas === 0) m.push('El cambio no añade ninguna prueba.');
  }

  // --- checks sobre el MISMO commit
  for (const req of politica.checksRequeridos) {
    const c = e.checks.filter((x) => x.nombre === req);
    if (c.length === 0) m.push(`Falta el check ${seguro(req)}.`);
    else if (!c.every((x) => x.sha === e.pr.headSha && x.conclusion === 'success')) m.push(`El check ${seguro(req)} no está en verde sobre este commit.`);
  }

  // --- tope diario
  if (e.integradosHoy === null || !Number.isInteger(e.integradosHoy)) m.push('No se pudo contar las integraciones de hoy.');
  else if (e.integradosHoy >= politica.maxPorDia) m.push(`Ya se integraron ${e.integradosHoy} cambios del agente en 24 h (tope ${politica.maxPorDia}).`);

  const elegible = m.length === 0;
  return { elegible, motivos: m, accion: !elegible ? 'no' : modo === 'activo' ? 'integrar' : 'observar' };
}
