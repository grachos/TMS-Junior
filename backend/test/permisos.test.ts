import { describe, expect, it } from 'vitest';
import { ACCIONES, ACCIONES_POR_DEFECTO, normalizarAcciones, tieneAccion } from '../src/modules/auth/permisos.js';

describe('permisos por acción', () => {
  it('el administrador puede todo, con cualquier configuración', () => {
    for (const a of ACCIONES) {
      expect(tieneAccion({ rol: 'admin', acciones: null }, a)).toBe(true);
      expect(tieneAccion({ rol: 'admin', acciones: [] }, a)).toBe(true);
    }
  });

  it('un operador sin configurar conserva lo que ya podía: despachar, Interna, editar despacho, cumplido; nada crítico', () => {
    expect(ACCIONES_POR_DEFECTO.sort()).toEqual(['cumplido.guardar', 'despacho.editar', 'solicitud.despachar', 'solicitud.interna']);
    expect(tieneAccion({ rol: 'operador', acciones: null }, 'solicitud.despachar')).toBe(true);
    for (const a of ['despacho.anular', 'despacho.enviar', 'cola.procesar', 'cola.anular', 'empresa.editar', 'impuestos.gestionar'] as const) {
      expect(tieneAccion({ rol: 'operador', acciones: null }, a)).toBe(false);
    }
  });

  it('con una lista, el operador tiene SOLO esas acciones (incluso quitando las de siempre)', () => {
    const u = { rol: 'operador' as const, acciones: ['cola.procesar' as const] };
    expect(tieneAccion(u, 'cola.procesar')).toBe(true);
    expect(tieneAccion(u, 'solicitud.despachar')).toBe(false);
    expect(tieneAccion({ rol: 'operador', acciones: [] }, 'cola.procesar')).toBe(false);
  });

  it('normalizar descarta claves inventadas o repetidas (nunca dan permiso)', () => {
    expect(normalizarAcciones(['cola.procesar', 'cola.procesar', 'hackear.todo'])).toEqual(['cola.procesar']);
    expect(normalizarAcciones(null)).toBeNull();
    expect(tieneAccion({ rol: 'operador', acciones: ['hackear.todo'] }, 'cola.procesar')).toBe(false);
  });
});
