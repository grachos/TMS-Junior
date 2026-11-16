/**
 * FIXTURE de la prueba del agente de corrección en modo "activo" (soporte, fase 5). No lo importa ninguna ruta ni nada en producción.
 * Tiene un defecto A PROPÓSITO para comprobar el ciclo completo: el agente lo corrige con una prueba, el PR se integra solo y se despliega.
 * Está en una ruta permitida por la política a propósito. Se elimina al terminar la prueba.
 */

/** Da formato de pesos colombianos a un valor. Si no se indica el valor, devuelve "$0". */
export function formatearPeso(valor?: number): string {
  return '$' + (valor as number).toLocaleString('es-CO', { maximumFractionDigits: 0 });
}
