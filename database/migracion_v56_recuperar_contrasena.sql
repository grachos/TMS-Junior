-- migracion_v56_recuperar_contrasena.sql
-- Recuperar la contraseña por correo ("Olvidé mi contraseña").
--
--   password_resets: un enlace de un solo uso por solicitud. El token NO se guarda:
--     solo su hash SHA-256 (un volcado de la base no sirve para restablecer nada).
--     Vence a los 30 minutos y se marca usado_en al gastarse; una solicitud nueva
--     invalida las anteriores del mismo usuario.
--   recuperacion_solicitudes: una fila por petición de "olvidé mi contraseña" (exista o
--     no la cuenta), solo para limitar abusos: por IP y por correo (guardado como hash
--     SHA-256, nunca en claro). Se purga a los 2 días.
--
-- Repetible: solo CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS password_resets (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  usuario_id INT NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expira_en DATETIME NOT NULL,
  usado_en DATETIME NULL,
  ip VARCHAR(64) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_password_resets_token (token_hash),
  KEY idx_password_resets_usuario (usuario_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS recuperacion_solicitudes (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  ip VARCHAR(64) NOT NULL,
  email_hash CHAR(64) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_recuperacion_ip (ip, created_at),
  KEY idx_recuperacion_email (email_hash, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
