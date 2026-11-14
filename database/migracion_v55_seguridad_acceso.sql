-- migracion_v55_seguridad_acceso.sql
-- Seguridad de la parte pública (login): límites por IP y por cuenta guardados
-- en la base (el hosting puede correr varios procesos; la memoria no se comparte)
-- y una auditoría de cada intento de ingreso.
--
--   auth_intentos: una fila por intento de login. Se inserta ANTES de verificar la
--     contraseña y se marca exito=1 si salió bien, así una ráfaga simultánea no
--     se cuela por encima del límite. El correo tecleado se guarda SOLO como hash
--     SHA-256 (a veces lo tecleado es una contraseña puesta en el campo equivocado).
--     Se purga a los 2 días.
--   auth_auditoria: una fila por intento con IP, navegador, resultado (EXITO,
--     CREDENCIALES, BLOQUEO_CUENTA, BLOQUEO_IP, ...) y usuario si se conoce. Nunca
--     contraseñas ni tokens. Sin llave foránea: el rastro sobrevive a la baja del
--     usuario. Se purga al año.
--
-- Reemplaza a login_intentos (v48): esa tabla queda como respaldo mientras esta
-- migración no se haya corrido en una base. Repetible: solo IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS auth_intentos (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  ip VARCHAR(64) NOT NULL,
  identificador_hash CHAR(64) NULL,
  exito TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_auth_intentos_ip (ip, created_at),
  KEY idx_auth_intentos_id (identificador_hash, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS auth_auditoria (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ip VARCHAR(64) NULL,
  user_agent VARCHAR(255) NULL,
  identificador_hash CHAR(64) NULL,
  usuario_id INT NULL,
  resultado VARCHAR(30) NOT NULL,
  KEY idx_auth_auditoria_fecha (created_at),
  KEY idx_auth_auditoria_ip (ip, created_at),
  KEY idx_auth_auditoria_usuario (usuario_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
