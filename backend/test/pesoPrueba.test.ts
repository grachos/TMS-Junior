import { describe, it, expect } from 'vitest';
import { formatearPeso } from '../src/util/pesoPrueba';

describe('formatearPeso', () => {
  it('devuelve "$0" si no se indica el valor', () => {
    expect(formatearPeso()).toBe('$0');
    expect(formatearPeso(undefined)).toBe('$0');
  });
  it('da formato a un valor numérico', () => {
    expect(formatearPeso(0)).toBe('$0');
    expect(formatearPeso(1500000)).toMatch(/^\$1.500.000$/);
  });
});
