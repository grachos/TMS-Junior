-- migracion_v60_explicaciones_ia.sql
-- Soporte, fase 3c: explicaciones con IA (solo borrador, solo para el propietario).
--
--   incidente_explicaciones_ia: texto que redactó el modelo a partir del diagnóstico por reglas y de evidencia SANITIZADA. Nunca se
--     publica solo ni cambia la confianza, el estado o `corregible`. Se guarda el modelo y la versión desplegada. Se conservan las últimas 5.
--
-- Repetible: solo CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS incidente_explicaciones_ia (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  incidente_id BIGINT NOT NULL,
  diagnostico_id BIGINT NULL,
  modelo VARCHAR(80) NOT NULL,
  version_despliegue VARCHAR(64) NULL,
  texto TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_incidente_explicaciones_ia (incidente_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
