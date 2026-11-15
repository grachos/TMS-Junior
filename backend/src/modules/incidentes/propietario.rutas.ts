/**
 * Light TMS - Consola de incidentes (PRIVADA del propietario). Estas rutas se registran sobre `soporteRouter`, cuya primera
 * capa es requirePlatformOwner: otro administrador u operador recibe 403 antes de leer nada.
 */

import type { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, badRequest, notFound } from '../../http/errors.js';
import { db } from '../../db/pool.js';
import { actorDe, auditar } from '../auditoria/auditoria.repo.js';
import { avisarUsuarios } from './notificar.js';
import { TIPOS_INCIDENTE } from './clasificar.js';
import {
  ESTADOS, ETIQUETAS_PUBLICAS, SEVERIDADES, mensajePublicoDeEstado, propietarioActualizar, propietarioDetalle, propietarioListar,
  propietarioPublicarMensaje, usuariosDeReportes,
} from './incidentes.repo.js';

const idDe = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw notFound('Incidente no encontrado.');
  return n;
};

const texto1000 = z.string().max(1000).nullable().optional();
const patchSchema = z.object({
  estado: z.enum(ESTADOS).optional(),
  severidad: z.enum(SEVERIDADES).optional(),
  tipo: z.enum(TIPOS_INCIDENTE as unknown as [string, ...string[]]).optional(),
  corregible: z.boolean().optional(),
  explicacion: z.object({ hecho: texto1000, posibleCausa: texto1000, causaConfirmada: texto1000, accionTemporal: texto1000, estadoCorreccion: texto1000 }).strict().optional(),
  /** Avisar a quienes reportaron SOLO si el estado cambió y quedó guardado. */
  notificar: z.boolean().optional(),
}).strict();

const mensajeSchema = z.object({
  visibilidad: z.enum(['interno', 'publico']),
  texto: z.string().trim().min(1).max(1000),
  reporteId: z.number().int().positive().optional(),
}).strict();

export function registrarRutasIncidentes(router: Router): void {
  router.get(
    '/incidentes',
    asyncHandler(async (req, res) => {
      const q = z.object({ estado: z.string().max(24).optional(), tipo: z.string().max(20).optional(), sitio: z.string().max(80).optional(), q: z.string().max(100).optional() }).safeParse(req.query);
      if (!q.success) throw badRequest('Filtros inválidos.');
      res.json({ items: await propietarioListar(q.data) });
    }),
  );

  router.get(
    '/incidentes/:id',
    asyncHandler(async (req, res) => {
      const d = await propietarioDetalle(idDe(req.params.id));
      if (!d) throw notFound('Incidente no encontrado.');
      res.json(d);
    }),
  );

  router.patch(
    '/incidentes/:id',
    asyncHandler(async (req, res) => {
      const id = idDe(req.params.id);
      const p = patchSchema.safeParse(req.body);
      if (!p.success) throw badRequest(p.error.issues[0]?.message ?? 'Datos inválidos.');
      const { notificar, ...cambios } = p.data;
      const r = await propietarioActualizar(id, cambios, req.user!.sub);
      if (!r) throw notFound('Incidente no encontrado.');
      await auditar(db(), actorDe(req), 'incidente.actualizar', 'incidente', id, `Incidente #${id}: ${r.estadoAntes} → ${r.estadoAhora}`, { campos: Object.keys(cambios) });
      // El aviso al usuario sale DESPUÉS de que el cambio quedó guardado y con el estado RELEÍDO de la base (no el pedido).
      let avisados = 0;
      if (notificar && r.estadoAhora !== r.estadoAntes) {
        const etiqueta = ETIQUETAS_PUBLICAS[r.estadoAhora];
        const reportes = await mensajePublicoDeEstado(id, etiqueta);
        const usuarios = await usuariosDeReportes(id, reportes);
        await avisarUsuarios(usuarios, { title: 'Tu reporte tiene novedades', body: etiqueta, url: '/', tag: `reporte-${id}` });
        avisados = usuarios.length;
      }
      res.json({ ok: true, estado: r.estadoAhora, avisados });
    }),
  );

  router.post(
    '/incidentes/:id/mensajes',
    asyncHandler(async (req, res) => {
      const id = idDe(req.params.id);
      const m = mensajeSchema.safeParse(req.body);
      if (!m.success) throw badRequest(m.error.issues[0]?.message ?? 'Datos inválidos.');
      const r = await propietarioPublicarMensaje(id, m.data.visibilidad, m.data.texto, req.user!.sub, m.data.reporteId);
      if (!r) throw notFound('Incidente no encontrado.');
      // Las notas internas NUNCA notifican a nadie; un mensaje público solo avisa a los dueños de los reportes destinatarios.
      if (m.data.visibilidad === 'publico' && r.reporteIds.length) {
        await avisarUsuarios(await usuariosDeReportes(id, r.reporteIds), { title: 'Tu reporte tiene novedades', body: 'Hay un mensaje nuevo del equipo técnico.', url: '/', tag: `reporte-${id}` });
      }
      res.status(201).json({ ok: true, destinatarios: r.reporteIds.length });
    }),
  );
}
