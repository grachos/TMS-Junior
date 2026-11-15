/**
 * Light TMS - Autorización del PROPIETARIO (con base de datos).
 *
 * `requirePlatformOwner` es independiente de roles (`admin`/`operador`), de `requireAccion`, de
 * `canAccess` y de cualquier claim del token: después de autenticar, el SERVIDOR relee la cuenta
 * (sin la caché de 30 s de requireAuth) y exige a la vez:
 *   1. cuenta activa,
 *   2. uuid persistido igual al PLATFORM_OWNER_UUID configurado y válido,
 *   3. sesión vigente (la versión del token coincide con la de la cuenta).
 * Cualquier otra cosa (incluida configuración ausente o inválida, o la columna sin migrar) → 403.
 * Nunca se concede acceso a "cualquier administrador" como alternativa.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { RowDataPacket } from 'mysql2';
import { db } from '../../db/pool.js';
import { forbidden, unauthorized } from '../../http/errors.js';
import { avisarUnaVez, coincidePropietario, vinculoPropietario } from './propietario.js';

export async function esPropietario(userId: number, sesionVersionToken: number): Promise<boolean> {
  const v = vinculoPropietario();
  if (!v.ok) {
    avisarUnaVez(
      `vinculo:${v.motivo}`,
      v.motivo === 'no_configurado'
        ? 'PLATFORM_OWNER_UUID no está configurado: el módulo de soporte queda DENEGADO para todos.'
        : 'PLATFORM_OWNER_UUID no es un UUID válido: el módulo de soporte queda DENEGADO para todos.',
    );
    return false;
  }
  let fila: RowDataPacket | undefined;
  try {
    const [rows] = await db().query<RowDataPacket[]>(
      'SELECT uuid, activo, sesion_version FROM staff_users WHERE id = ? LIMIT 1', [userId]);
    fila = rows[0];
  } catch (e) {
    // Sin migracion_v57 (columna uuid) no hay identidad que verificar: se deniega.
    const code = (e as { code?: string }).code;
    if (code === 'ER_BAD_FIELD_ERROR' || code === 'ER_NO_SUCH_TABLE') {
      avisarUnaVez('sin-v57', 'Falta la migración v57 (staff_users.uuid): el módulo de soporte queda DENEGADO.');
      return false;
    }
    throw e;
  }
  if (!fila || Number(fila.activo) !== 1) return false;
  if (!coincidePropietario(String(fila.uuid ?? ''))) return false;
  return Number(fila.sesion_version ?? 0) === Number(sesionVersionToken ?? 0);
}

/** Va DESPUÉS de requireAuth. Todo endpoint privado de soporte pasa por aquí. */
export const requirePlatformOwner: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  if (!req.user) return next(unauthorized());
  esPropietario(req.user.sub, req.user.sv ?? 0).then(
    (ok) => (ok ? next() : next(forbidden('Acceso restringido.'))),
    next,
  );
};

/** Capacidad que ve la interfaz (solo para mostrar el menú; el servidor vuelve a decidir en cada petición). */
export async function capacidadesDe(userId: number, sesionVersionToken: number): Promise<{ supportOwner: boolean }> {
  return { supportOwner: await esPropietario(userId, sesionVersionToken) };
}

/** Al arrancar: informa en el log si el vínculo del propietario es válido (sin imprimir el uuid). */
export async function verificarPropietarioAlArrancar(): Promise<void> {
  const v = vinculoPropietario();
  if (!v.ok) {
    // eslint-disable-next-line no-console
    console.error(
      v.motivo === 'no_configurado'
        ? '[soporte] PLATFORM_OWNER_UUID no está configurado: el módulo de soporte permanece DENEGADO.'
        : '[soporte] PLATFORM_OWNER_UUID no es un UUID válido: el módulo de soporte permanece DENEGADO.',
    );
    return;
  }
  try {
    const [rows] = await db().query<RowDataPacket[]>('SELECT activo FROM staff_users WHERE uuid = ?', [v.uuid]);
    const activas = rows.filter((r) => Number(r.activo) === 1).length;
    // eslint-disable-next-line no-console
    if (activas === 1) console.log('[soporte] Propietario vinculado: exactamente una cuenta activa coincide.');
    // eslint-disable-next-line no-console
    else console.error(`[soporte] PLATFORM_OWNER_UUID no corresponde a UNA cuenta activa (coinciden ${activas}): soporte DENEGADO.`);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[soporte] No se pudo verificar el propietario (¿falta migracion_v57?):', (e as Error).message);
  }
}
