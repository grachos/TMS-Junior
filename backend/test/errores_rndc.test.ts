/** Guía de errores del Ministerio para el chat: coincidencia por código y por mensaje, y catálogo sano. */
import { describe, expect, it } from 'vitest';
import { GUIAS_ERROR_RNDC, extraerCodigoRndc, guiaDeError } from '../src/modules/chat/erroresRndc.js';

describe('guía de errores del RNDC', () => {
  it('extrae el código del mensaje', () => {
    expect(extraerCodigoRndc('MAN045: el flete pactado está por debajo')).toBe('MAN045');
    expect(extraerCodigoRndc('Error ABC123 en el campo')).toBe('ABC123');
    expect(extraerCodigoRndc('sin código aquí')).toBeNull();
    expect(extraerCodigoRndc(null)).toBeNull();
    expect(extraerCodigoRndc('minúscula man045')).toBeNull();
  });

  it('encuentra la guía por código exacto', () => {
    expect(guiaDeError('MAN045: lo que sea')?.codigo).toBe('MAN045');
    expect(guiaDeError('XXX999: desconocido')).toBeNull();
  });

  it('encuentra la guía por el texto cuando el mensaje llega sin código', () => {
    expect(guiaDeError('El flete pactado se encuentra por debajo de los costos eficientes de operación')?.codigo).toBe('MAN045');
    expect(guiaDeError('otro mensaje cualquiera')).toBeNull();
  });

  it('un código desconocido NO se resuelve con la guía de otro error aunque el texto no coincida', () => {
    expect(guiaDeError('MAN999: algo distinto')).toBeNull();
  });

  it('el catálogo está sano: códigos únicos y válidos, sin campos vacíos, con al menos un paso', () => {
    const codigos = GUIAS_ERROR_RNDC.map((g) => g.codigo);
    expect(new Set(codigos).size).toBe(codigos.length);
    for (const g of GUIAS_ERROR_RNDC) {
      expect(g.codigo).toMatch(/^[A-Z]{3}\d{3}$/);
      expect(g.significado.trim().length).toBeGreaterThan(10);
      expect(g.causa.trim().length).toBeGreaterThan(10);
      expect(g.solucion.length).toBeGreaterThan(0);
      for (const paso of g.solucion) expect(paso.trim().length).toBeGreaterThan(5);
    }
  });
});
