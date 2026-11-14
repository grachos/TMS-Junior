/**
 * Light TMS - Cola + despachos + cumplido routes.
 *
 *   GET  /api/cola?proceso=          queue rows + summary + envioHabilitado
 *   GET  /api/cola/resumen           lightweight counts only (nav badge polling)
 *   POST /api/cola/procesar          drain the queue (admin — may hit RNDC)
 *   POST /api/cola/:id/procesar      process one item (admin)
 *   POST /api/cola/:id/cancelar      cancel a not-yet-sent item (admin)
 *   GET  /api/cola/:id/xml           XML preview + RNDC response (text/plain)
 *   GET  /api/cola/:id/anular        preview de anulación individual de esta fila (admin)
 *   POST /api/cola/:id/anular        encola la anulación individual (admin)
 *
 *   GET  /api/despachos              dispatches list (q, p, desde, hasta)
 *   GET  /api/despachos/resumen      count not yet accepted by RNDC (nav badge polling)
 *   POST /api/despachos/:manifiestoId/procesar   send one dispatch (admin)
 *   GET  /api/despachos/:manifiestoId/anular     preview de pasos de anulación (admin)
 *   POST /api/despachos/:manifiestoId/anular     encola la anulación (admin)
 *
 *   GET  /api/cumplido               dispatches pending cumplido
 *   GET  /api/cumplido/resumen       count pending cumplido (nav badge polling)
 *   GET  /api/cumplido/:manifiestoId manifiesto + solicitud + remesas
 *   POST /api/cumplido/:manifiestoId save cumplido + enqueue (operador OK)
 */

import { Router } from 'express';
import { asyncHandler, badRequest, notFound } from '../../http/errors.js';
import { requireRole, requirePagina } from '../auth/auth.middleware.js';
import { config } from '../../config/env.js';
import { db, withTransaction } from '../../db/pool.js';
import type { RowDataPacket } from 'mysql2';
import * as cola from './cola.repo.js';
import { actorDe, auditar } from '../auditoria/auditoria.repo.js';

export const colaRouter = Router();
colaRouter.use(requirePagina('cola'));

const validProceso = (p: unknown): 'todos' | 'despacho' | 'cumplido' | 'anulacion' =>
  p === 'despacho' || p === 'cumplido' || p === 'anulacion' ? p : 'todos';

/** Motivo que el usuario elige en el modal de anulación (cascada o individual). */
const MOTIVOS_ANULACION = ['digitacion', 'cancelacion'] as const;

colaRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const proceso = validProceso(req.query.proceso);
    const [filas, resumen] = await Promise.all([cola.listar(proceso), cola.resumen(proceso)]);
    res.json({ filas, resumen, proceso, envioHabilitado: config().cola.envioHabilitado, ambiente: config().rndc.ambiente });
  }),
);

/**
 * GET /api/cola/resumen — counts only (pendiente/enviando/enviado/error), no
 * row data. Cheap enough to poll from the nav badge on every authenticated page.
 */
colaRouter.get(
  '/resumen',
  asyncHandler(async (req, res) => {
    const proceso = validProceso(req.query.proceso);
    res.json(await cola.resumen(proceso));
  }),
);

colaRouter.post(
  '/procesar',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const r = await cola.drenar();
    const modo = config().cola.envioHabilitado ? 'envío real' : 'modo seguro';
    // Manual "Procesar ahora" (the cron worker is not audited: it runs every few minutes).
    await auditar(db(), actorDe(req), 'cola.procesar', 'cola', null,
      `Procesó la cola (${modo}): enviados ${r.enviados}, errores ${r.errores}, esperando ${r.esperando}`, { ...r, modo });
    res.json({
      ...r,
      mensaje: `Cola procesada (${modo}): enviados=${r.enviados}, errores=${r.errores}, esperando=${r.esperando}, previstos=${r.previstos}.`,
    });
  }),
);

colaRouter.post(
  '/:id/procesar',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    // Always 200: { ok, mensaje } describes a normal processing outcome (success
    // or a rejected RNDC send), not an HTTP-level error — the frontend reads
    // `ok`/`mensaje` directly to show the flash message either way.
    const id = Number(req.params.id);
    const r = await cola.procesarItem(id);
    await auditar(db(), actorDe(req), 'cola.procesar', 'cola', id, `Procesó el envío #${id}: ${r.mensaje}`, { ok: r.ok });
    res.json(r);
  }),
);

/**
 * POST /api/cola/:id/cancelar — cancels a row that hasn't been sent to the
 * RNDC yet (estado pendiente/error). Unlike anular, nothing is reported to
 * the Ministry — it's a purely local cleanup.
 */
colaRouter.post(
  '/:id/cancelar',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    res.json(await cola.cancelarItem(Number(req.params.id), actorDe(req)));
  }),
);

colaRouter.get(
  '/:id/xml',
  asyncHandler(async (req, res) => {
    const { found, text } = await cola.xmlDe(Number(req.params.id));
    res.type('text/plain; charset=utf-8').status(found ? 200 : 404).send(text);
  }),
);

/**
 * GET /api/cola/:id/anular — preview de la anulación individual de esta fila
 * ya enviada (una remesa suelta, solo el manifiesto, o solo un cumplido), sin
 * arrastrar el resto de la cascada. Solo lectura, no toca el RNDC.
 */
colaRouter.get(
  '/:id/anular',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    res.json(await cola.previsualizarAnulacionIndividual(Number(req.params.id)));
  }),
);

/** POST /api/cola/:id/anular — encola la anulación individual de esta fila. */
colaRouter.post(
  '/:id/anular',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { motivo, observaciones } = req.body ?? {};
    if (!MOTIVOS_ANULACION.includes(motivo)) {
      throw badRequest('Motivo de anulación inválido.');
    }
    try {
      await withTransaction(async (conn) => {
        await cola.encolarAnulacionIndividual(conn, Number(req.params.id), motivo, String(observaciones ?? ''), req.user!.sub, actorDe(req));
      });
    } catch (e) {
      throw badRequest(e instanceof Error ? e.message : 'No se pudo encolar la anulación.');
    }
    res.json({ ok: true });
  }),
);

// ---- Despachos ----
export const despachoRouter = Router();
despachoRouter.use(requirePagina('despachos'));

despachoRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '');
    const pagina = Math.max(1, Number.parseInt(String(req.query.p ?? '1'), 10) || 1);
    const desde = req.query.desde ? String(req.query.desde) : null;
    const hasta = req.query.hasta ? String(req.query.hasta) : null;
    const porPagina = 10;
    const { items, total } = await cola.listarDespachosConPaginacion(q, pagina, porPagina, desde, hasta);
    res.json({ items, total, pagina, paginas: Math.ceil(total / porPagina) });
  }),
);

/**
 * GET /api/despachos/resumen — count of remesas not yet accepted by the RNDC.
 * Cheap enough to poll from the nav badge on every authenticated page.
 */
despachoRouter.get(
  '/resumen',
  asyncHandler(async (_req, res) => {
    res.json({ pendientes: await cola.contarDespachosPendientes() });
  }),
);

/** GET /api/despachos/:manifiestoId — solicitud + manifiesto + remesas, for editing. */
despachoRouter.get(
  '/:manifiestoId',
  asyncHandler(async (req, res) => {
    const data = await cola.obtenerDespacho(Number(req.params.manifiestoId));
    if (!data) throw notFound('Despacho no encontrado.');
    res.json(data);
  }),
);

/** PUT /api/despachos/:manifiestoId — edit a confirmed despacho, before the RNDC accepts it. */
despachoRouter.put(
  '/:manifiestoId',
  asyncHandler(async (req, res) => {
    res.json(await cola.actualizarDespacho(Number(req.params.manifiestoId), req.body ?? {}, actorDe(req)));
  }),
);

despachoRouter.post(
  '/:manifiestoId/procesar',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    // Always 200 — see the note on POST /cola/:id/procesar above.
    const manifiestoId = Number(req.params.manifiestoId);
    const r = await cola.procesarDespacho(manifiestoId);
    await auditar(db(), actorDe(req), 'cola.procesar', 'manifiesto', manifiestoId, `Procesó el despacho (manifiesto #${manifiestoId}): ${r.mensaje}`, { ok: r.ok });
    res.json(r);
  }),
);

/**
 * POST /api/despachos/:manifiestoId/consultar-qr — (re)fetch the manifiesto's
 * RNDC security QR code. Runs automatically once on acceptance, but the RNDC's
 * consultas server can lag behind the one that just accepted it — exposed here
 * so a failed/delayed lookup can be retried without waiting for a new dispatch.
 */
despachoRouter.post(
  '/:manifiestoId/consultar-qr',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    res.json(await cola.consultarSeguridadQr(Number(req.params.manifiestoId)));
  }),
);

/**
 * GET /api/despachos/:manifiestoId/anular — preview de los pasos que se
 * ejecutarían al anular (solo lectura, no toca el RNDC). Admin-only por
 * consistencia con el resto de la operación de anulación.
 */
despachoRouter.get(
  '/:manifiestoId/anular',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    res.json(await cola.previsualizarAnulacion(Number(req.params.manifiestoId)));
  }),
);

/**
 * POST /api/despachos/:manifiestoId/anular — encola la anulación completa del
 * despacho (cascada 29→28→32→9 según lo que aplique). El envío real al RNDC
 * lo hace el worker/"Procesar", igual que despacho y cumplido.
 */
despachoRouter.post(
  '/:manifiestoId/anular',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const manifiestoId = Number(req.params.manifiestoId);
    const { motivo, observaciones } = req.body ?? {};
    if (!MOTIVOS_ANULACION.includes(motivo)) {
      throw badRequest('Motivo de anulación inválido.');
    }
    try {
      await withTransaction(async (conn) => {
        await cola.encolarAnulacion(conn, manifiestoId, motivo, String(observaciones ?? ''), req.user!.sub, actorDe(req));
      });
    } catch (e) {
      throw badRequest(e instanceof Error ? e.message : 'No se pudo encolar la anulación.');
    }
    res.json({ ok: true });
  }),
);

// ---- Cumplido ----
export const cumplidoRouter = Router();
cumplidoRouter.use(requirePagina('cumplido'));

cumplidoRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(await cola.listarPendientesCumplido());
  }),
);

/**
 * GET /api/cumplido/resumen — count of manifiestos pending cumplido.
 * Cheap enough to poll from the nav badge on every authenticated page.
 */
cumplidoRouter.get(
  '/resumen',
  asyncHandler(async (_req, res) => {
    res.json({ pendientes: await cola.contarPendientesCumplido() });
  }),
);

cumplidoRouter.get(
  '/:manifiestoId',
  asyncHandler(async (req, res) => {
    const manifiestoId = Number(req.params.manifiestoId);
    const [mRows] = await db().query<RowDataPacket[]>('SELECT * FROM manifiesto WHERE id = ?', [manifiestoId]);
    const manifiesto = mRows[0];
    if (!manifiesto) throw notFound('Manifiesto no encontrado.');
    const [sRows] = await db().query<RowDataPacket[]>('SELECT * FROM solicitud_servicio WHERE id = ?', [
      manifiesto.solicitud_id,
    ]);
    const remesas = await cola.obtenerRemesasCumplido(manifiestoId);
    res.json({ manifiesto, solicitud: sRows[0] ?? {}, remesas });
  }),
);

/** POST /api/cumplido/:manifiestoId — save cumplido on manifiesto + remesas, enqueue. */
cumplidoRouter.post(
  '/:manifiestoId',
  asyncHandler(async (req, res) => {
    const manifiestoId = Number(req.params.manifiestoId);
    if (!manifiestoId) throw badRequest('Falta manifiesto_id.');
    const body = req.body ?? {};

    await withTransaction(async (conn) => {
      // Lock the despacho first (same order as the annulment paths) and only
      // accept remesas that actually belong to THIS manifiesto: before, any
      // remesa id in the body was updated and queued, even another dispatch's.
      if (!(await cola.bloquearManifiesto(conn, manifiestoId))) throw notFound('Manifiesto no encontrado.');
      // A dispatch of an internal solicitud never goes to the RNDC, so it has no cumplido there.
      // (Reads the solicitud's flag, not the manifiesto's state: an annulled internal one is 'anulado'.)
      const [[origen]] = await conn.query<RowDataPacket[]>(
        'SELECT s.interna FROM manifiesto m JOIN solicitud_servicio s ON s.id = m.solicitud_id WHERE m.id = ?',
        [manifiestoId],
      );
      if (Number(origen?.interna ?? 0) === 1) {
        throw badRequest('Este despacho es interno: no se envía al RNDC y no tiene cumplido allí.');
      }
      const [propias] = await conn.query<RowDataPacket[]>(
        'SELECT remesa_id FROM manifiesto_remesa WHERE manifiesto_id = ?',
        [manifiestoId],
      );
      const remesasDelManifiesto = new Set((propias as RowDataPacket[]).map((r) => Number(r.remesa_id)));
      for (const rd of Array.isArray(body.remesas) ? body.remesas : []) {
        const rid = Number(rd?.id ?? 0);
        if (rid && !remesasDelManifiesto.has(rid)) {
          throw badRequest(`La remesa #${rid} no pertenece a este manifiesto.`);
        }
      }

      // Save cumplido data on the manifiesto.
      await conn.query(
        `UPDATE manifiesto SET cumplido_tipo = ?, fecha_entrega_documentos = ?,
           valor_adicional_flete = ?, valor_descuento_flete = ?,
           observaciones_cumplido = ?,
           cumplido_estado_rndc = CASE WHEN cumplido_rndc_ingreso_id IS NOT NULL
                                       THEN cumplido_estado_rndc ELSE 'pendiente' END
         WHERE id = ?`,
        [
          body.cumplido_tipo ?? 'C',
          body.fecha_entrega_documentos || null,
          body.valor_adicional_flete ? Number(body.valor_adicional_flete) : 0,
          body.valor_descuento_flete ? Number(body.valor_descuento_flete) : 0,
          body.observaciones_cumplido ?? '',
          manifiestoId,
        ],
      );

      // Save cumplido data on each remesa.
      const remesaIds: number[] = [];
      const rdatos: Record<string, any>[] = Array.isArray(body.remesas) ? body.remesas : [];
      for (const rd of rdatos) {
        const rid = Number(rd.id ?? 0);
        if (!rid) continue;
        remesaIds.push(rid);
        await conn.query(
          `UPDATE remesa SET cumplido_tipo = ?, cantidad_entregada = ?,
             fecha_llegada_descargue = ?, hora_llegada_descargue = ?,
             fecha_entrada_descargue = ?, hora_entrada_descargue = ?,
             fecha_salida_descargue = ?, hora_salida_descargue = ?,
             fecha_llegada_cargue = ?, hora_llegada_cargue = ?,
             fecha_entrada_cargue = ?, hora_entrada_cargue = ?,
             fecha_salida_cargue = ?, hora_salida_cargue = ?,
             cumplido_estado_rndc = CASE WHEN cumplido_rndc_ingreso_id IS NOT NULL
                                         THEN cumplido_estado_rndc ELSE 'pendiente' END
           WHERE id = ?`,
          [
            rd.cumplido_tipo ?? 'C',
            rd.cantidad_entregada ? Number(rd.cantidad_entregada) : null,
            rd.fecha_llegada_descargue || null,
            rd.hora_llegada_descargue ?? null,
            rd.fecha_entrada_descargue || null,
            rd.hora_entrada_descargue ?? null,
            rd.fecha_salida_descargue || null,
            rd.hora_salida_descargue ?? null,
            rd.fecha_llegada_cargue || null,
            rd.hora_llegada_cargue ?? null,
            rd.fecha_entrada_cargue || null,
            rd.hora_entrada_cargue ?? null,
            rd.fecha_salida_cargue || null,
            rd.hora_salida_cargue ?? null,
            rid,
          ],
        );
      }

      // Enqueue cumplidos.
      const [manifRows] = await conn.query<RowDataPacket[]>('SELECT solicitud_id FROM manifiesto WHERE id = ?', [
        manifiestoId,
      ]);
      const sId = Number(manifRows[0]?.solicitud_id ?? 0);
      // A viaje urbano has no remesa cumplido to send: its manifiesto cumplido is queued on its own.
      const urbano = sId > 0 && (await cola.solicitudEsUrbana(conn, sId));
      if (sId > 0 && (remesaIds.length > 0 || urbano)) {
        await cola.encolarCumplido(conn, sId, manifiestoId, remesaIds);
      }
      await auditar(conn, actorDe(req), 'cumplido.guardar', 'manifiesto', manifiestoId,
        `Guardó el cumplido del manifiesto #${manifiestoId} (${remesaIds.length} remesa(s))`, {
          cumplido_tipo: body.cumplido_tipo ?? 'C', valor_adicional_flete: body.valor_adicional_flete ?? null,
          valor_descuento_flete: body.valor_descuento_flete ?? null, remesas: remesaIds,
        });
    });

    res.json({ ok: true });
  }),
);
