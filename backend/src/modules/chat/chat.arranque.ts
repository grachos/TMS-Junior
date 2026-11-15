import { config } from '../../config/env.js';

/**
 * Al arrancar: si el chat está habilitado, informa si usa un usuario de BD de solo lectura DISTINTO del principal.
 * (No imprime credenciales.) Sin usuario aparte, la protección es: herramientas tipadas + sesión en SOLO LECTURA; lo ideal
 * es además un usuario con SELECT solo sobre las tablas del registro (ver docs/SOPORTE.md).
 */
export function verificarChatAlArrancar(): void {
  const c = config();
  if (!c.chat.habilitado || c.chat.apiKey === '') return;
  const aparte = c.dbReadonly.user !== c.db.user;
  // Riesgo aceptado de forma EXPLÍCITA: en Hostinger compartido no se puede crear el usuario (CREATE USER → error 1227).
  const aceptado = ['true', '1', 'yes'].includes((process.env.DB_READONLY_ACEPTADO ?? '').toLowerCase());
  const [nivel, mensaje] = aparte
    ? ['log', '[chat] Usa un usuario de BD de solo lectura distinto del principal.']
    : aceptado
      ? ['log', '[chat] Sin usuario de BD de solo lectura aparte (riesgo aceptado: el hosting no permite crearlo). Protegen las herramientas tipadas y la sesión en SOLO LECTURA.']
      : ['warn', '[chat] ATENCIÓN: no hay DB_READONLY_USER distinto de DB_USER. Protegen las herramientas tipadas y la sesión en solo lectura; si tu hosting no permite crear el usuario, pon DB_READONLY_ACEPTADO=true (docs/SOPORTE.md).'];
  // eslint-disable-next-line no-console
  console[nivel as 'log' | 'warn'](mensaje);
}
