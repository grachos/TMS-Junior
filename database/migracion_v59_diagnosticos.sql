-- migracion_v59_diagnosticos.sql
-- Soporte, fase 3b: diagnósticos de incidentes (por reglas, sin IA).
--
--   incidente_diagnosticos: un diagnóstico por ejecución (se conservan los últimos 5 por incidente). Guarda la categoría, la
--     confianza (que decide el código, nunca un modelo), si un cambio de código podría resolverlo, los hechos técnicos con su fuente y
--     la hora en que se observaron (solo para el propietario), la versión de las reglas y la versión desplegada. `aplicado_en` marca
--     cuándo el propietario usó el borrador público.
--
-- Repetible: solo CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS incidente_diagnosticos (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  incidente_id BIGINT NOT NULL,
  version_reglas VARCHAR(10) NOT NULL,
  version_despliegue VARCHAR(64) NULL,
  categoria VARCHAR(20) NOT NULL,
  confianza VARCHAR(12) NOT NULL,
  corregible_con_codigo TINYINT(1) NULL,
  resumen VARCHAR(400) NOT NULL,
  posible_causa TEXT NULL,
  causa_confirmada TEXT NULL,
  accion_temporal TEXT NULL,
  siguiente_paso TEXT NULL,
  hechos MEDIUMTEXT NULL,
  referencias TEXT NULL,
  origen VARCHAR(12) NOT NULL DEFAULT 'reglas',
  aplicado_en DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_incidente_diagnosticos (incidente_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
