/**
 * El chatbot ejecuta SELECTs generados por el modelo. En producción no hay
 * usuario de BD de solo lectura (DB_READONLY_USER no está configurado), así que
 * validarSelect() es la barrera real: debe bloquear las tablas sensibles aunque
 * la consulta no nombre ninguna columna sensible (p.ej. SELECT *).
 */
import { describe, expect, it } from 'vitest';
import { validarSelect } from '../src/modules/chat/chat.repo.js';

describe('chatbot: tablas sensibles bloqueadas', () => {
  it.each([
    'SELECT * FROM maestro_empresa',
    'select nit, rndc_password from maestro_empresa',
    'SELECT * FROM `maestro_empresa`',
    'SELECT * FROM light_tms.maestro_empresa',
    'SELECT * FROM staff_users',
    'SELECT * FROM `staff_users`',
    'SELECT email FROM login_intentos',
    'SELECT * FROM auditoria',
    'SELECT * FROM push_subscriptions',
    'SELECT m.id FROM manifiesto m JOIN maestro_empresa e ON 1=1',
    'WITH x AS (SELECT * FROM maestro_empresa) SELECT * FROM x',
  ])('bloquea: %s', (sql) => {
    expect(validarSelect(sql).ok).toBe(false);
  });

  it.each([
    'SELECT COUNT(*) FROM manifiesto',
    "SELECT estado, COUNT(*) FROM cola_envios GROUP BY estado",
    'SELECT nombre FROM tercero WHERE es_conductor = 1',
  ])('permite: %s', (sql) => {
    expect(validarSelect(sql).ok).toBe(true);
  });
});
