/**
 * Light TMS - Municipios routes.
 *   GET /api/municipios/buscar?q=   autocomplete (DIVIPOLA)
 */

import { Router } from 'express';
import { asyncHandler } from '../../http/errors.js';
import * as repo from './municipio.repo.js';

export const municipioRouter = Router();

municipioRouter.get(
  '/buscar',
  asyncHandler(async (req, res) => {
    // solo_municipios=1: only municipalities (DANE code + '000'), not their centros poblados (used by Impuestos).
    res.json(await repo.buscar(String(req.query.q ?? ''), 15, req.query.solo_municipios === '1'));
  }),
);
