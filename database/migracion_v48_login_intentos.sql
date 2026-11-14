-- migracion_v48_login_intentos.sql
-- Registro de intentos de inicio de sesión, para bloquear la fuerza bruta.
--
-- Por qué: /api/auth/login no tenía ningún límite; se podían probar
-- contraseñas sin fin. Tras 5 intentos fallidos para un mismo correo en 15
-- minutos (desde su último ingreso exitoso), el login responde 429 durante el
-- resto de la ventana, aunque la contraseña sea correcta. Se cuenta en la base
-- (no en memoria) para que funcione con varios procesos o tras un reinicio.
-- Se guarda el correo tal como se escribió (normalizado), exista o no la
-- cuenta, para no revelar qué cuentas existen.
--
-- Repetible: CREATE TABLE IF NOT EXISTS. Si esta migración no se ha corrido,
-- el login sigue funcionando sin límite y deja un error en el log.

CREATE TABLE IF NOT EXISTS login_intentos (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(190) NOT NULL,
  ip VARCHAR(45) NULL,
  exito TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_login_intentos_email (email, created_at),
  KEY idx_login_intentos_fecha (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
