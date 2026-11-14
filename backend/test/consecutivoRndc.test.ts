import { describe, expect, it } from 'vitest';
import { consecutivoRemesaRndc } from '../src/util/consecutivoRndc.js';

describe('consecutivoRemesaRndc', () => {
  it('formatea el número oficial REM-00007 como el consecutivo de 10 dígitos del RNDC', () => {
    expect(consecutivoRemesaRndc('REM-00007')).toBe('0000000007');
  });

  it('un número INTERNO se devuelve tal cual: no debe parecer un consecutivo del RNDC', () => {
    // Antes de este cambio, INT-R-00001 se convertía en 0000000001, el mismo
    // número que la remesa oficial REM-00001.
    expect(consecutivoRemesaRndc('INT-R-00001')).toBe('INT-R-00001');
    expect(consecutivoRemesaRndc('INT-R-00042')).toBe('INT-R-00042');
  });
});
