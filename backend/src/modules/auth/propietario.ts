/**
 * Light TMS - Identidad del PROPIETARIO de la plataforma (módulo de soporte y mantenimiento).
 *
 * El propietario es UNA cuenta, vinculada por el uuid estable e inmutable de `staff_users.uuid`
 * (migracion_v57) con la variable de entorno del servidor PLATFORM_OWNER_UUID. NO depende del
 * correo (editable), del id, de ser el primer administrador, de ningún rol ni de nada que envíe
 * el navegador. Nadie puede asignarse esa propiedad desde la aplicación.
 *
 * Aquí solo hay funciones PURAS (sin base de datos): leen la variable en cada llamada (así un
 * cambio de configuración surte efecto y las pruebas pueden variarla) y comparan en tiempo constante.
 */

import { timingSafeEqual } from 'node:crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type Vinculo = { ok: true; uuid: string } | { ok: false; motivo: 'no_configurado' | 'invalido' };

/** Lee y valida PLATFORM_OWNER_UUID. Sin configuración válida NO hay propietario (se deniega todo). */
export function vinculoPropietario(env: NodeJS.ProcessEnv = process.env): Vinculo {
  const crudo = (env.PLATFORM_OWNER_UUID ?? '').trim().toLowerCase();
  if (!crudo) return { ok: false, motivo: 'no_configurado' };
  if (!UUID_RE.test(crudo)) return { ok: false, motivo: 'invalido' };
  return { ok: true, uuid: crudo };
}

/** ¿Este uuid de cuenta es el del propietario configurado? */
export function coincidePropietario(uuid: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const v = vinculoPropietario(env);
  if (!v.ok || typeof uuid !== 'string') return false;
  const a = Buffer.from(uuid.trim().toLowerCase());
  const b = Buffer.from(v.uuid);
  return a.length === b.length && timingSafeEqual(a, b);
}

const avisados = new Set<string>();
/** Registra un problema de configuración UNA vez por proceso (sin repetir en cada petición). */
export function avisarUnaVez(clave: string, mensaje: string): void {
  if (avisados.has(clave)) return;
  avisados.add(clave);
  // eslint-disable-next-line no-console
  console.error(`[soporte] ${mensaje}`);
}
/** Solo para pruebas. */
export function olvidarAvisos(): void {
  avisados.clear();
}
