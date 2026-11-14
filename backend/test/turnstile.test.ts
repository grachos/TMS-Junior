import { describe, expect, it } from 'vitest';
import { MAX_TOKEN_LENGTH, verifyTurnstile, type TurnstileOptions } from '../src/modules/auth/turnstile.js';
import { construirCsp } from '../src/http/seguridad.js';

const SECRETO = 'secreto-real-de-prueba';
const AHORA = Date.parse('2026-11-14T12:00:00Z');

/** Cloudflare simulado: nunca hay red en las pruebas. */
const cf = (respuesta: unknown, estado = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(respuesta), { status: estado })) as unknown as typeof fetch;
const buena = (extra: Record<string, unknown> = {}) => ({
  success: true, hostname: 'miempresa.co', action: 'login', challenge_ts: new Date(AHORA - 10_000).toISOString(), ...extra,
});

function opts(o: Partial<TurnstileOptions> = {}): Partial<TurnstileOptions> {
  return { secret: SECRETO, allowedHostnames: ['miempresa.co'], production: true, now: () => AHORA, log: () => {}, fetchImpl: cf(buena()), ...o };
}
const verificar = (token: unknown, o: Partial<TurnstileOptions> = {}, accion = 'login') => verifyTurnstile(token, accion, '1.2.3.4', opts(o));

describe('verifyTurnstile (falla cerrado)', () => {
  it('acepta un token válido del dominio y la acción correctos', async () => {
    expect(await verificar('tok')).toMatchObject({ ok: true, hostname: 'miempresa.co', action: 'login' });
  });

  it('sin clave secreta o sin lista de dominios NO deja pasar a nadie', async () => {
    expect(await verificar('tok', { secret: '' })).toMatchObject({ ok: false, reason: 'secret_missing' });
    expect(await verificar('tok', { secret: undefined })).toMatchObject({ ok: false, reason: 'secret_missing' });
    expect(await verificar('tok', { allowedHostnames: [] })).toMatchObject({ ok: false, code: 'CAPTCHA-01', reason: 'allowed_hostnames_missing' });
  });

  it.each([[undefined], [null], [''], ['   '], [123], ['x'.repeat(MAX_TOKEN_LENGTH + 1)]])('token ausente o mal formado (%s) → CAPTCHA-03', async (t) => {
    expect(await verificar(t)).toMatchObject({ ok: false, code: 'CAPTCHA-03' });
  });

  it('Cloudflare caído, con error HTTP, sin responder o con basura → rechazo', async () => {
    expect(await verificar('tok', { fetchImpl: cf({}, 500) })).toMatchObject({ ok: false, reason: 'cloudflare_http_error' });
    expect(await verificar('tok', { fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch })).toMatchObject({ ok: false, reason: 'cloudflare_unreachable' });
    expect(await verificar('tok', { fetchImpl: (async () => new Response('no es json', { status: 200 })) as unknown as typeof fetch })).toMatchObject({ ok: false, code: 'CAPTCHA-02' });
    expect(await verificar('tok', { fetchImpl: cf(null) })).toMatchObject({ ok: false });
  });

  it('el tiempo agotado se rechaza (no se queda esperando)', async () => {
    const colgado = ((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' }))))) as unknown as typeof fetch;
    expect(await verificar('tok', { fetchImpl: colgado, timeoutMs: 20 })).toMatchObject({ ok: false, reason: 'cloudflare_timeout' });
  });

  it('token reutilizado o vencido → CAPTCHA-03; reto no superado o llave inválida → CAPTCHA-02', async () => {
    expect(await verificar('tok', { fetchImpl: cf({ success: false, 'error-codes': ['timeout-or-duplicate'] }) })).toMatchObject({ code: 'CAPTCHA-03' });
    expect(await verificar('tok', { fetchImpl: cf({ success: false, 'error-codes': ['invalid-input-secret'] }) })).toMatchObject({ code: 'CAPTCHA-02' });
    expect(await verificar('tok', { fetchImpl: cf(buena({ challenge_ts: new Date(AHORA - 10 * 60_000).toISOString() })) })).toMatchObject({ code: 'CAPTCHA-03', reason: 'token_expired' });
  });

  it('un token de otro dominio o de otro formulario no sirve', async () => {
    expect(await verificar('tok', { fetchImpl: cf(buena({ hostname: 'sitio-ajeno.com' })) })).toMatchObject({ code: 'CAPTCHA-01', reason: 'hostname_not_allowed' });
    expect(await verificar('tok', { fetchImpl: cf(buena({ action: 'otro_formulario' })) })).toMatchObject({ code: 'CAPTCHA-02', reason: 'action_mismatch' });
  });

  it('las claves de PRUEBA de Cloudflare se rechazan en producción y se aceptan fuera de ella', async () => {
    const prueba = '1x0000000000000000000000000000000AA';
    expect(await verificar('tok', { secret: prueba, production: true })).toMatchObject({ ok: false, reason: 'test_secret_in_production' });
    expect(await verificar('tok', { secret: prueba, production: false, allowedHostnames: [], fetchImpl: cf({ success: true }) })).toMatchObject({ ok: true });
  });

  it('el motivo y los códigos de Cloudflare no se filtran al mensaje: viajan aparte para el registro', async () => {
    const r = await verificar('tok', { fetchImpl: cf({ success: false, 'error-codes': ['invalid-input-secret'] }) });
    expect(r).toMatchObject({ ok: false, errorCodes: ['invalid-input-secret'] });
  });

  it('manda a Cloudflare la clave secreta y el token, y la IP del visitante', async () => {
    let cuerpo: Record<string, unknown> = {};
    await verificar('mi-token', { fetchImpl: (async (_u: string, init: RequestInit) => { cuerpo = JSON.parse(String(init.body)); return new Response(JSON.stringify(buena())); }) as unknown as typeof fetch });
    expect(cuerpo).toMatchObject({ secret: SECRETO, response: 'mi-token', remoteip: '1.2.3.4' });
  });
});

describe('CSP con Turnstile', () => {
  it('sin Turnstile no se abre nada a Cloudflare; con Turnstile se permite su script, iframe y conexión', () => {
    expect(construirCsp([], false)).not.toContain('cloudflare');
    const csp = construirCsp([], true);
    for (const d of ['script-src', 'frame-src', 'connect-src']) {
      expect(csp.split('; ').find((x) => x.startsWith(d))).toContain('https://challenges.cloudflare.com');
    }
  });
});
