/**
 * FIXTURE de la prueba del flujo completo en producción (incidente -> issue -> agente -> PR -> main -> sitio de pruebas -> release).
 * No lo importa ninguna ruta ni nada en producción. Tiene un defecto A PROPÓSITO, en una ruta permitida por la política.
 * Se elimina al terminar la prueba.
 */

/** Da formato a un peso en kilos con separador de miles colombiano ("1.250 kg"). Si no se indica el valor, devuelve "0 kg". */
export function formatearKilos(valor?: number): string {
  return (valor as number).toLocaleString('es-CO', { maximumFractionDigits: 0 }) + ' kg';
}
