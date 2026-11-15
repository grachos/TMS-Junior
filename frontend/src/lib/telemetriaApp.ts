/** Konekto - Telemetría conectada a la aplicación (store de sesión, ventana, fetch directo). */

import { useAuthStore } from '../store/auth';
import { crearTelemetria } from './telemetria';

export const telemetria = crearTelemetria({
  token: () => useAuthStore.getState().token,
  ruta: () => window.location.pathname,
  enLinea: () => navigator.onLine,
  enviar: async (cuerpo, token) => {
    try {
      // fetch directo, NO api(): así un fallo de la telemetría no pasa por el flujo que la dispara.
      await fetch('/api/reportes/telemetria', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(cuerpo),
        keepalive: true,
      });
    } catch {
      /* se ignora: no se reintenta ni se reporta */
    }
  },
});

let instalada = false;
/** Errores no controlados y promesas rechazadas. Se instala una sola vez. */
export function instalarTelemetriaGlobal(): void {
  if (instalada || typeof window === 'undefined') return;
  instalada = true;
  window.addEventListener('error', (ev) => {
    // Un error de un script ajeno (extensiones, otros orígenes) no trae archivo ni línea: no es nuestro.
    if (!ev.filename && !ev.lineno) return;
    void telemetria.reportar({ tipo: 'error_js', mensaje: ev.message || 'Error no controlado', pila: ev.error instanceof Error ? ev.error.stack : undefined });
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev.reason;
    void telemetria.reportar({ tipo: 'error_js', mensaje: r instanceof Error ? r.message : typeof r === 'string' ? r : 'Promesa rechazada', pila: r instanceof Error ? r.stack : undefined });
  });
}
