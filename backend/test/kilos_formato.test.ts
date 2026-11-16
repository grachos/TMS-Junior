import { describe, expect, it } from 'vitest';
import { formatearKilos } from '../src/util/kilosPrueba.js';

describe('formatearKilos', () => {
  it('sin valor devuelve "0 kg" en vez de lanzar error', () => {
    expect(formatearKilos()).toBe('0 kg');
    expect(formatearKilos(undefined)).toBe('0 kg');
  });
  it('formatea con separador de miles', () => {
    expect(formatearKilos(1250)).toMatch(/^1\.?250 kg$/);
  });
});
