/**
 * Light TMS - Shared validations. Port of validarProductoPeligrosa() from helpers.php.
 */

import { productoPorCodigo } from '../modules/catalogos/catalogo.repo.js';

/**
 * Ensures a dangerous-nature product has codigo_un and estado_producto.
 * Returns null if valid, or an error message otherwise.
 */
export async function validarProductoPeligrosa(codigo: string, naturaleza: string): Promise<string | null> {
  if (naturaleza !== '2' || codigo === '') return null;
  const prod = await productoPorCodigo(codigo);
  if (prod === null) return null;
  if (!prod.codigo_un || !prod.estado_producto) {
    return 'El producto es de naturaleza peligrosa pero le falta Código UN y/o Estado del producto. Edítalo en Productos primero.';
  }
  return null;
}

/**
 * The RNDC requires <CONTENEDORSERIAL> on the Remesa when the operación de
 * transporte is Contenedor Cargado (C) or Contenedor Vacío (V) — an 11-char
 * ISO 6346 container id (e.g. "SMLU7924873"). Returns null if valid/not
 * applicable, or an error message otherwise.
 */
export function validarContenedorSerial(operacionTransporte: string, contenedorSerial: string): string | null {
  if (operacionTransporte !== 'C' && operacionTransporte !== 'V') return null;
  if (contenedorSerial.trim().length !== 11) {
    return 'El serial del contenedor es obligatorio (11 caracteres) cuando la operación de transporte es Contenedor Cargado o Contenedor Vacío.';
  }
  return null;
}
