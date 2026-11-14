/**
 * Light TMS - JWT issuing/verification.
 */

import jwt, { type SignOptions } from 'jsonwebtoken';
import { config } from '../../config/env.js';
import type { Rol, Pagina } from './auth.repo.js';
import type { Accion } from './permisos.js';

export interface JwtPayload {
  sub: number; // staff user id
  email: string;
  nombre: string;
  rol: Rol;
  /** Allowed pages for rol='operador'; null = all. Ignored for 'admin'. */
  paginas: Pagina[] | null;
  /** Acciones críticas (operador); null = valores por defecto. El servidor la relee de la base en cada petición. */
  acciones?: Accion[] | null;
}

/** Signs an access token for a staff user. */
export function signToken(payload: JwtPayload): string {
  const { jwtSecret, jwtExpires } = config().auth;
  const opts: SignOptions = { expiresIn: jwtExpires as SignOptions['expiresIn'] };
  return jwt.sign(payload, jwtSecret, opts);
}

/** Verifies a token and returns its payload, or throws. */
export function verifyToken(token: string): JwtPayload {
  const decoded = jwt.verify(token, config().auth.jwtSecret);
  return decoded as unknown as JwtPayload;
}

/** The placeholder shipped in .env.example / the config default. */
export const JWT_SECRET_POR_DEFECTO = 'change-me-in-production';

/**
 * Returns why `secret` is unsafe to sign tokens with, or null if it's fine.
 * The default value is public (it's in the repository), so with it anyone can
 * forge a token for any user, admin included.
 */
export function problemaSecretoJwt(secret: string): string | null {
  if (!secret || secret === JWT_SECRET_POR_DEFECTO) {
    return 'JWT_SECRET no está configurado (se usaría el valor por defecto, que es público).';
  }
  if (secret.length < 32) return `JWT_SECRET es demasiado corto (${secret.length} caracteres; mínimo 32).`;
  return null;
}
