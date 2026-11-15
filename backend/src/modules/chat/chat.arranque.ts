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
  // eslint-disable-next-line no-console
  console[aparte ? 'log' : 'warn'](
    aparte
      ? '[chat] Usa un usuario de BD de solo lectura distinto del principal.'
      : '[chat] ATENCIÓN: no hay DB_READONLY_USER distinto de DB_USER; protegen las herramientas tipadas y la sesión en solo lectura, pero conviene crear el usuario de solo lectura (docs/SOPORTE.md).',
  );
}
