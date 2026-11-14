-- migracion_v53_solicitud_interna.sql
-- Solicitudes "Internas": viajes que se manejan en el sistema pero NINGÚN
-- documento viaja al RNDC (ni terceros, vehículo, remesa, manifiesto, cumplido
-- ni anulaciones).
--
-- Qué agrega:
--   - solicitud_servicio.interna: la marca. Es la ÚNICA fuente de verdad de
--     "no enviar"; el código la revisa donde se encolan y se envían los
--     documentos. No se puede cambiar una vez que la solicitud tiene despachos.
--   - 'interno' como estado_rndc de manifiesto y remesa (los documentos de un
--     despacho interno nunca pasan por pendiente/enviado/aceptado). Mismo
--     ENUM de migracion_v44 + el valor nuevo. IMPORTANTE: esta migración debe
--     correrse ANTES de desplegar el código que escribe 'interno'; sin ella,
--     en una base sin modo estricto el valor se guardaría como '' (el error de v44).
--   - Serie propia de numeración para los documentos internos (INT-M-00001 /
--     INT-R-00001), así la serie oficial MAN-/REM- que se reporta al RNDC no
--     tiene huecos. Viven en la misma fila de maestro_empresa y reutilizan su
--     bloqueo.
--
-- ANTES DE CORRERLA (en cada base), revisa que no haya estados fuera de la lista:
--     SELECT estado_rndc, COUNT(*) FROM manifiesto GROUP BY estado_rndc;
--     SELECT estado_rndc, COUNT(*) FROM remesa GROUP BY estado_rndc;
-- Solo deben aparecer: pendiente, enviado, aceptado, rechazado,
-- anulacion_pendiente, anulado. Un valor vacío ('') o desconocido (resto del
-- error que corrigió v44) haría fallar el cambio de ENUM en modo estricto.
--
-- Repetible: ADD COLUMN IF NOT EXISTS y MODIFY a la misma definición.

ALTER TABLE solicitud_servicio
  ADD COLUMN IF NOT EXISTS interna TINYINT(1) NOT NULL DEFAULT 0
  COMMENT '1 = solicitud interna: ningún documento se envía al RNDC. Fija una vez despachada';

ALTER TABLE manifiesto
  MODIFY COLUMN estado_rndc ENUM('pendiente','enviado','aceptado','rechazado','anulacion_pendiente','anulado','interno') NOT NULL DEFAULT 'pendiente';

ALTER TABLE remesa
  MODIFY COLUMN estado_rndc ENUM('pendiente','enviado','aceptado','rechazado','anulacion_pendiente','anulado','interno') NOT NULL DEFAULT 'pendiente';

ALTER TABLE maestro_empresa
  ADD COLUMN IF NOT EXISTS consecutivo_interno_manifiesto VARCHAR(20) NOT NULL DEFAULT 'INT-M-00000' COMMENT 'Último consecutivo de manifiesto INTERNO (no RNDC)',
  ADD COLUMN IF NOT EXISTS consecutivo_interno_remesa VARCHAR(20) NOT NULL DEFAULT 'INT-R-00000' COMMENT 'Último consecutivo de remesa INTERNA (no RNDC)';
