/** Abre el panel de reportes del asistente desde cualquier parte (p. ej. desde la pantalla de error). */
export const EVENTO_REPORTAR = 'konekto:reportar';

export interface DetalleReportar {
  texto?: string;
}

export function abrirReporte(detalle: DetalleReportar = {}): void {
  window.dispatchEvent(new CustomEvent<DetalleReportar>(EVENTO_REPORTAR, { detail: detalle }));
}
