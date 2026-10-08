/**
 * Viaje urbano: el cumplido de remesa no se encola ni se envía al RNDC (solo el
 * del manifiesto). Estas pruebas usan una conexión simulada — no hay MySQL — y
 * revisan qué filas se insertan en cola_envios y qué se borra.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Call = { sql: string; params: unknown[] };
const calls: Call[] = [];
let tipoViaje: string | null = 'NACIONAL';

function respond(sql: string, params: unknown[]): unknown[] {
  if (sql.includes('SELECT tipo_viaje FROM solicitud_servicio')) return [[{ tipo_viaje: tipoViaje }]];
  if (sql.includes('SELECT * FROM remesa WHERE id')) {
    return [[{ id: params[0], num_remesa: 'REM-00001', peso: 100, unidad_medida: '1', cumplido_rndc_ingreso_id: null }]];
  }
  if (sql.includes('SELECT * FROM manifiesto WHERE id')) {
    return [[{ id: params[0], num_manifiesto: 'M-1', cumplido_rndc_ingreso_id: null, fopat: 10, retencion_fuente: 100 }]];
  }
  if (sql.startsWith('DELETE')) return [{ affectedRows: 0 }];
  return [[]];
}

const fakeConn = {
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    return respond(sql, params);
  }),
};

vi.mock('../src/db/pool.js', () => ({
  db: () => fakeConn,
  withTransaction: async (fn: (c: typeof fakeConn) => Promise<unknown>) => fn(fakeConn),
}));
vi.mock('../src/modules/empresa/empresa.repo.js', () => ({
  obtener: async () => ({ nit: '900000001' }),
}));

const { encolarCumplido, purgarCumplidoRemesaUrbano, solicitudEsUrbana } = await import('../src/modules/cola/cola.repo.js');

const tiposEncolados = () =>
  calls.filter((c) => c.sql.includes('INSERT INTO cola_envios')).map((c) => c.params[2] as string);

beforeEach(() => {
  calls.length = 0;
  tipoViaje = 'NACIONAL';
});

describe('encolarCumplido según el tipo de viaje', () => {
  it('NACIONAL: encola el cumplido de cada remesa y el del manifiesto', async () => {
    await encolarCumplido(fakeConn as never, 1, 10, [301, 302]);
    expect(tiposEncolados()).toEqual(['cumplido_remesa', 'cumplido_remesa', 'cumplido_manifiesto']);
  });

  it('URBANO: encola solo el cumplido del manifiesto, aunque lleguen remesas', async () => {
    tipoViaje = 'URBANO';
    await encolarCumplido(fakeConn as never, 1, 10, [301, 302]);
    expect(tiposEncolados()).toEqual(['cumplido_manifiesto']);
  });

  it('URBANO: encola el del manifiesto aun sin datos de remesas', async () => {
    tipoViaje = 'urbano';
    await encolarCumplido(fakeConn as never, 1, 10, []);
    expect(tiposEncolados()).toEqual(['cumplido_manifiesto']);
  });

  it('URBANO: limpia los cumplido_remesa que sigan sin enviarse', async () => {
    tipoViaje = 'URBANO';
    await encolarCumplido(fakeConn as never, 1, 10, [301]);
    const purga = calls.find((c) => c.sql.startsWith('DELETE c FROM cola_envios'));
    expect(purga).toBeDefined();
    expect(purga!.sql).toContain("c.tipo_documento = 'cumplido_remesa'");
    expect(purga!.sql).toContain("c.estado IN ('pendiente','error')");
    expect(purga!.sql).toContain("= 'URBANO'");
  });
});

describe('helpers', () => {
  it('solicitudEsUrbana lee tipo_viaje de la solicitud', async () => {
    tipoViaje = 'URBANO';
    expect(await solicitudEsUrbana(fakeConn as never, 5)).toBe(true);
    tipoViaje = 'NACIONAL';
    expect(await solicitudEsUrbana(fakeConn as never, 5)).toBe(false);
    tipoViaje = null;
    expect(await solicitudEsUrbana(fakeConn as never, 5)).toBe(false);
  });

  it('purgarCumplidoRemesaUrbano devuelve cuántas filas borró', async () => {
    fakeConn.query.mockResolvedValueOnce([{ affectedRows: 3 }] as never);
    expect(await purgarCumplidoRemesaUrbano(fakeConn as never)).toBe(3);
  });
});
