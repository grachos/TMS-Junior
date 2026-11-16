import { describe, expect, it } from 'vitest';
import { calcularRecargo } from '../src/util/recargoPrueba.js';

describe('calcularRecargo', () => {
  it('sin tasa no aplica recargo', () => {
    expect(calcularRecargo(100)).toBe(100);
    expect(calcularRecargo(100, undefined)).toBe(100);
  });
  it('aplica la tasa porcentual', () => {
    expect(calcularRecargo(100, 10)).toBe(110);
  });
});
