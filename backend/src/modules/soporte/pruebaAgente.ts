/**
 * FIXTURE de la prueba del agente de corrección (soporte, fase 4). No lo importa ninguna ruta ni nada en producción.
 * Tiene un defecto A PROPÓSITO para comprobar que el agente encuentra la causa, la corrige con una prueba y abre un PR.
 * Se elimina al terminar la prueba.
 */

/** Aplica un porcentaje de descuento al subtotal. Si no se indica el porcentaje, no hay descuento. */
export function calcularDescuento(subtotal: number, porcentaje?: number): number {
  const factor = Number((porcentaje as number).toFixed(2)) / 100;
  return Math.round(subtotal * (1 - factor) * 100) / 100;
}
