import { describe, expect, it } from 'vitest';
import { problemaSecretoJwt, JWT_SECRET_POR_DEFECTO } from '../src/modules/auth/jwt.js';

describe('problemaSecretoJwt: la API no arranca con un secreto falsificable', () => {
  it('rechaza el valor por defecto (público en el repositorio)', () => {
    expect(problemaSecretoJwt(JWT_SECRET_POR_DEFECTO)).toMatch(/no está configurado/);
  });
  it('rechaza un secreto vacío', () => {
    expect(problemaSecretoJwt('')).toMatch(/no está configurado/);
  });
  it('rechaza un secreto corto', () => {
    expect(problemaSecretoJwt('corto-123')).toMatch(/demasiado corto/);
  });
  it('acepta un secreto aleatorio de 32+ caracteres', () => {
    expect(problemaSecretoJwt('k'.repeat(16) + 'Zx9_-aQ2mP7rT4wY')).toBeNull();
  });
});
