/**
 * Light TMS - Impuestos routes.
 *   GET    /api/impuestos/ica/:codigo   tariff of a municipio (any logged-in user; null if none)
 *   GET    /api/impuestos/ica           configured tariffs (admin) — q, page, pageSize
 *   PUT    /api/impuestos/ica/:codigo   set/update a tariff (admin)
 *   DELETE /api/impuestos/ica/:codigo   remove a tariff (admin)
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, badRequest, notFound } from '../../http/errors.js';
import { requireAccion } from '../auth/auth.middleware.js';
import { withTransaction, db } from '../../db/pool.js';
import { actorDe, auditar } from '../auditoria/auditoria.repo.js';
import * as repo from './impuestos.repo.js';

export const impuestosRouter = Router();

const codigoSchema = z.string().trim().regex(/^\d{1,8}$/, 'Código de municipio inválido.');

/**
 * Per-mil tariff: 0..100, at most 2 decimals — the same precision as
 * solicitud_servicio.porcentaje_ica (DECIMAL(5,2)): with more, the solicitud
 * would store a rounded rate while the retention is computed from the exact one.
 */
const tarifaSchema = z.object({
  tarifa_por_mil: z
    .union([z.number(), z.string().trim().min(1, 'La tarifa es obligatoria.')])
    .transform((v) => (typeof v === 'string' ? Number(v.replace(',', '.')) : v))
    .pipe(
      z
        .number({ error: 'La tarifa debe ser un número.' })
        .finite('La tarifa debe ser un número.')
        .min(0, 'La tarifa no puede ser negativa.')
        .max(100, 'La tarifa por mil no puede superar 100.')
        .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, 'La tarifa admite máximo 2 decimales.'),
    ),
});

function codigoDe(req: { params: Record<string, string> }): string {
  const parsed = codigoSchema.safeParse(req.params.codigo);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Código inválido.');
  return parsed.data;
}

/** Throws unless `codigo` is a municipality (not one of its centros poblados). */
async function exigirMunicipio(conn: Parameters<typeof repo.ubicacionIca>[0], codigo: string): Promise<repo.UbicacionIca> {
  const u = await repo.ubicacionIca(conn, codigo);
  if (!u) throw notFound('El municipio no existe.');
  if (u.hereda) {
    throw badRequest(`${u.municipio} es un centro poblado de ${u.cabecera_nombre}. El ICA es municipal: configura la tarifa en ${u.cabecera_nombre}.`);
  }
  return u;
}

impuestosRouter.get(
  '/ica/:codigo',
  asyncHandler(async (req, res) => {
    const codigo = codigoDe(req);
    const u = await repo.ubicacionIca(db(), codigo);
    // The tariff that applies is the one of the municipality the code belongs to.
    res.json({
      codigo_rndc: codigo,
      municipio: u?.municipio ?? null,
      cabecera_codigo: u?.cabecera_codigo ?? null,
      cabecera_nombre: u?.cabecera_nombre ?? null,
      hereda: u?.hereda ?? false,
      tarifa_por_mil: u ? await repo.tarifaDe(db(), u.cabecera_codigo) : null,
    });
  }),
);

impuestosRouter.get(
  '/ica',
  requireAccion('impuestos.gestionar'),
  asyncHandler(async (req, res) => {
    const num = (v: unknown) => {
      const n = Number(v);
      return Number.isInteger(n) && n > 0 ? n : undefined;
    };
    res.json(
      await repo.listar({
        q: typeof req.query.q === 'string' && req.query.q.trim() !== '' ? req.query.q.trim() : undefined,
        page: num(req.query.page),
        pageSize: num(req.query.pageSize),
      }),
    );
  }),
);

impuestosRouter.put(
  '/ica/:codigo',
  requireAccion('impuestos.gestionar'),
  asyncHandler(async (req, res) => {
    const codigo = codigoDe(req);
    const parsed = tarifaSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Tarifa inválida.');
    const tarifa = parsed.data.tarifa_por_mil;
    await withTransaction(async (conn) => {
      const { municipio } = await exigirMunicipio(conn, codigo);
      const antes = await repo.tarifaBloqueada(conn, codigo);
      await repo.guardar(conn, codigo, tarifa, req.user?.sub ?? null);
      await auditar(
        conn, actorDe(req), 'impuesto.ica.guardar', 'impuesto_ica', codigo,
        antes === null ? `Configuró el ICA de ${municipio}: ${tarifa} por mil` : `Cambió el ICA de ${municipio}: ${antes} → ${tarifa} por mil`,
        { municipio, antes, despues: tarifa },
      );
    });
    res.json({ ok: true });
  }),
);

impuestosRouter.delete(
  '/ica/:codigo',
  requireAccion('impuestos.gestionar'),
  asyncHandler(async (req, res) => {
    const codigo = codigoDe(req);
    await withTransaction(async (conn) => {
      const u = await repo.ubicacionIca(conn, codigo);
      if (u?.hereda) await exigirMunicipio(conn, codigo); // centro poblado: 400 with the explanation
      const antes = await repo.tarifaBloqueada(conn, codigo);
      if (antes === null) throw notFound('Ese municipio no tiene tarifa de ICA configurada.');
      const municipio = u?.municipio ?? codigo;
      await repo.eliminar(conn, codigo);
      await auditar(conn, actorDe(req), 'impuesto.ica.eliminar', 'impuesto_ica', codigo, `Quitó el ICA de ${municipio} (era ${antes} por mil)`, {
        municipio, antes,
      });
    });
    res.json({ ok: true });
  }),
);
