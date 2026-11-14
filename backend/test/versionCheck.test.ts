/**
 * Aviso de "hay una versión nueva": la pantalla abierta (una SPA) sigue
 * corriendo el código viejo hasta que se recarga. La comparación debe avisar
 * solo cuando el servidor informa claramente OTRA versión, y nunca dar una
 * falsa alarma (error de red, respuesta rara, entorno de desarrollo).
 */
import { describe, expect, it } from 'vitest';
import { hayVersionNueva } from '../../frontend/src/lib/versionCheck.js';

describe('hayVersionNueva', () => {
  it('avisa cuando el servidor tiene otra versión', async () => {
    expect(await hayVersionNueva('abc', async () => ({ id: 'xyz' }))).toBe(true);
  });
  it('no avisa si es la misma versión', async () => {
    expect(await hayVersionNueva('abc', async () => ({ id: 'abc' }))).toBe(false);
  });
  it('no avisa en desarrollo ni sin identificador propio', async () => {
    expect(await hayVersionNueva('dev', async () => ({ id: 'xyz' }))).toBe(false);
    expect(await hayVersionNueva('', async () => ({ id: 'xyz' }))).toBe(false);
  });
  it.each([
    ['un error de red', async () => { throw new Error('offline'); }],
    ['una respuesta que no es JSON', async () => { throw new SyntaxError('Unexpected token <'); }],
    ['un JSON sin id', async () => ({})],
    ['un id vacío', async () => ({ id: '' })],
    ['un id que no es texto', async () => ({ id: 42 })],
    ['null', async () => null],
  ])('no da una falsa alarma ante %s', async (_nombre, leer) => {
    expect(await hayVersionNueva('abc', leer)).toBe(false);
  });
});
