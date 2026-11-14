/**
 * Light TMS - Auth routes: login + current user.
 */

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { AppError, asyncHandler, badRequest, unauthorized } from '../../http/errors.js';
import {
  findByEmail, findById, toPublic, registrarIntento, marcarIntentoExitoso, LOGIN_MAX_FALLOS, LOGIN_VENTANA_MIN,
} from './auth.repo.js';
import { signToken } from './jwt.js';
import { requireAuth } from './auth.middleware.js';

const loginSchema = z.object({
  email: z.string().email('Correo inválido.'),
  password: z.string().min(1, 'La contraseña es obligatoria.'),
});

export const authRouter = Router();

/** POST /api/auth/login -> { token, user } */
authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? 'Datos inválidos.');
    }
    const { email, password } = parsed.data;

    // Brute-force lockout, counted in the DB (works across processes/restarts).
    // Applies to unknown emails too, so it doesn't reveal which accounts exist.
    // If migracion_v48 hasn't been run yet, login keeps working unlimited and
    // the error is logged, rather than locking everyone out.
    let intentoId: number | null = null;
    try {
      const intento = await registrarIntento(email, req.ip ?? null);
      intentoId = intento.id;
      if (intento.fallos > LOGIN_MAX_FALLOS) {
        res.setHeader('Retry-After', String(LOGIN_VENTANA_MIN * 60));
        throw new AppError(
          429,
          `Demasiados intentos fallidos. Espera ${LOGIN_VENTANA_MIN} minutos e intenta de nuevo.`,
        );
      }
    } catch (e) {
      if ((e as { code?: string }).code !== 'ER_NO_SUCH_TABLE') throw e;
      // eslint-disable-next-line no-console
      console.error('[auth] Falta la tabla login_intentos (migracion_v48): el login no tiene límite de intentos.');
    }

    const user = await findByEmail(email);
    // Constant-ish behaviour: always run a hash comparison to reduce user enumeration.
    const hash = user?.password_hash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinva';
    const ok = await bcrypt.compare(password, hash);
    if (!user || !ok) {
      throw unauthorized('Credenciales incorrectas.');
    }
    if (intentoId !== null) await marcarIntentoExitoso(intentoId);
    const token = signToken({ sub: user.id, email: user.email, nombre: user.nombre, rol: user.rol, paginas: user.paginas });
    res.json({ token, user: toPublic(user) });
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
