-- migracion_v61_issue_incidente.sql
-- Soporte, fase 4: vínculo entre un incidente y su issue de GitHub (para el agente de corrección).
--
--   issue_reservado_en: se marca con un UPDATE condicional ANTES de llamar a GitHub, así un doble clic o dos pestañas crean un solo issue.
--   issue_numero / issue_url: el issue creado. Un incidente tiene a lo sumo uno.
--
-- Repetible: ADD COLUMN IF NOT EXISTS.

ALTER TABLE incidentes
  ADD COLUMN IF NOT EXISTS issue_reservado_en DATETIME NULL,
  ADD COLUMN IF NOT EXISTS issue_numero INT NULL,
  ADD COLUMN IF NOT EXISTS issue_url VARCHAR(255) NULL;
