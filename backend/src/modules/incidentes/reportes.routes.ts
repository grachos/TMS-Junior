/**
 * Light TMS - Reportes de problemas de los USUARIOS (cualquier usuario autenticado, incluidos operadores y administradores).
 *
 *   POST /api/reportes            registra un reporte (NO depende del chat de IA: funciona aunque OpenRouter esté caído o apagado)
 *   GET  /api/reportes            mis reportes
 *   GET  /api/reportes/:id        un reporte MÍO (de otro usuario, incluso de un admin: 404)
 *   POST /api/reportes/telemetria errores capturados por el navegador (autenticado, con tope por usuario)
 *
 * Esto está separado del módulo privado: aquí SOLO sale la vista pública (lista blanca de campos): nunca evidencias,
 * pilas, notas internas, configuración ni datos de otros usuarios.
 */

import { Router } from 'express';
import { z } from 'zod';
import { AppError, asyncHandler, badRequest, notFound } from '../../http/errors.js';
import { diagnosticarEnSegundoPlano } from '../diagnostico/servicio.js';
import { avisarPropietario } from './notificar.js';
import {
  crearReporte, incidentePorRequestId, registrarOcurrencia, reportesRecientesDe, telemetriaRecienteDe, vistaErrorConocido, vistaMiReporte, vistaMisReportes,
} from './incidentes.repo.js';
import { huella, normalizarRuta, sanitizarPila, sanitizarTexto } from './sanitizar.js';
import { sitioId, versionDespliegue } from './version.js';

export const reportesRouter = Router();

const ID_PETICION = /^[A-Za-z0-9_-]{8,64}$/;
const TOPE_REPORTES = { cantidad: 5, minutos: 10 };
const TOPE_TELEMETRIA = { cantidad: 10, minutos: 1 };

const reporteSchema = z.object({
  texto: z.string().trim().min(5, 'Cuéntanos qué pasó (mínimo 5 caracteres).').max(1000),
  pantalla: z.string().trim().max(200).optional(),
  requestId: z.string().regex(ID_PETICION).optional(),
}).strict();

reportesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = reporteSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Datos inválidos.');
    const usuarioId = req.user!.sub;
    if ((await reportesRecientesDe(usuarioId, TOPE_REPORTES.minutos)) >= TOPE_REPORTES.cantidad) {
      throw new AppError(429, 'Ya enviaste varios reportes seguidos. Espera unos minutos; el equipo los está revisando.');
    }
    const { texto, pantalla, requestId } = parsed.data;
    // El texto del usuario también se sanitiza: la gente pega contraseñas y tokens en las descripciones.
    const limpio = sanitizarTexto(texto, 1000);
    const pantallaLimpia = pantalla ? normalizarRuta(pantalla) : null;

    // Si el reporte trae el X-Request-Id de un error real del servidor, se ata a ESE incidente.
    let incidenteId = requestId ? await incidentePorRequestId(requestId) : null;
    let nuevo = false;
    if (incidenteId === null) {
      const sitio = sitioId();
      const r = await registrarOcurrencia({
        sitio, huella: huella({ sitio, tipo: 'otro', operacion: pantallaLimpia ?? '', codigo: 'reporte_usuario', mensaje: '' }), tipo: 'otro', origen: 'usuario',
        severidad: 'media', corregible: true, titulo: `Reporte en ${pantallaLimpia ?? 'la aplicación'}`, operacion: pantallaLimpia, codigo: 'reporte_usuario', version: versionDespliegue(),
      });
      incidenteId = r.id;
      nuevo = r.nuevo;
      if (r.nuevo || r.reabierto) void diagnosticarEnSegundoPlano(r.id);
    }
    const id = await crearReporte({ incidenteId, usuarioId, texto: limpio, pantalla: pantallaLimpia, requestId: requestId ?? null });
    void avisarPropietario({ title: nuevo ? 'Nuevo incidente reportado' : 'Nuevo reporte de usuario', body: pantallaLimpia ?? 'Aplicación', url: '/soporte', tag: `incidente-${incidenteId}` });
    const vista = await vistaMiReporte(usuarioId, id);
    res.status(201).json(vista);
  }),
);

reportesRouter.get('/', asyncHandler(async (req, res) => { res.json(await vistaMisReportes(req.user!.sub)); }));

const telemetriaSchema = z.object({
  tipo: z.enum(['error_js', 'react', 'http_5xx']),
  mensaje: z.string().max(500),
  ruta: z.string().max(300).optional(),
  pila: z.string().max(4000).optional(),
  requestId: z.string().regex(ID_PETICION).optional(),
}).strict();

reportesRouter.post(
  '/telemetria',
  asyncHandler(async (req, res) => {
    const parsed = telemetriaSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('Datos inválidos.');
    const usuarioId = req.user!.sub;
    // Tope por usuario, contado en la base (no en memoria).
    if ((await telemetriaRecienteDe(usuarioId, TOPE_TELEMETRIA.minutos)) >= TOPE_TELEMETRIA.cantidad) throw new AppError(429, 'Demasiados avisos.');
    const t = parsed.data;
    // Un fallo HTTP que el servidor ya capturó (mismo X-Request-Id) no se duplica.
    if (t.requestId && (await incidentePorRequestId(t.requestId)) !== null) { res.status(204).end(); return; }
    const sitio = sitioId();
    const ruta = normalizarRuta(t.ruta ?? '');
    const mensaje = sanitizarTexto(t.mensaje, 300);
    const operacion = `navegador ${ruta}`;
    await registrarOcurrencia({
      sitio, huella: huella({ sitio, tipo: 'codigo', operacion, codigo: t.tipo, mensaje }), tipo: 'codigo', origen: 'navegador', severidad: 'media', corregible: true,
      titulo: `${operacion}: ${mensaje || t.tipo}`.slice(0, 200), operacion, codigo: t.tipo, version: versionDespliegue(),
      evidencia: { tipo: 'cliente', contenido: JSON.stringify({ tipo: t.tipo, ruta, mensaje, pila: t.pila ? sanitizarPila(t.pila) : '' }), usuarioId, requestId: t.requestId ?? null },
    });
    res.status(204).end();
  }),
);

/** ¿Mi último error ya está registrado? Siempre 200: `conocido:false` también si el código es de otro usuario o no existe. */
reportesRouter.get(
  '/error/:requestId',
  asyncHandler(async (req, res) => {
    const rid = String(req.params.requestId ?? '');
    const v = /^[\w-]{1,64}$/.test(rid) ? await vistaErrorConocido(req.user!.sub, rid) : null;
    res.json(v ? { conocido: true, ...v } : { conocido: false });
  }),
);

reportesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const v = Number.isInteger(id) && id > 0 ? await vistaMiReporte(req.user!.sub, id) : null;
    if (!v) throw notFound('Reporte no encontrado.'); // ajeno o inexistente: 404, no 403 (no revela que existe)
    res.json(v);
  }),
);
