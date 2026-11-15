/**
 * Light TMS - Identificador de correlación por petición.
 *
 * El navegador manda X-Request-Id (si es válido se conserva); si no, se genera uno. Se devuelve en la cabecera de la
 * respuesta y dentro de los errores JSON (campo extra `requestId`: las respuestas actuales siguen siendo compatibles).
 * Así un error visto en pantalla se puede correlacionar con el incidente del servidor.
 */

import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const VALIDO = /^[A-Za-z0-9_-]{8,64}$/;

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const entrante = req.get('x-request-id');
  const id = entrante && VALIDO.test(entrante) ? entrante : randomUUID();
  res.locals.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}
