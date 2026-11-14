/**
 * Light TMS - Empresa (own company) routes.
 *   GET /api/empresa   current company data
 *   PUT /api/empresa   save (admin only — affects RNDC identity + consecutivos)
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, badRequest } from '../../http/errors.js';
import { requireRole } from '../auth/auth.middleware.js';
import * as repo from './empresa.repo.js';
import { withTransaction } from '../../db/pool.js';
import { actorDe, auditar, cambios } from '../auditoria/auditoria.repo.js';

export const empresaRouter = Router();

const optionalStr = z.string().trim().optional().nullable();

const empresaSchema = z.object({
  tipo_id: z.enum(['N', 'C']).default('N'),
  nit: z.string().trim().min(1, 'El NIT es obligatorio.'),
  rndc_username: optionalStr,
  rndc_password: optionalStr,
  razon_social: optionalStr,
  direccion: optionalStr,
  telefono: optionalStr,
  cod_municipio: optionalStr,
  municipio_nombre: optionalStr,
  nro_poliza: optionalStr,
  // Aseguradora de mercancía peligrosa (tabla "Tomador Póliza" de la Remesa).
  aseguradora_carga_nombre: optionalStr,
  aseguradora_carga_nit: optionalStr,
  poliza_carga_numero: optionalStr,
  poliza_carga_vencimiento: optionalStr,
  emf: optionalStr,
  consecutivo_remesa: z.string().trim().optional(),
  consecutivo_manifiesto: z.string().trim().optional(),
});

empresaRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(await repo.obtener());
  }),
);

empresaRouter.put(
  '/',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const parsed = empresaSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Datos inválidos.');
    await withTransaction(async (conn) => {
      const antes = await repo.obtener(conn);
      await repo.guardar(parsed.data, conn);
      const despues = await repo.obtener(conn);
      // The RNDC password is a secret: only record that it changed.
      const diff = cambios(antes as unknown as Record<string, unknown>, despues as unknown as Record<string, unknown>, ['rndc_password']);
      const resumen = Object.keys(diff).length ? Object.keys(diff).join(', ') : 'sin cambios';
      await auditar(conn, actorDe(req), 'empresa.actualizar', 'empresa', 1, `Editó los datos de la empresa: ${resumen}`, { cambios: diff });
    });
    res.json({ ok: true });
  }),
);
