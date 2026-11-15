/**
 * Light TMS - Staff user management. Admin-only: create/edit accounts and
 * assign per-page permissions (see auth.repo.ts's PAGINAS).
 *
 *   GET  /api/usuarios          list all staff users
 *   GET  /api/usuarios/paginas  assignable page keys + labels (for checkboxes)
 *   POST /api/usuarios          create
 *   PUT  /api/usuarios/:id      update (profile, rol, paginas, activo, password)
 */

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { asyncHandler, badRequest, forbidden, notFound } from '../../http/errors.js';
import { requireRole } from '../auth/auth.middleware.js';
import { withTransaction } from '../../db/pool.js';
import { actorDe, auditar, cambios } from '../auditoria/auditoria.repo.js';
import { ACCIONES, ACCIONES_DEF, ACCIONES_POR_DEFECTO } from '../auth/permisos.js';
import { PAGINAS, type Pagina, createUser, updateUser, esCuentaPropietario, listUsers, emailExists, findById, toPublic } from '../auth/auth.repo.js';

export const usuarioRouter = Router();

/** Labels shown next to each page's checkbox — mirrors AppShell.tsx's nav. */
const PAGINA_LABELS: Record<Pagina, string> = {
  solicitudes: 'Solicitudes',
  despachos: 'Despachos',
  cola: 'Cola de envíos',
  cumplido: 'Cumplido',
  informe: 'Informe',
  terceros: 'Terceros',
  vehiculos: 'Vehículos',
  productos: 'Productos',
  empresa: 'Empresa',
};

usuarioRouter.use(requireRole('admin'));

usuarioRouter.get(
  '/paginas',
  asyncHandler(async (_req, res) => {
    res.json(PAGINAS.map((p) => ({ pagina: p, label: PAGINA_LABELS[p] })));
  }),
);

/** Catálogo de acciones críticas (para los checkboxes) y cuáles tiene un operador sin configurar. */
usuarioRouter.get(
  '/acciones',
  asyncHandler(async (_req, res) => {
    res.json({ acciones: ACCIONES_DEF, porDefecto: ACCIONES_POR_DEFECTO });
  }),
);

usuarioRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json((await listUsers()).map(toPublic));
  }),
);

usuarioRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const u = await findById(Number(req.params.id));
    if (!u) throw notFound('Usuario no encontrado.');
    res.json(toPublic(u));
  }),
);

const paginasSchema = z.array(z.enum(PAGINAS)).nullable();
const accionesSchema = z.array(z.enum(ACCIONES)).nullable();

/**
 * Campos reservados: pertenecen al sistema (identidad, propiedad, sesiones). Si llegan en un cuerpo se rechaza la
 * petición (400), no se ignoran en silencio. Los esquemas además son `.strict()`: ningún campo fuera de la lista.
 */
const CAMPOS_RESERVADOS = ['uuid', 'id', 'owner', 'isowner', 'is_owner', 'propietario', 'platformowner', 'supportowner', 'sesion_version', 'sv', 'protegido', 'capabilities', 'permisos'];
function rechazarCamposReservados(body: unknown): void {
  if (!body || typeof body !== 'object') return;
  const usados = Object.keys(body as Record<string, unknown>).filter((k) => CAMPOS_RESERVADOS.includes(k.toLowerCase()));
  if (usados.length) throw badRequest(`Campo no permitido: ${usados.join(', ')}.`);
}

const crearSchema = z.object({
  email: z.string().trim().email('Correo inválido.'),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres.'),
  nombre: z.string().trim().min(1, 'El nombre es obligatorio.'),
  rol: z.enum(['admin', 'operador']),
  paginas: paginasSchema.optional(),
  acciones: accionesSchema.optional(),
}).strict();

usuarioRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    rechazarCamposReservados(req.body);
    const parsed = crearSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Datos inválidos.');
    const { email, password, nombre, rol, paginas, acciones } = parsed.data;
    if (await emailExists(email)) throw badRequest('Ya existe una cuenta con ese correo.');
    const passwordHash = await bcrypt.hash(password, 10);
    const id = await withTransaction(async (conn) => {
      const nuevo = await createUser({ email, passwordHash, nombre, rol, paginas: paginas ?? null, acciones: acciones ?? null }, conn);
      await auditar(conn, actorDe(req), 'usuario.crear', 'usuario', nuevo, `Creó el usuario ${email} (${rol})`, {
        email, nombre, rol, paginas: paginas ?? null, acciones: acciones ?? null,
      });
      return nuevo;
    });
    res.status(201).json({ id });
  }),
);

const actualizarSchema = z.object({
  email: z.string().trim().email('Correo inválido.'),
  nombre: z.string().trim().min(1, 'El nombre es obligatorio.'),
  rol: z.enum(['admin', 'operador']),
  paginas: paginasSchema.optional(),
  acciones: accionesSchema.optional(),
  activo: z.boolean(),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres.').optional().or(z.literal('')),
}).strict();

usuarioRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existente = await findById(id);
    if (!existente) throw notFound('Usuario no encontrado.');
    // La cuenta protegida se rechaza ANTES de cualquier otra regla (el servicio también la protege).
    if (await esCuentaPropietario(id)) throw forbidden('Esta cuenta está protegida: no se puede modificar desde Usuarios.');

    rechazarCamposReservados(req.body);
    const parsed = actualizarSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Datos inválidos.');
    const { email, nombre, rol, paginas, acciones, activo, password } = parsed.data;

    // Guard rails so an admin can't lock themselves out from this same screen.
    if (req.user!.sub === id) {
      if (!activo) throw badRequest('No puedes desactivar tu propia cuenta.');
      if (existente.rol === 'admin' && rol !== 'admin') {
        throw badRequest('No puedes quitarte el rol de administrador a ti mismo.');
      }
    }

    if (await emailExists(email, id)) throw badRequest('Ya existe otra cuenta con ese correo.');

    const passwordHash = password ? await bcrypt.hash(password, 10) : undefined;
    await withTransaction(async (conn) => {
      await updateUser(id, { email, nombre, rol, paginas: paginas ?? null, acciones, activo, passwordHash }, conn, req.user!.sub);
      const diff: Record<string, unknown> = cambios(
        { email: existente.email, nombre: existente.nombre, rol: existente.rol, paginas: existente.paginas, acciones: existente.acciones, activo: Number(existente.activo) },
        { email: email.trim().toLowerCase(), nombre: nombre.trim(), rol, paginas: rol === 'admin' ? null : (paginas ?? null), acciones: rol === 'admin' ? null : acciones === undefined ? existente.acciones : acciones, activo: activo ? 1 : 0 },
      );
      if (passwordHash) diff.password = 'cambió';
      const resumen = Object.keys(diff).length ? Object.keys(diff).join(', ') : 'sin cambios';
      await auditar(conn, actorDe(req), 'usuario.actualizar', 'usuario', id, `Editó el usuario ${existente.email}: ${resumen}`, { cambios: diff });
    });
    res.json({ ok: true });
  }),
);
