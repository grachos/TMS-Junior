/**
 * Light TMS - Authentication + authorization middleware.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { unauthorized, forbidden } from '../../http/errors.js';
import { verifyToken, type JwtPayload } from './jwt.js';
import { findById, claveCacheUsuario, type Rol, type Pagina } from './auth.repo.js';
import { cached } from '../../util/cache.js';
import { tieneAccion, type Accion } from './permisos.js';

// Augment Express's Request with the authenticated user.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

/** How long requireAuth trusts its cached read of the user (per process). */
const USUARIO_CACHE_MS = 30_000;

/**
 * Requires a valid Bearer token AND a still-active account; attaches the user
 * to req.user. The role, pages, name and email come from the database, not
 * from the token: a token used to carry them for its whole 8 h life, so a
 * deactivated user kept working and a demoted admin kept admin rights until it
 * expired (test/auth_blindaje.db.test.ts). The lookup is cached for 30 s per
 * process and invalidated by updateUser(), so changes made from Usuarios apply
 * on the next request.
 */
export const requireAuth: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  const header = req.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    throw unauthorized('Falta el token de autenticación.');
  }
  let payload: JwtPayload;
  try {
    payload = verifyToken(token);
  } catch {
    throw unauthorized('Token inválido o expirado.');
  }
  const id = Number(payload.sub);
  cached(claveCacheUsuario(id), USUARIO_CACHE_MS, () => findById(id))
    .then((u) => {
      if (!u || !u.activo) return next(unauthorized('Tu sesión ya no es válida. Inicia sesión de nuevo.'));
      // Sesiones revocadas (cambio de contraseña, recuperación, cierre forzado): la versión del token ya no coincide.
      if ((payload.sv ?? 0) !== (u.sesion_version ?? 0)) {
        return next(unauthorized('Tu sesión ya no es válida. Inicia sesión de nuevo.'));
      }
      req.user = { sub: u.id, email: u.email, nombre: u.nombre, rol: u.rol, paginas: u.paginas, acciones: u.acciones, sv: payload.sv ?? 0 };
      next();
    })
    .catch(next);
};

/**
 * Requires the authenticated user to have one of the given roles.
 * Used to gate real RNDC sending behind the 'admin' role.
 */
export function requireRole(...roles: Rol[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw unauthorized();
    if (!roles.includes(req.user.rol)) {
      throw forbidden('Se requiere el rol: ' + roles.join(' o ') + '.');
    }
    next();
  };
}

/**
 * Requires the authenticated user to have access to the given page/module.
 * 'admin' always passes. An operador with paginas=null (default, backward
 * compatible) also passes everything; once an admin assigns a specific list,
 * only those pages are allowed. Used on each module's list/create/edit
 * endpoints — NOT on shared lookup endpoints (/buscar, /detalle, /resumen)
 * that other pages' forms depend on regardless of the user's own page access.
 */
export function requirePagina(pagina: Pagina): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw unauthorized();
    if (req.user.rol === 'admin') return next();
    if (req.user.paginas === null || req.user.paginas.includes(pagina)) return next();
    throw forbidden(`No tienes acceso al módulo "${pagina}".`);
  };
}

/**
 * Requires the user to be allowed to run a critical action (permisos.ts).
 * 'admin' always passes; an operador follows the list an admin configured in
 * Usuarios, or the defaults when none was set.
 */
export function requireAccion(accion: Accion): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw unauthorized();
    if (!tieneAccion(req.user, accion)) {
      throw forbidden('No tienes permiso para esta acción. Pídele a un administrador que te la habilite.');
    }
    next();
  };
}
