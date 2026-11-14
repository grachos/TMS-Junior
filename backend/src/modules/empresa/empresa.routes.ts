/**
 * Light TMS - Empresa (own company) routes.
 *   GET /api/empresa   current company data
 *   PUT /api/empresa   save (admin only — affects RNDC identity + consecutivos)
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, badRequest, conflict } from '../../http/errors.js';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { requireRole } from '../auth/auth.middleware.js';
import * as repo from './empresa.repo.js';
import { withTransaction } from '../../db/pool.js';
import { actorDe, auditar, cambios } from '../auditoria/auditoria.repo.js';

export const empresaRouter = Router();

const PREFIJO = { manifiesto: 'MAN', remesa: 'REM' } as const;

/**
 * Decides what a counter becomes when the Empresa page is saved.
 *
 * Before, the form sent back the counter it had loaded and the save wrote it
 * as-is: if a dispatch happened while the page was open, the counter went
 * BACK, and the next dispatches collided with the unique key (v47) — "ya
 * existe un registro con ese número" — until it caught up.
 * - Not changed by the user (equal to what the form loaded) -> keep the current DB value.
 * - Changed -> only if the DB still has the value the form loaded (else 409),
 *   with the right prefix, and never below the highest number already used.
 */
async function resolverConsecutivo(
  conn: PoolConnection,
  tipo: 'manifiesto' | 'remesa',
  actual: repo.Empresa,
  datos: z.infer<typeof empresaSchema>,
): Promise<string> {
  const enDb = String(actual[`consecutivo_${tipo}`] ?? `${PREFIJO[tipo]}-00000`);
  const nuevo = datos[`consecutivo_${tipo}`];
  const original = datos[`consecutivo_${tipo}_original`];
  if (nuevo === undefined || nuevo === enDb || (original != null && nuevo === original)) return enDb;
  if (original !== enDb) {
    throw conflict(
      `El consecutivo de ${tipo} cambió mientras editabas (ahora es ${enDb}). Recarga la página antes de modificarlo.`,
    );
  }
  const m = new RegExp(`^${PREFIJO[tipo]}-(\\d{1,9})$`).exec(nuevo);
  if (!m) throw badRequest(`El consecutivo de ${tipo} debe tener la forma ${PREFIJO[tipo]}-00000.`);
  const columna = tipo === 'manifiesto' ? 'num_manifiesto' : 'num_remesa';
  const [[fila]] = await conn.query<RowDataPacket[]>(
    `SELECT MAX(CAST(SUBSTRING_INDEX(${columna}, '-', -1) AS UNSIGNED)) AS maximo
     FROM ${tipo} WHERE ${columna} LIKE ?`,
    [`${PREFIJO[tipo]}-%`],
  );
  const maximo = Number(fila?.maximo ?? 0);
  if (Number(m[1]) < maximo) {
    throw badRequest(
      `No se puede poner el consecutivo de ${tipo} en ${nuevo}: ya existe el ${PREFIJO[tipo]}-${String(maximo).padStart(5, '0')}. ` +
        'Los siguientes despachos repetirían números ya usados.',
    );
  }
  return nuevo;
}

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
  // Value each counter had when the form was loaded (optimistic check, see PUT).
  consecutivo_remesa_original: z.string().trim().optional().nullable(),
  consecutivo_manifiesto_original: z.string().trim().optional().nullable(),
});

empresaRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    // Never send the RNDC password: any logged-in user reads this endpoint
    // (the dispatch form loads it too). Only say whether one is configured.
    const { rndc_password: clave, ...empresa } = await repo.obtener();
    res.json({ ...empresa, rndc_password_configurada: Boolean(clave) });
  }),
);

empresaRouter.put(
  '/',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const parsed = empresaSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Datos inválidos.');
    await withTransaction(async (conn) => {
      // Lock the company row (same row dispatch locks to reserve numbers) so
      // the counters checked below can't move until this save commits.
      await conn.query('SELECT id FROM maestro_empresa WHERE id = 1 FOR UPDATE');
      const antes = await repo.obtener(conn);
      const datos = { ...parsed.data };
      for (const tipo of ['manifiesto', 'remesa'] as const) {
        datos[`consecutivo_${tipo}`] = await resolverConsecutivo(conn, tipo, antes, parsed.data);
      }
      await repo.guardar(datos, conn);
      const despues = await repo.obtener(conn);
      // The RNDC password is a secret: only record that it changed.
      const diff = cambios(antes as unknown as Record<string, unknown>, despues as unknown as Record<string, unknown>, ['rndc_password']);
      const resumen = Object.keys(diff).length ? Object.keys(diff).join(', ') : 'sin cambios';
      await auditar(conn, actorDe(req), 'empresa.actualizar', 'empresa', 1, `Editó los datos de la empresa: ${resumen}`, { cambios: diff });
    });
    res.json({ ok: true });
  }),
);
