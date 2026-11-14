/**
 * Light TMS - Solicitud + despacho routes. Replaces ?r=solicitud* / despacho*.
 *   GET  /api/solicitudes             list (q, p, desde, hasta)
 *   GET  /api/solicitudes/:id         solicitud + manifiesto + remesas
 *   POST /api/solicitudes             create
 *   PUT  /api/solicitudes/:id         update (only 'borrador')
 *   POST /api/solicitudes/:id/despachar   confirm dispatch (enqueues; operador OK)
 */

import { Router } from 'express';
import { asyncHandler, badRequest, notFound } from '../../http/errors.js';
import { validarProductoPeligrosa, validarContenedorSerial } from '../../util/validaciones.js';
import { requirePagina } from '../auth/auth.middleware.js';
import * as repo from './solicitud.repo.js';

export const solicitudRouter = Router();
solicitudRouter.use(requirePagina('solicitudes'));

solicitudRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '');
    const pagina = Math.max(1, Number.parseInt(String(req.query.p ?? '1'), 10) || 1);
    const desde = req.query.desde ? String(req.query.desde) : null;
    const hasta = req.query.hasta ? String(req.query.hasta) : null;
    const porPagina = 10;
    const { items, total } = await repo.listarConPaginacion(q, pagina, porPagina, desde, hasta);
    res.json({ items, total, pagina, paginas: Math.ceil(total / porPagina) });
  }),
);

solicitudRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const manifiestoId = req.query.manifiesto_id ? Number(req.query.manifiesto_id) : null;
    const data = await repo.obtener(Number(req.params.id), manifiestoId);
    if (!data) throw notFound('Solicitud no encontrada.');
    res.json(data);
  }),
);

solicitudRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const err = await validarProductoPeligrosa(
      String(req.body?.mercancia_codigo ?? ''),
      String(req.body?.naturaleza_carga ?? ''),
    );
    if (err) throw badRequest(err);
    const errContenedor = validarContenedorSerial(
      String(req.body?.operacion_transporte ?? ''),
      String(req.body?.contenedor_serial ?? ''),
    );
    if (errContenedor) throw badRequest(errContenedor);
    const id = await repo.crear(req.body ?? {});
    res.status(201).json({ id });
  }),
);

solicitudRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const data = await repo.obtener(id);
    if (!data) throw notFound('Solicitud no encontrada.');
    if (data.solicitud.estado !== 'borrador') {
      throw badRequest('La solicitud solo se puede editar en estado borrador.');
    }
    const err = await validarProductoPeligrosa(
      String(req.body?.mercancia_codigo ?? ''),
      String(req.body?.naturaleza_carga ?? ''),
    );
    if (err) throw badRequest(err);
    const errContenedor = validarContenedorSerial(
      String(req.body?.operacion_transporte ?? ''),
      String(req.body?.contenedor_serial ?? ''),
    );
    if (errContenedor) throw badRequest(errContenedor);
    await repo.actualizar(id, req.body ?? {});
    res.json({ ok: true });
  }),
);

/** POST /api/solicitudes/:id/despachar — confirm dispatch (enqueues, no live send). */
solicitudRouter.post(
  '/:id/despachar',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!req.body?.placa_vehiculo || !req.body?.conductor_num_id) {
      throw badRequest('Placa y conductor son obligatorios para despachar.');
    }

    // Estado, vehículos restantes y peso disponible se validan DENTRO de la
    // transacción, con la solicitud bloqueada (confirmarDespacho).
    await repo.confirmarDespacho(id, req.body);
    res.json({ ok: true });
  }),
);
