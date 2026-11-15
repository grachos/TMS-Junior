/** Abre el panel de reportes del asistente desde cualquier parte (p. ej. desde la pantalla de error). */
export const EVENTO_REPORTAR = 'konekto:reportar';

export interface DetalleReportar {
  texto?: string;
}

export function abrirReporte(detalle: DetalleReportar = {}): void {
  window.dispatchEvent(new CustomEvent<DetalleReportar>(EVENTO_REPORTAR, { detail: detalle }));
}

/** ¿Hay un panel de reportes montado (sesión iniciada)? Los avisos de error solo ofrecen "Reportar" si es así. */
let panelMontado = false;
export const registrarPanelReportes = (v: boolean): void => { panelMontado = v; };
export const reporteDisponible = (): boolean => panelMontado;
