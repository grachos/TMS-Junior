/**
 * Light TMS - Activity viewer (admin only): GET /api/auditoria
 * Filters: usuario (id), accion, entidad, entidad_id, desde, hasta (YYYY-MM-DD), q (text), page, pageSize.
 */

import { Router } from 'express';
import { asyncHandler } from '../../http/errors.js';
import { requireAccion } from '../auth/auth.middleware.js';
import { esPropietario } from '../auth/propietario.guard.js';
import { accionesRegistradas, listar } from './auditoria.repo.js';

export const auditoriaRouter = Router();
auditoriaRouter.use(requireAccion('actividad.ver'));

const texto = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const fecha = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
const entero = (v: unknown) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

auditoriaRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = req.query;
    // Decide el SERVIDOR (relee la cuenta): solo el propietario ve la actividad de soporte.
    const ocultarSoporte = !(await esPropietario(req.user!.sub, req.user!.sv ?? 0));
    const { items, total } = await listar({
      usuarioId: entero(q.usuario),
      accion: texto(q.accion),
      entidad: texto(q.entidad),
      entidadId: texto(q.entidad_id),
      desde: fecha(q.desde),
      hasta: fecha(q.hasta),
      q: texto(q.q),
      page: entero(q.page),
      pageSize: entero(q.pageSize),
      ocultarSoporte,
    });
    res.json({ items, total, acciones: await accionesRegistradas(ocultarSoporte) });
  }),
);
