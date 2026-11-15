/**
 * Light TMS - Módulo de soporte y mantenimiento: PRIVADO del propietario de la plataforma.
 *
 * Seguridad por defecto: la PRIMERA línea del router es requirePlatformOwner, así cualquier endpoint que se
 * agregue después queda denegado para todos menos el propietario (la prueba recorre soporteRouter.stack).
 * No usa roles, requireAccion ni el catálogo de páginas: "admin puede todo" NO autoriza nada aquí.
 *
 *   GET  /api/soporte/estado           comprobación de sesión y capacidad (la consola la usa al cargar)
 *   PUT  /api/soporte/perfil           el propietario cambia SU nombre / correo / contraseña (reautenticación)
 *   POST /api/soporte/sesiones/cerrar  cierra TODAS las sesiones abiertas de la cuenta (reautenticación)
 */

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { AppError, asyncHandler, badRequest, unauthorized } from '../../http/errors.js';
import { db } from '../../db/pool.js';
import { requirePlatformOwner } from '../auth/propietario.guard.js';
import {
  actualizarPerfilPropietario, emailExists, findById, subirVersionSesion,
} from '../auth/auth.repo.js';
import { auditar, actorDe } from '../auditoria/auditoria.repo.js';
import { hashIdentificador, limitesPorDefecto, marcarExito, registrarIntento } from '../auth/accesoGuard.js';
import { MIN_PASSWORD } from '../auth/recuperacion.js';

export const soporteRouter = Router();
soporteRouter.use(requirePlatformOwner); // ← siempre la primera línea

soporteRouter.get(
  '/estado',
  asyncHandler(async (req, res) => {
    const u = await findById(req.user!.sub);
    res.json({ ok: true, propietario: { nombre: u?.nombre ?? '', email: u?.email ?? '' } });
  }),
);

/**
 * Reautenticación RECIENTE: exige la contraseña actual en la misma petición y limita los intentos fallidos
 * (para que un token robado no sirva para adivinar la contraseña desde aquí).
 */
async function reautenticar(req: import('express').Request, passwordActual: string): Promise<void> {
  const id = req.user!.sub;
  const lim = limitesPorDefecto();
  const idHash = hashIdentificador(`reauth-propietario:${id}`);
  const intento = await registrarIntento(req.ip ?? 'desconocida', idHash, lim);
  if (intento.bloqueo) throw new AppError(429, 'Demasiados intentos. Espera unos minutos.');
  const u = await findById(id);
  const ok = !!u && (await bcrypt.compare(passwordActual, u.password_hash));
  if (!ok) throw unauthorized('La contraseña actual no es correcta.');
  await marcarExito(intento.id);
}

const perfilSchema = z.object({
  passwordActual: z.string().min(1, 'Escribe tu contraseña actual.'),
  nombre: z.string().trim().min(1).max(120).optional(),
  email: z.string().trim().email('Correo inválido.').optional(),
  passwordNueva: z.string().min(MIN_PASSWORD, `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`).max(200).optional(),
}).strict(); // lista explícita: rol, activo, uuid, etc. no existen aquí

soporteRouter.put(
  '/perfil',
  asyncHandler(async (req, res) => {
    const parsed = perfilSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Datos inválidos.');
    const { passwordActual, nombre, email, passwordNueva } = parsed.data;
    await reautenticar(req, passwordActual);
    const id = req.user!.sub;
    if (email && (await emailExists(email, id))) throw badRequest('Ya existe otra cuenta con ese correo.');
    await actualizarPerfilPropietario(id, {
      nombre, email, passwordHash: passwordNueva ? await bcrypt.hash(passwordNueva, 10) : undefined,
    });
    const cambiados = [nombre && 'nombre', email && 'correo', passwordNueva && 'contraseña'].filter(Boolean).join(', ') || 'sin cambios';
    await auditar(db(), actorDe(req), 'propietario.perfil', 'usuario', id, `El propietario cambió su perfil: ${cambiados}`, { campos: cambiados });
    // Cambiar correo o contraseña cierra las sesiones (incluida esta): hay que volver a ingresar.
    res.json({ ok: true, cerroSesiones: Boolean(email || passwordNueva) });
  }),
);

soporteRouter.post(
  '/sesiones/cerrar',
  asyncHandler(async (req, res) => {
    const parsed = z.object({ passwordActual: z.string().min(1) }).strict().safeParse(req.body);
    if (!parsed.success) throw badRequest('Escribe tu contraseña actual.');
    await reautenticar(req, parsed.data.passwordActual);
    await subirVersionSesion(req.user!.sub);
    await auditar(db(), actorDe(req), 'propietario.sesiones', 'usuario', req.user!.sub, 'El propietario cerró todas sus sesiones', {});
    res.json({ ok: true });
  }),
);
