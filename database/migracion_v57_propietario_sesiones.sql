-- migracion_v57_propietario_sesiones.sql
-- Identidad estable de cada cuenta y revocación de sesiones. Base del "propietario único" del
-- módulo de soporte.
--
--   staff_users.uuid: identificador ÚNICO e INMUTABLE de la cuenta, generado por la base. Nunca
--     se escribe desde la aplicación. El propietario del módulo de soporte se vincula con
--     PLATFORM_OWNER_UUID (variable de entorno del servidor), no con el correo, el id ni el rol.
--   staff_users.sesion_version: sube cuando hay que invalidar TODAS las sesiones abiertas de la
--     cuenta (cambio de contraseña, recuperación, cierre forzado). El token lleva la versión con
--     la que se emitió; si ya no coincide, deja de valer.
--
-- REQUIERE MariaDB 10.2 o superior (valor por defecto con expresión). Antes de correrla:
--     SELECT VERSION();
-- Repetible: ADD COLUMN IF NOT EXISTS, el UPDATE solo toca filas sin uuid y MODIFY/INDEX son idempotentes.

ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS uuid CHAR(36) NULL AFTER id;

-- Un UUID() por FILA (no uno para todas): evaluado por registro.
UPDATE staff_users SET uuid = UUID() WHERE uuid IS NULL OR uuid = '';

-- Desde aquí toda cuenta nueva (aunque se inserte sin esta columna) recibe su uuid de la base.
ALTER TABLE staff_users MODIFY COLUMN uuid CHAR(36) NOT NULL DEFAULT (UUID());

CREATE UNIQUE INDEX IF NOT EXISTS uq_staff_users_uuid ON staff_users (uuid);

ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS sesion_version INT NOT NULL DEFAULT 0;
