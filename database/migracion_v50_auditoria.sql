-- migracion_v50_auditoria.sql
-- Bitácora de auditoría: quién hizo qué, cuándo, desde qué IP, y el valor
-- anterior/nuevo de lo que cambió.
--
-- Por qué: no había forma de responder "¿quién anuló este manifiesto?",
-- "¿quién le quitó el rol de admin a X?" o "¿quién cambió los datos de la
-- empresa?". Cada operación sensible escribe aquí DENTRO de su misma
-- transacción: si la operación se revierte, su registro también; nunca queda
-- un registro de algo que no pasó.
--
-- Nunca se guardan contraseñas: de un cambio de clave solo queda "cambió".
--
-- Repetible: CREATE TABLE IF NOT EXISTS. Si esta migración no se ha corrido,
-- las operaciones siguen funcionando (sin registro) y el log lo avisa.

CREATE TABLE IF NOT EXISTS auditoria (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  usuario_id BIGINT UNSIGNED NULL COMMENT 'staff_users.id (NULL = proceso automático)',
  usuario_email VARCHAR(190) NULL COMMENT 'copia del correo al momento de la acción',
  ip VARCHAR(45) NULL,
  accion VARCHAR(40) NOT NULL COMMENT 'p.ej. despacho.confirmar, anulacion.despacho, usuario.actualizar',
  entidad VARCHAR(30) NOT NULL COMMENT 'solicitud, manifiesto, cola, usuario, empresa',
  entidad_id VARCHAR(40) NULL,
  descripcion VARCHAR(500) NOT NULL COMMENT 'texto legible para el visor',
  detalle LONGTEXT NULL COMMENT 'JSON con antes/después u otros datos',
  KEY idx_aud_fecha (created_at),
  KEY idx_aud_usuario (usuario_id, created_at),
  KEY idx_aud_entidad (entidad, entidad_id),
  KEY idx_aud_accion (accion, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
