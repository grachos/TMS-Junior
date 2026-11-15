import { describe, expect, it, vi } from 'vitest';
import { crearTelemetria, esRuido } from '../../frontend/src/lib/telemetria.js';

function armar(over: Partial<Parameters<typeof crearTelemetria>[0]> = {}) {
  const enviados: { cuerpo: Record<string, string>; token: string }[] = [];
  const deps = {
    token: () => 'tk' as string | null,
    ruta: () => '/despachos',
    enLinea: () => true,
    enviar: async (cuerpo: Record<string, string>, token: string) => { enviados.push({ cuerpo, token }); },
    ...over,
  };
  return { t: crearTelemetria(deps), enviados };
}

describe('telemetría del navegador', () => {
  it('sin sesión (token) no reporta nada: el login nunca envía telemetría', async () => {
    const { t, enviados } = armar({ token: () => null });
    expect(await t.reportar({ tipo: 'error_js', mensaje: 'x falló' })).toBe(false);
    expect(enviados).toHaveLength(0);
  });

  it('sin conexión no reporta', async () => {
    const { t, enviados } = armar({ enLinea: () => false });
    expect(await t.reportar({ tipo: 'error_js', mensaje: 'x falló' })).toBe(false);
    expect(enviados).toHaveLength(0);
  });

  it('descarta el ruido: errores de red, cancelaciones, extensiones y la propia telemetría', async () => {
    const { t, enviados } = armar();
    for (const m of ['ResizeObserver loop completed with undelivered notifications.', 'Script error.', 'TypeError: Failed to fetch', 'NetworkError when attempting to fetch resource',
      'The user aborted a request.', 'Loading chunk 12 failed.', 'POST /api/reportes/telemetria 500', 'Non-Error promise rejection captured with value: x']) {
      expect(esRuido(m), m).toBe(true);
      expect(await t.reportar({ tipo: 'error_js', mensaje: m })).toBe(false);
    }
    expect(enviados).toHaveLength(0);
    expect(esRuido('Cannot read properties of undefined (reading "map")')).toBe(false);
  });

  it('deduplica por tipo+mensaje+pantalla y respeta el tope por carga de página', async () => {
    const { t, enviados } = armar({ maxPorPagina: 3 });
    expect(await t.reportar({ tipo: 'react', mensaje: 'igual' })).toBe(true);
    expect(await t.reportar({ tipo: 'react', mensaje: 'igual' })).toBe(false); // repetido
    expect(await t.reportar({ tipo: 'error_js', mensaje: 'igual' })).toBe(true); // otro tipo
    expect(await t.reportar({ tipo: 'react', mensaje: 'otro' })).toBe(true);
    expect(await t.reportar({ tipo: 'react', mensaje: 'cuarto' })).toBe(false); // tope
    expect(enviados).toHaveLength(3);
  });

  it('una sola llamada en vuelo: mientras se envía, las demás se descartan (no hay avalancha ni reentrada)', async () => {
    let liberar!: () => void;
    const { t, enviados } = armar({ enviar: (c, tk) => new Promise<void>((r) => { enviados2.push({ cuerpo: c, token: tk }); liberar = r; }) });
    const enviados2: { cuerpo: Record<string, string>; token: string }[] = [];
    void enviados;
    const primera = t.reportar({ tipo: 'error_js', mensaje: 'uno' });
    expect(await t.reportar({ tipo: 'error_js', mensaje: 'dos' })).toBe(false);
    liberar();
    expect(await primera).toBe(true);
    expect(enviados2).toHaveLength(1);
  });

  it('NUNCA lanza ni se reporta a sí misma: si el envío falla, no se reintenta ni se genera otro reporte', async () => {
    const enviar = vi.fn(async () => { throw new Error('el servidor de telemetría falló'); });
    const { t } = armar({ enviar });
    await expect(t.reportar({ tipo: 'error_js', mensaje: 'algo' })).resolves.toBe(false);
    expect(enviar).toHaveBeenCalledTimes(1);
    // un error que la propia telemetría provocara (reentrada desde enviar) tampoco entra en bucle
    let llamadas = 0;
    const { t: t2 } = armar({
      enviar: async () => { llamadas += 1; await t2.reportar({ tipo: 'error_js', mensaje: 'error dentro del envío' }); },
    });
    await t2.reportar({ tipo: 'error_js', mensaje: 'origen' });
    expect(llamadas).toBe(1);
  });

  it('acota los campos y solo manda requestId válido', async () => {
    const { t, enviados } = armar();
    await t.reportar({ tipo: 'react', mensaje: 'm'.repeat(900), pila: 'p'.repeat(9000), requestId: 'no válido!' });
    const c = enviados[0]!.cuerpo;
    expect(c.mensaje.length).toBe(500);
    expect(c.pila!.length).toBe(4000);
    expect(c.requestId).toBeUndefined();
    expect(c.ruta).toBe('/despachos');
    await t.reportar({ tipo: 'http_5xx', mensaje: 'HTTP 500 GET /x', requestId: 'abcd1234-ef56' });
    expect(enviados[1]!.cuerpo.requestId).toBe('abcd1234-ef56');
  });
});
