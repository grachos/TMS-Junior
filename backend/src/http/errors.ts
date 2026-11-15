/**
 * Light TMS - HTTP error + async-handler helpers.
 *
 * The PHP front controller wrapped every route in try/catch and rendered a
 * generic error (with detail only when APP_DEBUG). We reproduce that with an
 * AppError type, an asyncHandler wrapper, and a central error middleware.
 */

import type { NextFunction, Request, Response, RequestHandler } from 'express';
import { config } from '../config/env.js';
import { capturarErrorServidor } from '../modules/incidentes/captura.js';

/** An error carrying an HTTP status code and a user-safe message. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly expose = true,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (msg: string) => new AppError(400, msg);
export const unauthorized = (msg = 'No autenticado.') => new AppError(401, msg);
export const forbidden = (msg = 'No autorizado.') => new AppError(403, msg);
export const notFound = (msg = 'No encontrado.') => new AppError(404, msg);
export const conflict = (msg: string) => new AppError(409, msg);

/** Wraps an async route handler so rejected promises reach the error middleware. */
export function asyncHandler(fn: RequestHandler): RequestHandler {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/** Central error middleware. Mirrors the PHP catch: generic message + optional detail. */
export function errorMiddleware(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const debug = config().app.debug;
  const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined;
  /** Registra el fallo como incidente DESPUÉS de responder y sin poder afectar la respuesta (solo 5xx). */
  const capturar = (status: number) => {
    if (status >= 500) void capturarErrorServidor({ err, status, metodo: req.method, ruta: req.originalUrl, requestId, usuarioId: req.user?.sub ?? null });
  };
  if (err instanceof AppError) {
    res.status(err.status).json({
      error: err.expose ? err.message : 'Ocurrió un error.',
      ...(debug && !err.expose ? { detail: err.message } : {}),
      ...(requestId ? { requestId } : {}),
    });
    capturar(err.status);
    return;
  }
  // A UNIQUE key rejected the write (e.g. a repeated manifiesto/remesa number,
  // migracion_v47): nothing was saved, so tell the user to retry instead of a
  // bare 500. Still logged — it means a guard upstream let a duplicate through.
  if ((err as { code?: string } | null)?.code === 'ER_DUP_ENTRY') {
    // eslint-disable-next-line no-console
    console.error('[error] ER_DUP_ENTRY', err instanceof Error ? err.message : err);
    res.status(409).json({ error: 'Ya existe un registro con ese número. No se guardó nada; intenta de nuevo.', ...(requestId ? { requestId } : {}) });
    return;
  }
  // A column/table the code expects is missing: the database is behind the code
  // (a migration was not run on THIS database). Say so instead of a bare 500.
  const code = (err as { code?: string } | null)?.code;
  if (code === 'ER_BAD_FIELD_ERROR' || code === 'ER_NO_SUCH_TABLE') {
    // eslint-disable-next-line no-console
    console.error(`[error] ${code}: la base de datos no está al día`, err instanceof Error ? err.message : err);
    res.status(500).json({
      error: 'La base de datos de este sitio no está al día: falta correr una migración. Avisa al responsable técnico.',
      ...(debug ? { detail: err instanceof Error ? err.message : String(err) } : {}),
      ...(requestId ? { requestId } : {}),
    });
    capturar(500);
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error('[error]', message, err);
  res.status(500).json({
    error: 'Ocurrió un error.',
    ...(debug ? { detail: message } : {}),
    ...(requestId ? { requestId } : {}),
  });
  capturar(500);
}
