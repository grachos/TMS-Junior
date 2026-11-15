/**
 * Light TMS - Captura de errores del SERVIDOR como incidentes.
 *
 * Reglas de seguridad de la propia telemetría:
 *  - se ejecuta DESPUÉS de responder y sin esperar (fire-and-forget): nunca retrasa ni cambia la respuesta;
 *  - nunca lanza: un fallo al registrar se traga (un corte de la base no debe multiplicar errores);
 *  - interruptor: si el registro falla, se deja de capturar ~60 s;
 *  - solo 5xx; nunca errores de /api/reportes ni /api/soporte (la telemetría no se reporta a sí misma);
 *  - los rechazos del RNDC no se convierten en incidentes aquí: ya viven en la cola de envíos;
 *  - todo se sanitiza ANTES de guardar.
 */

import { clasificarError } from './clasificar.js';
import { registrarOcurrencia } from './incidentes.repo.js';
import { avisarPropietario } from './notificar.js';
import { huella, normalizarRuta, sanitizarPila, sanitizarTexto } from './sanitizar.js';
import { sitioId, versionDespliegue } from './version.js';

const PAUSA_MS = 60_000;
let pausadoHasta = 0;
/** Solo pruebas. */
export function reiniciarInterruptor(): void { pausadoHasta = 0; }

export interface ErrorServidor {
  err: unknown;
  status: number;
  metodo: string;
  ruta: string;
  requestId?: string;
  usuarioId?: number | null;
}

export async function capturarErrorServidor(e: ErrorServidor): Promise<void> {
  try {
    if (e.status < 500) return;
    const operacion = `${e.metodo} ${normalizarRuta(e.ruta)}`;
    if (/^\w+ \/api\/(reportes|soporte)(\/|$)/.test(operacion)) return; // la telemetría no se reporta a sí misma
    if (Date.now() < pausadoHasta) return;
    const mensaje = e.err instanceof Error ? e.err.message : String(e.err);
    if (/rechaz[oó] el documento|rndc.*rechaz/i.test(mensaje) && !/ECONN|ETIMEDOUT/.test(mensaje)) return; // rechazo de negocio del RNDC
    const c = clasificarError(e.err, { status: e.status, ruta: normalizarRuta(e.ruta) });
    const sitio = sitioId();
    const msg = sanitizarTexto(mensaje, 300);
    const evidencia = JSON.stringify({
      metodo: e.metodo, ruta: normalizarRuta(e.ruta), status: e.status, codigo: c.codigo, mensaje: msg,
      pila: e.err instanceof Error ? sanitizarPila(e.err.stack) : '',
    });
    const r = await registrarOcurrencia({
      sitio, huella: huella({ sitio, tipo: c.tipo, operacion, codigo: c.codigo, mensaje: msg }), tipo: c.tipo, origen: 'servidor',
      severidad: c.severidad, corregible: c.corregible, titulo: `${operacion}: ${msg || 'error'}`.slice(0, 200), operacion, codigo: c.codigo,
      version: versionDespliegue(), evidencia: { tipo: 'servidor', contenido: evidencia, usuarioId: e.usuarioId ?? null, requestId: e.requestId ?? null },
    });
    if (r.nuevo) void avisarPropietario({ title: 'Nuevo incidente', body: `${c.tipo}: ${operacion}`, url: '/soporte', tag: `incidente-${r.id}` });
  } catch {
    pausadoHasta = Date.now() + PAUSA_MS; // si registrar falla, se calla un minuto
  }
}
