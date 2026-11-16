import { describe, it, expect } from 'vitest';
import { calcularDescuento } from '../src/modules/soporte/pruebaAgente';

describe('calcularDescuento', () => {
  it('sin porcentaje no hay descuento (no lanza error)', () => {
    expect(calcularDescuento(100)).toBe(100);
    expect(calcularDescuento(100, undefined)).toBe(100);
  });
  it('aplica el porcentaje indicado', () => {
    expect(calcularDescuento(200, 10)).toBe(180);
  });
});
