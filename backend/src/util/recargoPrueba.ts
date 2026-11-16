/**
 * FIXTURE de la prueba del agente de corrección en modo "observar" (soporte, fase 5). No lo importa ninguna ruta ni nada en producción.
 * Tiene un defecto A PROPÓSITO para comprobar que el agente lo corrige con una prueba y que la política de integración emite su veredicto.
 * Está en una ruta permitida por la política a propósito. Se elimina al terminar la prueba.
 */

/** Aplica un recargo porcentual al subtotal. Si no se indica la tasa, no hay recargo. */
export function calcularRecargo(subtotal: number, tasa?: number): number {
  const factor = Number((tasa as number).toFixed(2)) / 100;
  return Math.round(subtotal * (1 + factor) * 100) / 100;
}
