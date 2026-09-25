-- migracion_v46_contenedor_serial.sql
-- El RNDC exige <CONTENEDORSERIAL> en la Remesa (procesoid 3) cuando la
-- operación de transporte es Contenedor Cargado (C) o Contenedor Vacío (V) —
-- serial de 11 caracteres (ISO 6346, p.ej. "SMLU7924873"). Se captura una vez
-- en la solicitud (igual que dueno_poliza) y se copia a cada remesa sembrada.

ALTER TABLE solicitud_servicio
  ADD COLUMN IF NOT EXISTS contenedor_serial VARCHAR(11) NULL COMMENT '[CONTENEDORSERIAL] ISO 6346, requerido si operacion_transporte es C o V' AFTER operacion_transporte;

ALTER TABLE remesa
  ADD COLUMN IF NOT EXISTS contenedor_serial VARCHAR(11) NULL COMMENT '[CONTENEDORSERIAL]' AFTER operacion_transporte;
