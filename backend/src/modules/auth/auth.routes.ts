/**
 * Light TMS - Auth routes: login + current user.
 */

import { Router, type Request } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { AppError, asyncHandler, badRequest, unauthorized } from '../../http/errors.js';
import {
  findByEmail, findById, toPublic,
  registrarIntento as registrarIntentoLegacy, marcarIntentoExitoso as marcarIntentoExitosoLegacy, LOGIN_MAX_FALLOS, LOGIN_VENTANA_MIN,
} from './auth.repo.js';
import {
  auditarAcceso, hashIdentificador, limitesPorDefecto, marcarExito, quitarIdentificador, registrarIntento,
} from './accesoGuard.js';
import { signToken } from './jwt.js';
import { config } from '../../config/env.js';
import { MIN_PASSWORD, restablecerContrasena, solicitarRecuperacion } from './recuperacion.js';
import { MENSAJES_CAPTCHA, verifyTurnstile } from './turnstile.js';
import { requireAuth } from './auth.middleware.js';

const loginSchema = z.object({
  email: z.string().email('Correo inválido.'),
  password: z.string().min(1, 'La contraseña es obligatoria.'),
});

export const authRouter = Router();

/**
 * Hash válido y de MISMO costo que los reales (10): se compara siempre, exista o no
 * la cuenta, para que el tiempo de respuesta no delate qué correos existen
 * (antes un hash mal formado respondía en 1 ms y uno real en ~100 ms).
 */
const HASH_FALSO = bcrypt.hashSync('contraseña-que-nadie-tiene', 10);

const MSG_BLOQUEO_CUENTA = (min: number) => `Demasiados intentos fallidos. Espera ${min} minutos e intenta de nuevo.`;
const MSG_BLOQUEO_IP = 'Demasiadas solicitudes desde esta conexión. Intenta de nuevo en unos minutos.';

/**
 * GET /api/auth/captcha-config -> { enforce, siteKey }. La clave PÚBLICA la entrega el
 * servidor (así se cambia sin recompilar el frontend); la secreta nunca sale de aquí.
 */
authRouter.get('/captcha-config', (_req, res) => {
  const t = config().turnstile;
  res.json({ enforce: t.enforce, siteKey: t.enforce ? t.siteKey || null : null });
});

/** POST /api/auth/login -> { token, user } */
authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const ip = req.ip ?? 'desconocida';
    const userAgent = req.get('user-agent') ?? null;
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      await auditarAcceso({ ip, userAgent, identificadorHash: hashIdentificador(req.body?.email), usuarioId: null, resultado: 'SOLICITUD_INVALIDA' });
      throw badRequest(parsed.error.issues[0]?.message ?? 'Datos inválidos.');
    }
    const { email, password } = parsed.data;
    const identificadorHash = hashIdentificador(email);
    const lim = limitesPorDefecto();

    // Límites por IP y por cuenta, contados en la base (v55). Si esa migración aún
    // no se corrió en esta base, se usa el límite anterior (v48) y se avisa en el log,
    // en vez de dejar a todos sin límite o sin poder entrar.
    let intentoId: number | null = null;
    let intentoLegacyId: number | null = null;
    try {
      const intento = await registrarIntento(ip, identificadorHash, lim);
      intentoId = intento.id;
      if (intento.bloqueo) {
        res.setHeader('Retry-After', String(lim.ventanaMin * 60));
        await auditarAcceso({
          ip, userAgent, identificadorHash, usuarioId: null,
          resultado: intento.bloqueo === 'IP' ? 'BLOQUEO_IP' : 'BLOQUEO_CUENTA',
        });
        throw new AppError(429, intento.bloqueo === 'IP' ? MSG_BLOQUEO_IP : MSG_BLOQUEO_CUENTA(lim.ventanaMin));
      }
    } catch (e) {
      if ((e as { code?: string }).code !== 'ER_NO_SUCH_TABLE') throw e;
      // eslint-disable-next-line no-console
      console.error('[auth] Falta la tabla auth_intentos (migracion_v55): se usa el límite anterior por correo.');
      try {
        const legacy = await registrarIntentoLegacy(email, req.ip ?? null);
        intentoLegacyId = legacy.id;
        if (legacy.fallos > LOGIN_MAX_FALLOS) {
          res.setHeader('Retry-After', String(LOGIN_VENTANA_MIN * 60));
          throw new AppError(429, MSG_BLOQUEO_CUENTA(LOGIN_VENTANA_MIN));
        }
      } catch (e2) {
        if ((e2 as { code?: string }).code !== 'ER_NO_SUCH_TABLE') throw e2;
        // eslint-disable-next-line no-console
        console.error('[auth] Falta también login_intentos (migracion_v48): el login no tiene límite de intentos.');
      }
    }

    // Reto anti-bots (si está activo), DESPUÉS del límite por IP: un bot bloqueado no gasta llamadas a
    // Cloudflare. Un reto fallido cuenta contra la IP pero NO contra la cuenta (si no, cualquiera podría
    // bloquear la cuenta de otra persona sin conocer la contraseña).
    if (config().turnstile.enforce) {
      const reto = await verifyTurnstile(req.body?.['cf-turnstile-response'], 'login', req.ip);
      if (!reto.ok) {
        if (intentoId !== null) await quitarIdentificador(intentoId);
        await auditarAcceso({ ip, userAgent, identificadorHash, usuarioId: null, resultado: 'CAPTCHA_FALLIDO' });
        throw new AppError(403, MENSAJES_CAPTCHA[reto.code]);
      }
    }

    const user = await findByEmail(email);
    const ok = await bcrypt.compare(password, user?.password_hash ?? HASH_FALSO);
    if (!user || !ok) {
      await auditarAcceso({ ip, userAgent, identificadorHash, usuarioId: user?.id ?? null, resultado: 'CREDENCIALES' });
      throw unauthorized('Credenciales incorrectas.');
    }
    if (intentoId !== null) await marcarExito(intentoId);
    if (intentoLegacyId !== null) await marcarIntentoExitosoLegacy(intentoLegacyId);
    await auditarAcceso({ ip, userAgent, identificadorHash, usuarioId: user.id, resultado: 'EXITO' });
    const token = signToken({ sub: user.id, email: user.email, nombre: user.nombre, rol: user.rol, paginas: user.paginas });
    res.json({ token, user: toPublic(user) });
  }),
);

/** Exige el reto anti-bots (si está activo) con la acción de ESTE formulario. */
async function exigirReto(req: Request, accion: string): Promise<void> {
  if (!config().turnstile.enforce) return;
  const reto = await verifyTurnstile(req.body?.['cf-turnstile-response'], accion, req.ip);
  if (!reto.ok) throw new AppError(403, MENSAJES_CAPTCHA[reto.code]);
}

const olvideSchema = z.object({ email: z.string().trim().email('Correo inválido.') });

/**
 * POST /api/auth/forgot-password -> 204 SIEMPRE (exista o no la cuenta). Manda un enlace de un solo
 * uso al correo de una cuenta activa. Solo responde distinto si la IP abusa (429) o el reto falla (403).
 */
authRouter.post(
  '/forgot-password',
  asyncHandler(async (req, res) => {
    const parsed = olvideSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('Escribe un correo válido.');
    await exigirReto(req, 'forgot_password');
    const r = await solicitarRecuperacion(parsed.data.email, req.ip ?? 'desconocida', req.get('user-agent') ?? null);
    if (r === 'LIMITE_IP') {
      res.setHeader('Retry-After', '3600');
      throw new AppError(429, 'Demasiadas solicitudes desde esta conexión. Intenta de nuevo en un rato.');
    }
    res.status(204).end();
  }),
);

const restablecerSchema = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(MIN_PASSWORD, `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`).max(200),
});

/** POST /api/auth/reset-password { token, password } -> 204 | 400 (enlace no válido o vencido). */
authRouter.post(
  '/reset-password',
  asyncHandler(async (req, res) => {
    const parsed = restablecerSchema.safeParse(req.body);
    if (!parsed.success) {
      const falta = parsed.error.issues.find((i) => i.path[0] === 'password');
      throw badRequest(falta?.message ?? 'El enlace no es válido o venció. Solicita uno nuevo.');
    }
    await exigirReto(req, 'reset_password');
    const r = await restablecerContrasena(parsed.data.token, parsed.data.password, req.ip ?? 'desconocida', req.get('user-agent') ?? null);
    if (r !== 'OK') throw badRequest('El enlace no es válido o venció. Solicita uno nuevo.');
    res.status(204).end();
  }),
);

/** GET /api/auth/me -> current staff user (from a fresh DB read). */
authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await findById(req.user!.sub);
    if (!user || !user.activo) throw unauthorized('Cuenta inactiva.');
    res.json({ user: toPublic(user) });
  }),
);
