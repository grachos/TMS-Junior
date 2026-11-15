import { describe, expect, it } from 'vitest';
import { coincidePropietario, vinculoPropietario } from '../src/modules/auth/propietario.js';

const U = '3f2b8c1e-5a4d-4e7f-9b6a-1c2d3e4f5a6b';

describe('vínculo del propietario (funciones puras)', () => {
  it('sin configurar o con basura no hay propietario', () => {
    expect(vinculoPropietario({})).toEqual({ ok: false, motivo: 'no_configurado' });
    expect(vinculoPropietario({ PLATFORM_OWNER_UUID: '   ' })).toEqual({ ok: false, motivo: 'no_configurado' });
    for (const malo of ['1', 'admin', U.slice(1), `${U}0`, 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz', "' OR 1=1 --"]) {
      expect(vinculoPropietario({ PLATFORM_OWNER_UUID: malo })).toEqual({ ok: false, motivo: 'invalido' });
    }
  });

  it('un uuid válido se acepta sin importar mayúsculas ni espacios', () => {
    expect(vinculoPropietario({ PLATFORM_OWNER_UUID: ` ${U.toUpperCase()} ` })).toEqual({ ok: true, uuid: U });
  });

  it('solo el uuid configurado coincide; vacío, null, otro o configuración inválida nunca', () => {
    const env = { PLATFORM_OWNER_UUID: U };
    expect(coincidePropietario(U, env)).toBe(true);
    expect(coincidePropietario(U.toUpperCase(), env)).toBe(true);
    expect(coincidePropietario('', env)).toBe(false);
    expect(coincidePropietario(null, env)).toBe(false);
    expect(coincidePropietario(undefined, env)).toBe(false);
    expect(coincidePropietario('3f2b8c1e-5a4d-4e7f-9b6a-1c2d3e4f5a6c', env)).toBe(false);
    expect(coincidePropietario(U, {})).toBe(false);
    expect(coincidePropietario(U, { PLATFORM_OWNER_UUID: 'basura' })).toBe(false);
    expect(coincidePropietario('basura', { PLATFORM_OWNER_UUID: 'basura' })).toBe(false); // config inválida: ni siquiera igual a sí misma
  });
});
