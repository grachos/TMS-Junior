/**
 * Konekto - Tipo de viaje de la solicitud ("NACIONAL" | "URBANO").
 *
 * En un viaje urbano el cumplido de la REMESA no se envía al RNDC; solo se
 * reporta el cumplido del manifiesto.
 */

export function esViajeUrbano(tipoViaje: unknown): boolean {
  return String(tipoViaje ?? '').trim().toUpperCase() === 'URBANO';
}
