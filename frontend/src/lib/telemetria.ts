/**
 * Konekto - Telemetría del navegador (errores no controlados, de React y fallos HTTP 5xx) hacia /api/reportes/telemetria.
 *
 * Es una fábrica PURA (sin tocar el store ni `window`): todo lo externo entra por `deps`, así se prueba sin navegador.
 * Reglas para que la propia telemetría NUNCA genere ciclos ni abuso:
 *  - solo con sesión (sin token, el login no reporta nada);
 *  - sin conexión no reporta; los errores de red/cancelación/extensiones se descartan (no son fallos del código);
 *  - tope por carga de página y deduplicación por tipo+mensaje+pantalla;
 *  - una sola llamada en vuelo: mientras se envía una, las demás se descartan;
 *  - el envío NUNCA lanza ni se reporta a sí mismo (si falla, se ignora);
 *  - se usa fetch directo (no api()), y api() no reporta las llamadas a /reportes.
 */

export type TipoTelemetria = 'error_js' | 'react' | 'http_5xx';

export interface EventoTelemetria {
  tipo: TipoTelemetria;
  mensaje: string;
  pila?: string;
  requestId?: string;
}

export interface DepsTelemetria {
  token: () => string | null;
  ruta: () => string;
  enLinea: () => boolean;
  /** Debe tragarse sus propios errores (nunca lanzar). */
  enviar: (cuerpo: Record<string, string>, token: string) => Promise<void>;
  maxPorPagina?: number;
}

/** Mensajes que no son un fallo del código de la aplicación (ruido del navegador, red, extensiones). */
const RUIDO = [
  /ResizeObserver loop/i,
  /^Script error\.?$/i,
  /Non-Error promise rejection/i,
  /Loading chunk .* failed/i,
  /Failed to fetch|NetworkError|Load failed|network request failed/i,
  /AbortError|The user aborted a request|signal is aborted/i,
  /reportes\/telemetria/i,
];

export function esRuido(mensaje: string): boolean {
  return RUIDO.some((r) => r.test(mensaje));
}

export function crearTelemetria(deps: DepsTelemetria) {
  const max = deps.maxPorPagina ?? 10;
  const vistos = new Set<string>();
  let enviados = 0;
  let enCurso = false;

  /** true si se envió; false si se descartó (por cualquier regla anterior). Nunca lanza. */
  async function reportar(e: EventoTelemetria): Promise<boolean> {
    try {
      const token = deps.token();
      if (!token) return false;
      if (!deps.enLinea()) return false;
      const mensaje = String(e.mensaje ?? '').slice(0, 500);
      if (!mensaje || esRuido(mensaje)) return false;
      const ruta = (deps.ruta() ?? '').slice(0, 300);
      const clave = `${e.tipo}|${mensaje}|${ruta}`;
      if (vistos.has(clave) || enviados >= max || enCurso) return false;
      vistos.add(clave);
      enviados += 1;
      enCurso = true;
      const cuerpo: Record<string, string> = { tipo: e.tipo, mensaje, ruta };
      if (e.pila) cuerpo.pila = String(e.pila).slice(0, 4000);
      if (e.requestId && /^[A-Za-z0-9_-]{8,64}$/.test(e.requestId)) cuerpo.requestId = e.requestId;
      await deps.enviar(cuerpo, token);
      return true;
    } catch {
      return false; // la telemetría nunca debe provocar un error
    } finally {
      enCurso = false;
    }
  }

  return { reportar };
}
