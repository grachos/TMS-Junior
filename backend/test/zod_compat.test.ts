/** Comportamientos de los esquemas que podrían cambiar entre versiones de zod (guarda de la migración a zod 4). */
import { describe, expect, it } from 'vitest';
import { terceroUpsertSchema } from '../src/modules/terceros/tercero.schema.js';
import { vehiculoUpsertSchema } from '../src/modules/vehiculos/vehiculo.schema.js';

const tercero = { tipo_id: 'C', num_id: '123456', nombre: 'Ana', direccion: 'Calle 1', cod_municipio: '11001000' };
const vehiculo = { placa: 'ABC123', cod_configuracion: '2S3', tenedor_tipo_id: 'C', tenedor_num_id: '1' };
const mensaje = (r: { success: boolean; error?: { issues: { message: string }[] } }) => r.error?.issues[0]?.message;

describe('esquemas (compatibilidad de zod)', () => {
  it('tercero: es_conductor vale false por defecto y los textos se recortan', () => {
    const r = terceroUpsertSchema.safeParse({ ...tercero, nombre: '  Ana  ' });
    expect(r.success).toBe(true);
    if (r.success) { expect(r.data.es_conductor).toBe(false); expect(r.data.nombre).toBe('Ana'); }
  });

  it('tercero: correo válido, vacío o nulo pasan; uno inválido falla con su mensaje', () => {
    for (const email of ['ana@correo.com', '', null, undefined]) expect(terceroUpsertSchema.safeParse({ ...tercero, email }).success, String(email)).toBe(true);
    const mal = terceroUpsertSchema.safeParse({ ...tercero, email: 'no-es-correo' });
    expect(mal.success).toBe(false);
    expect(mal.error!.issues.map((i) => i.message)).toContain('Correo inválido.');
  });

  it('tercero: campos obligatorios vacíos o ausentes fallan; los mensajes propios se conservan en los vacíos', () => {
    expect(mensaje(terceroUpsertSchema.safeParse({ ...tercero, nombre: '   ' }))).toBe('El nombre o razón social es obligatorio.');
    expect(mensaje(terceroUpsertSchema.safeParse({ ...tercero, cod_municipio: '' }))).toBe('Elige el municipio de la lista.');
    const { nombre: _n, ...sinNombre } = tercero;
    expect(terceroUpsertSchema.safeParse(sinNombre).success).toBe(false);
  });

  it('vehículo: peso_vacio se convierte a número, acepta nulo/ausente y rechaza texto o negativos con su mensaje', () => {
    const ok = vehiculoUpsertSchema.safeParse({ ...vehiculo, peso_vacio: '1500' });
    expect(ok.success && ok.data.peso_vacio).toBe(1500);
    expect(vehiculoUpsertSchema.safeParse({ ...vehiculo, peso_vacio: null }).success).toBe(true);
    expect(vehiculoUpsertSchema.safeParse(vehiculo).success).toBe(true);
    expect(mensaje(vehiculoUpsertSchema.safeParse({ ...vehiculo, peso_vacio: 'abc' }))).toBe('Peso vacío inválido.');
    expect(vehiculoUpsertSchema.safeParse({ ...vehiculo, peso_vacio: -5 }).success).toBe(false);
    expect(vehiculoUpsertSchema.safeParse({ ...vehiculo, peso_vacio: 10.5 }).success).toBe(false);
  });

  it('vehículo: la placa admite hasta 6 caracteres', () => {
    expect(vehiculoUpsertSchema.safeParse({ ...vehiculo, placa: 'ABCD123' }).success).toBe(false);
    expect(vehiculoUpsertSchema.safeParse({ ...vehiculo, placa: ' abc123 ' }).success).toBe(true);
  });
});
