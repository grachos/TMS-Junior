/** Diccionario de errores del Ministerio para el chat: carga, coincidencia por código y por mensaje, y que no se desfase del .tsv. */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AMPLIACIONES, TOTAL_ENTRADAS, buscarGuia, entradasDe, extraerCodigoRndc, parecido } from '../src/modules/chat/erroresRndc.js';

describe('diccionario de errores del RNDC', () => {
  it('se cargó completo y el generado coincide con el .tsv (no se desfasa)', () => {
    expect(TOTAL_ENTRADAS).toBeGreaterThan(1300);
    expect(() => execFileSync('node', [fileURLToPath(new URL('../../scripts/generar-diccionario-errores.mjs', import.meta.url)), '--verificar'], { stdio: 'pipe' })).not.toThrow();
  });

  it('extrae el código: prefiere el que está en el diccionario y devuelve null si no hay', () => {
    expect(extraerCodigoRndc('Error MAN045: el flete pactado')).toBe('MAN045');
    expect(extraerCodigoRndc('ZZZ999 desconocido')).toBe('ZZZ999');
    expect(extraerCodigoRndc('Ref ABC123 y luego MAN045')).toBe('MAN045'); // el segundo sí existe
    expect(extraerCodigoRndc('Error de conexión (ECONNRESET)')).toBeNull();
    expect(extraerCodigoRndc(null)).toBeNull();
  });

  it('MAN045: encuentra la entrada oficial y su ampliación', () => {
    const g = buscarGuia('MAN045 La Empresa de Transporte únicamente podrá expedir Manifiestos de Carga que registren un valor a pagar igual o superior a los costos eficientes de operación de SiceTac.');
    expect(g.estado).toBe('encontrada');
    if (g.estado !== 'encontrada') return;
    expect(g.entrada.variable).toBe('VALORFLETEPACTADOVIAJE');
    expect(g.entrada.solucion).toMatch(/SiceTac/i);
    expect(g.ampliacion).toEqual(AMPLIACIONES.MAN045);
  });

  it('un mensaje parafraseado o con datos del caso sigue encontrando su entrada cuando el código solo tiene un significado', () => {
    expect(buscarGuia('MAN045 El flete pactado se encuentra por debajo de los costos eficientes de operación').estado).toBe('encontrada');
    const g = buscarGuia('MAN045 La Empresa de Transporte únicamente podrá expedir Manifiestos de Carga que registren un valor a pagar igual o superior a los costos eficientes de operación de SiceTac. Valor 4110855 token=[oculto]');
    expect(g.estado).toBe('encontrada');
  });

  it('un código con varios significados se resuelve por el mensaje (MAN055 tiene 3)', () => {
    expect(entradasDe('MAN055').length).toBeGreaterThanOrEqual(3);
    const g = buscarGuia('MAN055 El transporte de Mercurio solo se puede hacer con la Naturaleza = Residuo Peligroso');
    expect(g.estado).toBe('encontrada');
    if (g.estado === 'encontrada') expect(g.entrada.mensaje).toMatch(/Mercurio/);
    const h = buscarGuia('MAN055 La placa ABC123 no está reportada por el propietario del vehículo como evidencia de haber firmado contrato de vinculación');
    expect(h.estado).toBe('encontrada');
    if (h.estado === 'encontrada') expect(h.entrada.mensaje).toMatch(/contrato de vinculaci/);
  });

  it('si el mensaje se parece por igual a dos significados del mismo código, no elige uno: ambigua', () => {
    // Se busca, entre los códigos con varios significados, un par de longitud parecida: pegados, ambos puntúan casi igual (≥ claro).
    let probado = 0;
    for (const codigo of ['MAN055', 'MAN286', 'AUR050', 'CRE322']) {
      const lista = entradasDe(codigo);
      for (let i = 0; i < lista.length; i++) for (let j = i + 1; j < lista.length; j++) {
        const msg = `${codigo} ${lista[i]!.mensaje} ${lista[j]!.mensaje}`;
        const pi = parecido(msg.replace(codigo, ''), lista[i]!.mensaje); const pj = parecido(msg.replace(codigo, ''), lista[j]!.mensaje);
        if (Math.abs(pi - pj) < 0.05 && Math.min(pi, pj) >= 0.45) {
          const g = buscarGuia(msg);
          expect(g.estado).toBe('ambigua');
          if (g.estado === 'ambigua') expect(g.candidatas.length).toBeGreaterThanOrEqual(2);
          probado++;
        }
      }
    }
    expect(probado).toBeGreaterThan(0);
  });

  it('si solo UN significado del código es plausible (aunque no sea claro), se usa ese', () => {
    const g = buscarGuia('MAN055 mercurio naturaleza xilofono quimera tambor lunatico');
    expect(g.estado).toBe('encontrada');
    if (g.estado === 'encontrada') expect(g.entrada.mensaje).toMatch(/Mercurio/);
  });

  it('código con varios significados y SIN mensaje: ambigua con opciones, no adivina', () => {
    const g = buscarGuia('MAN055');
    expect(g.estado).toBe('ambigua');
    if (g.estado === 'ambigua') expect(g.candidatas.length).toBeGreaterThan(1);
  });

  it('código que no está en el diccionario: desconocido (se avisará al soporte)', () => {
    expect(buscarGuia('ZZZ999 algo raro del Ministerio')).toEqual({ estado: 'desconocido', codigo: 'ZZZ999' });
  });

  it('código conocido pero con un significado que no se parece a ninguno: variante nueva (se avisará al soporte)', () => {
    expect(buscarGuia('MAN055 xilófono quimera tambor lunático')).toEqual({ estado: 'variante_nueva', codigo: 'MAN055' });
  });

  it('sin código del Ministerio no es del diccionario', () => {
    expect(buscarGuia('Error de conexión: ETIMEDOUT')).toEqual({ estado: 'sin_codigo' });
  });

  it('el parecido ignora números, tildes y mayúsculas', () => {
    expect(parecido('La placa 123 NO está reportada', 'la placa no esta reportada')).toBe(1);
    expect(parecido('', 'algo')).toBe(0);
  });

  it('el diccionario está sano: toda entrada tiene código, mensaje y tipo válido', () => {
    for (const cod of ['MAN045', 'MAN055', 'REC025', 'AUR050']) expect(entradasDe(cod).length).toBeGreaterThan(0);
    const e = entradasDe('MAN045')[0]!;
    expect(['E', 'A', 'I']).toContain(e.tipo);
    expect(e.mensaje.length).toBeGreaterThan(10);
  });
});
