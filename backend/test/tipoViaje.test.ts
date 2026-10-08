import { describe, expect, it } from 'vitest';
import { esViajeUrbano } from '../src/util/tipoViaje.js';

describe('esViajeUrbano', () => {
  it('reconoce URBANO sin importar mayúsculas ni espacios', () => {
    expect(esViajeUrbano('URBANO')).toBe(true);
    expect(esViajeUrbano('Urbano')).toBe(true);
    expect(esViajeUrbano('  urbano ')).toBe(true);
  });

  it('NACIONAL y valores vacíos no son urbanos (el cumplido de remesa sí se envía)', () => {
    expect(esViajeUrbano('NACIONAL')).toBe(false);
    expect(esViajeUrbano('')).toBe(false);
    expect(esViajeUrbano(null)).toBe(false);
    expect(esViajeUrbano(undefined)).toBe(false);
  });
});
