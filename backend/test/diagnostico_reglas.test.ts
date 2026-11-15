/** Motor de reglas (puro) e índice de migraciones. Todo "secreto" se genera en tiempo de ejecución. */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { estadoDeVariable } from '../src/modules/diagnostico/contexto.js';
import { generarIndice } from '../src/modules/diagnostico/indiceMigraciones.js';
import { borradorPublicoDe, diagnosticar, marcoDeLaApp, type EntradaDiagnostico } from '../src/modules/diagnostico/reglas.js';

const azar = (n = 6) => randomBytes(n).toString('hex');
const HOY = '2026-11-15T12:00:00.000Z';

function entrada(over: Partial<EntradaDiagnostico> & { tipo?: string; origen?: string } = {}): EntradaDiagnostico {
  const { tipo, origen, ...resto } = over;
  return {
    incidente: { id: 7, tipo: tipo ?? 'codigo', origen: origen ?? 'servidor', operacion: 'GET /api/x', codigo: null, titulo: 'GET /api/x: falló', ocurrencias: 3, primera_vez: '2026-11-14 10:00:00', ultima_vez: '2026-11-15 11:00:00', version_despliegue: 'v-actual', corregible: true, estado: 'nuevo' },
    versionActual: 'v-actual', evidencia: { mensaje: 'falló', pila: '' }, observado: HOY, ...resto,
  };
}

describe('índice de migraciones (generado del repositorio)', () => {
  const indice = generarIndice(new URL('../../database', import.meta.url).pathname);
  it('mapea pares conocidos a la migración que los crea', () => {
    expect(indice.objetos['staff_users.acciones']).toMatch(/^migracion_v54_/);
    expect(indice.objetos['auth_intentos']).toMatch(/^migracion_v55_/);
    expect(indice.objetos['staff_users.uuid']).toMatch(/^migracion_v57_/);
    expect(indice.objetos['incidentes']).toMatch(/^migracion_v58_/);
    expect(indice.objetos['incidente_diagnosticos']).toMatch(/^migracion_v59_/);
    expect(indice.objetos['solicitud_servicio.interna']).toMatch(/^migracion_v53_/);
    expect(indice.objetos['solicitud_servicio']).toBe('schema.sql'); // lo que viene del esquema base = instalación incompleta
    expect(Object.keys(indice.objetos).length).toBeGreaterThan(100);
  });
});

describe('regla: migración pendiente', () => {
  const base = (m: NonNullable<EntradaDiagnostico['migracion']>) => diagnosticar(entrada({ tipo: 'migracion', migracion: m, evidencia: { mensaje: "Table 'x.auth_intentos' doesn't exist", pila: '' } }));
  it('CONFIRMADA solo si el objeto está ausente AHORA y el índice dice qué migración lo crea; nunca es corregible con código', () => {
    const d = base({ objeto: { tabla: 'auth_intentos' }, ausenteAhora: true, migracion: 'migracion_v55_seguridad_acceso.sql', indiceDisponible: true });
    expect(d).toMatchObject({ categoria: 'migracion', confianza: 'confirmada', corregibleConCodigo: false });
    expect(d.causaConfirmada).toContain('migracion_v55_seguridad_acceso.sql');
    expect(d.siguientePaso).toMatch(/No hay cambio de código/);
    expect(d.hechos.every((h) => h.observadoEn === HOY && h.fuente)).toBe(true);
  });
  it('si el objeto EXISTE ahora no se confirma: ya se corrió o el incidente es anterior', () => {
    const d = base({ objeto: { tabla: 'auth_intentos' }, ausenteAhora: false, migracion: 'migracion_v55_seguridad_acceso.sql', indiceDisponible: true });
    expect(d.confianza).toBe('probable');
    expect(d.causaConfirmada).toBeNull();
    expect(d.borradorPublico.causaConfirmada).toBeNull();
  });
  it('sin comprobar, sin índice o sin objeto identificado tampoco se confirma', () => {
    expect(base({ objeto: { tabla: 'x' }, ausenteAhora: null, migracion: 'm.sql', indiceDisponible: true }).confianza).toBe('probable');
    expect(base({ objeto: { tabla: 'x' }, ausenteAhora: true, migracion: null, indiceDisponible: false }).confianza).toBe('probable');
    expect(base({ objeto: { tabla: 'x' }, ausenteAhora: true, migracion: null, indiceDisponible: true }).confianza).toBe('probable'); // ninguna migración la crea
    expect(base({ objeto: null, ausenteAhora: null, migracion: null, indiceDisponible: true }).confianza).toBe('insuficiente');
  });
  it('un objeto del esquema base se reporta como instalación incompleta', () => {
    const d = base({ objeto: { tabla: 'manifiesto' }, ausenteAhora: true, migracion: 'schema.sql', indiceDisponible: true });
    expect(d.causaConfirmada).toMatch(/instalación está incompleta/);
  });
  it('un tipo guardado como "codigo" pero con un objeto de BD señalado se trata como migración', () => {
    const d = diagnosticar(entrada({ tipo: 'codigo', migracion: { objeto: { tabla: 'a', columna: 'b' }, ausenteAhora: true, migracion: 'm.sql', indiceDisponible: true } }));
    expect(d.categoria).toBe('migracion');
  });
});

describe('regla: configuración (solo definida/válida, nunca valores)', () => {
  const cfg = (variables: { nombre: string; definida: boolean; valida: boolean | null }[]) => diagnosticar(entrada({ tipo: 'configuracion', configuracion: { variables } }));
  it('variable sin definir o inválida → confirmada; definida y válida → probable; ninguna identificada → insuficiente', () => {
    expect(cfg([{ nombre: 'SMTP_HOST', definida: false, valida: null }]).confianza).toBe('confirmada');
    expect(cfg([{ nombre: 'JWT_SECRET', definida: true, valida: false }]).confianza).toBe('confirmada');
    expect(cfg([{ nombre: 'APP_URL', definida: true, valida: true }]).confianza).toBe('probable');
    expect(cfg([]).confianza).toBe('insuficiente');
    expect(cfg([{ nombre: 'SMTP_HOST', definida: false, valida: null }]).corregibleConCodigo).toBe(false);
  });
  it('estadoDeVariable devuelve solo booleanos: el valor no sale', () => {
    const valor = azar(20);
    const r = estadoDeVariable('SMTP_PASS', { SMTP_PASS: valor });
    expect(JSON.stringify(r)).not.toContain(valor);
    expect(r).toEqual({ nombre: 'SMTP_PASS', definida: true, valida: null });
    expect(estadoDeVariable('JWT_SECRET', { JWT_SECRET: 'corto' }).valida).toBe(false);
    expect(estadoDeVariable('JWT_SECRET', { JWT_SECRET: azar(20) }).valida).toBe(true);
    expect(estadoDeVariable('APP_URL', { APP_URL: 'no es url' }).valida).toBe(false);
    expect(estadoDeVariable('APP_URL', { APP_URL: 'https://sitio.test' }).valida).toBe(true);
    expect(estadoDeVariable('SMTP_HOST', {}).definida).toBe(false);
  });
});

describe('regla: RNDC', () => {
  const r = (rndc: NonNullable<EntradaDiagnostico['rndc']>) => diagnosticar(entrada({ tipo: 'rndc', rndc }));
  it('fallas de conexión registradas por la cola → confirmada; solo códigos del catálogo → probable; nada → probable. NUNCA corregible con código', () => {
    expect(r({ errores24h: 5, pendientes: 2, conexion24h: 3, codigos: [] })).toMatchObject({ confianza: 'confirmada', corregibleConCodigo: false });
    expect(r({ errores24h: 5, pendientes: 2, conexion24h: 0, codigos: [{ codigo: 'REC046', mensaje: 'm', solucion: 's' }] })).toMatchObject({ confianza: 'probable', corregibleConCodigo: false });
    expect(r({ errores24h: 0, pendientes: 0, conexion24h: 0, codigos: [] })).toMatchObject({ confianza: 'probable', corregibleConCodigo: false });
  });
  it('el catálogo explica el código pero NO confirma una caída; y advierte del posible defecto de mapeo', () => {
    const d = r({ errores24h: 1, pendientes: 0, conexion24h: 0, codigos: [{ codigo: 'REC046', mensaje: 'texto del catálogo', solucion: 'revisar el serial' }] });
    expect(d.causaConfirmada).toBeNull();
    expect(d.hechos.some((h) => h.texto.includes('REC046') && h.texto.includes('texto del catálogo'))).toBe(true);
    expect(d.siguientePaso).toMatch(/No cambiar código/);
    expect(d.siguientePaso).toMatch(/defecto de mapeo/);
  });
});

describe('regla: código (nunca se confirma sin reproducirlo)', () => {
  const pila = ['Error: x', '    at f (src/modules/solicitudes/solicitud.repo.ts:123:9)', '    at g (node_modules/express/lib/router.js:10:1)'].join('\n');
  it('ubica el marco de la aplicación y la regresión, pero la confianza nunca pasa de "probable"', () => {
    const d = diagnosticar(entrada({ evidencia: { mensaje: 'x', pila }, codigo: { primeraVersion: 'v-actual', versionesVistas: 1, mismoArchivo: 2 } }));
    expect(d).toMatchObject({ categoria: 'codigo', confianza: 'probable', corregibleConCodigo: true, causaConfirmada: null });
    expect(d.referencias).toContainEqual({ tipo: 'codigo', valor: 'src/modules/solicitudes/solicitud.repo.ts:123' });
    expect(d.hechos.some((h) => /regresión/.test(h.texto))).toBe(true);
    expect(d.hechos.some((h) => /2 otro\(s\) incidente\(s\)/.test(h.texto))).toBe(true);
    expect(d.siguientePaso).toMatch(/NO está confirmada/);
  });
  it('sin marco de la aplicación es "insuficiente"; node_modules no cuenta como marco', () => {
    expect(diagnosticar(entrada({ evidencia: { mensaje: 'x', pila: 'Error\n   at h (node_modules/x/y.js:1:1)' } })).confianza).toBe('insuficiente');
    expect(marcoDeLaApp('   at h (node_modules/x/y.js:1:1)\n   at z (dist/modules/a/b.js:9:3)')).toEqual({ archivo: 'dist/modules/a/b.js', linea: 9 });
  });
});

describe('otras categorías y reportes', () => {
  it('infraestructura y proveedor de IA: probables y no corregibles con código', () => {
    expect(diagnosticar(entrada({ tipo: 'infraestructura', infraestructura: { baseDeDatosAhora: true } }))).toMatchObject({ confianza: 'probable', corregibleConCodigo: false });
    expect(diagnosticar(entrada({ tipo: 'proveedor_ia' }))).toMatchObject({ confianza: 'probable', corregibleConCodigo: false });
  });
  it('un reporte de usuario sin evidencia es "insuficiente"; con incidentes cercanos es solo "probable" y no opina sobre el código', () => {
    const sin = diagnosticar(entrada({ tipo: 'otro', origen: 'usuario', evidencia: null, reportes: { pantalla: '/cola', cercanos: [] } }));
    expect(sin).toMatchObject({ confianza: 'insuficiente', corregibleConCodigo: null });
    const con = diagnosticar(entrada({ tipo: 'otro', origen: 'usuario', evidencia: null, reportes: { pantalla: '/cola', cercanos: [{ id: 9, tipo: 'codigo', titulo: 'GET /api/cola: falló' }] } }));
    expect(con).toMatchObject({ confianza: 'probable', corregibleConCodigo: null });
    expect(con.hechos.some((h) => h.texto.includes('#9'))).toBe(true);
  });
  it('la confianza la decide el código: un contexto que "declare" confianza es ignorado', () => {
    const hostil = { ...entrada({ tipo: 'codigo', evidencia: { mensaje: 'x', pila: '' } }), confianza: 'confirmada', corregibleConCodigo: false } as unknown as EntradaDiagnostico;
    expect(diagnosticar(hostil)).toMatchObject({ confianza: 'insuficiente', corregibleConCodigo: true });
  });
});

describe('borrador PÚBLICO: plantillas fijas, nunca evidencia', () => {
  const categorias = ['migracion', 'rndc', 'configuracion', 'infraestructura', 'proveedor_ia', 'codigo', 'datos', 'permisos', 'otro'] as const;
  const hostil = { mensaje: `Unknown column 'x' en src/modules/a/b.ts:9 migracion_v54_x.sql JWT_SECRET REC046 ${azar(12)} incidente #12 ${azar(3)}@correo.com`, pila: 'at f (src/modules/a/b.ts:9:1)' };

  it('el mismo diagnóstico con evidencia hostil o neutra produce EXACTAMENTE el mismo borrador', () => {
    for (const tipo of categorias) {
      const a = diagnosticar(entrada({ tipo, evidencia: { mensaje: 'neutral', pila: '' } })).borradorPublico;
      const b = diagnosticar(entrada({ tipo, evidencia: hostil })).borradorPublico;
      expect(b, tipo).toEqual(a);
    }
  });

  it('ningún borrador contiene rutas, archivos, migraciones, variables, códigos RNDC, hashes, ids ni correos', () => {
    for (const categoria of categorias) {
      for (const confianza of ['confirmada', 'probable', 'insuficiente'] as const) {
        const txt = JSON.stringify(borradorPublicoDe(categoria, confianza));
        expect(txt, `${categoria}/${confianza}`).not.toMatch(/[/\\]|\.sql|\.ts\b|\.js\b|migracion_v|JWT_|SMTP_|APP_|DB_|OPENROUTER|\b[A-Z]{3,4}\d{3}\b|#\d|[0-9a-f]{12,}|@|node_modules|src\b|dist\b/);
      }
    }
  });

  it('la causa confirmada solo existe con confianza "confirmada" y jamás para el código', () => {
    for (const categoria of categorias) {
      expect(borradorPublicoDe(categoria, 'probable').causaConfirmada, categoria).toBeNull();
      expect(borradorPublicoDe(categoria, 'insuficiente').causaConfirmada, categoria).toBeNull();
    }
    expect(borradorPublicoDe('codigo', 'confirmada').causaConfirmada).toBeNull();
    expect(borradorPublicoDe('migracion', 'confirmada').causaConfirmada).toBeTruthy();
  });

  it('las plantillas no prometen que repetir la operación sea seguro ni que la corrección ya exista', () => {
    for (const categoria of categorias) {
      const t = JSON.stringify(borradorPublicoDe(categoria, 'probable'));
      expect(t, categoria).not.toMatch(/puedes repetir|ya está corregido|ya quedó corregido|se corrigió/i);
    }
  });
});
