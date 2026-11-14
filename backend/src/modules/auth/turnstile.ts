/**
 * Light TMS - Verificación de Cloudflare Turnstile en el servidor.
 *
 * El widget solo entrega un token; lo que protege es esta llamada a siteverify.
 *  - Falla CERRADO: sin clave secreta, sin lista de dominios, con Cloudflare caído,
 *    tiempo agotado (5 s) o respuesta ilegible, se rechaza. Nunca lanza.
 *  - El token es de un solo uso y dura 5 minutos.
 *  - La acción del widget debe ser la del formulario y el dominio debe ser uno propio:
 *    un token obtenido en otro sitio o para otro formulario no sirve.
 *  - Los error-codes de Cloudflare van solo al registro, nunca a la respuesta.
 *  - Las claves de PRUEBA de Cloudflare se rechazan en producción.
 *
 * Códigos que ve el cliente:
 *   CAPTCHA-01 dominio no autorizado · CAPTCHA-02 verificación fallida o no se pudo verificar
 *   CAPTCHA-03 token ausente, inválido, vencido o reutilizado
 */

import { config } from '../../config/env.js';

export type CaptchaCode = 'CAPTCHA-01' | 'CAPTCHA-02' | 'CAPTCHA-03';

export type TurnstileOutcome =
  | { ok: true; hostname: string; action: string }
  | { ok: false; code: CaptchaCode; reason: string; errorCodes: string[] };

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const TURNSTILE_TIMEOUT_MS = 5000;
export const TOKEN_MAX_AGE_MS = 5 * 60 * 1000 + 30 * 1000;
export const MAX_TOKEN_LENGTH = 2048;

const TEST_SECRETS: readonly string[] = [
  '1x0000000000000000000000000000000AA',
  '2x0000000000000000000000000000000AA',
  '3x0000000000000000000000000000000AA',
];

export interface TurnstileOptions {
  secret?: string;
  allowedHostnames: string[];
  timeoutMs: number;
  production: boolean;
  fetchImpl: typeof fetch;
  now: () => number;
  log: (event: Record<string, unknown>) => void;
}

export function opcionesPorDefecto(): TurnstileOptions {
  const c = config();
  return {
    secret: c.turnstile.secretKey,
    allowedHostnames: c.turnstile.allowedHostnames,
    timeoutMs: TURNSTILE_TIMEOUT_MS,
    production: c.app.env === 'production' || process.env.NODE_ENV === 'production',
    fetchImpl: (...args) => fetch(...args),
    now: () => Date.now(),
    log: (event) => console.error(JSON.stringify({ t: 'turnstile', ...event })), // eslint-disable-line no-console
  };
}

const normalizeHost = (h: string) => h.trim().toLowerCase().replace(/\.$/, '');
const TOKEN_ERRORS = new Set(['missing-input-response', 'invalid-input-response', 'timeout-or-duplicate']);

/** Verifica el token del widget. Nunca lanza: cualquier fallo devuelve { ok: false }. */
export async function verifyTurnstile(
  token: unknown,
  expectedAction: string,
  ip: string | undefined,
  overrides: Partial<TurnstileOptions> = {},
): Promise<TurnstileOutcome> {
  const opts: TurnstileOptions = { ...opcionesPorDefecto(), ...overrides };
  const fail = (code: CaptchaCode, reason: string, errorCodes: string[] = [], extra: Record<string, unknown> = {}): TurnstileOutcome => {
    opts.log({ result: 'rejected', reason, code, errorCodes, expectedAction, ...extra });
    return { ok: false, code, reason, errorCodes };
  };

  if (!opts.secret) return fail('CAPTCHA-02', 'secret_missing');
  const isTestSecret = TEST_SECRETS.includes(opts.secret);
  if (isTestSecret && opts.production) return fail('CAPTCHA-02', 'test_secret_in_production');
  const allowed = opts.allowedHostnames.map(normalizeHost).filter(Boolean);
  if (!isTestSecret && allowed.length === 0) return fail('CAPTCHA-01', 'allowed_hostnames_missing');

  if (typeof token !== 'string' || token.trim() === '' || token.length > MAX_TOKEN_LENGTH) {
    return fail('CAPTCHA-03', 'token_missing_or_malformed');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  let data: Record<string, unknown>;
  try {
    const response = await opts.fetchImpl(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: opts.secret, response: token, ...(ip ? { remoteip: ip } : {}) }),
      signal: controller.signal,
    });
    if (!response.ok) return fail('CAPTCHA-02', 'cloudflare_http_error', [], { status: response.status });
    data = (await response.json()) as Record<string, unknown>;
  } catch (err) {
    const aborted = (err as { name?: string })?.name === 'AbortError';
    return fail('CAPTCHA-02', aborted ? 'cloudflare_timeout' : 'cloudflare_unreachable');
  } finally {
    clearTimeout(timer);
  }
  if (!data || typeof data !== 'object') return fail('CAPTCHA-02', 'cloudflare_bad_response');

  const errorCodes = Array.isArray(data['error-codes']) ? (data['error-codes'] as unknown[]).map(String) : [];
  if (data.success !== true) {
    if (errorCodes.some((c) => TOKEN_ERRORS.has(c))) return fail('CAPTCHA-03', 'token_rejected', errorCodes);
    return fail('CAPTCHA-02', 'verification_failed', errorCodes);
  }

  const hostname = typeof data.hostname === 'string' ? data.hostname : '';
  const action = typeof data.action === 'string' ? data.action : '';
  // Con las claves de prueba los tokens son ficticios: no traen acción ni dominio reales.
  if (!isTestSecret) {
    const ts = typeof data.challenge_ts === 'string' ? Date.parse(data.challenge_ts) : NaN;
    if (Number.isFinite(ts) && opts.now() - ts > TOKEN_MAX_AGE_MS) return fail('CAPTCHA-03', 'token_expired', errorCodes, { hostname, action });
    if (!allowed.includes(normalizeHost(hostname))) return fail('CAPTCHA-01', 'hostname_not_allowed', errorCodes, { hostname, action });
    if (action !== expectedAction) return fail('CAPTCHA-02', 'action_mismatch', errorCodes, { hostname, action });
  }
  return { ok: true, hostname, action };
}

export const MENSAJES_CAPTCHA: Record<CaptchaCode, string> = {
  'CAPTCHA-01': 'No se pudo validar el origen de la solicitud.',
  'CAPTCHA-02': 'No se pudo completar la verificación de seguridad. Intenta de nuevo.',
  'CAPTCHA-03': 'La verificación de seguridad venció o no es válida. Vuelve a intentarlo.',
};
