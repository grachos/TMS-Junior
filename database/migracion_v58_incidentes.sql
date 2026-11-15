-- migracion_v58_incidentes.sql
-- Soporte, fase 2: incidentes y reportes de usuarios.
--
--   incidentes: UN incidente por problema equivalente EN CADA INSTALACIÓN (UNIQUE sitio+huella; nunca se mezclan datos
--     de sitios distintos). Cuenta ocurrencias, guarda la versión desplegada y la explicación PÚBLICA en 5 campos
--     (hecho observado / posible causa / causa confirmada / acción temporal / estado de la corrección).
--   incidente_eventos: historial del incidente (cambios de estado, reportes, mensajes). Solo el propietario.
--   incidente_evidencias: evidencia técnica YA sanitizada (sin tokens, contraseñas ni XML del RNDC). Solo el propietario.
--     Se conservan las últimas ~20 por incidente.
--   incidente_reportes: lo que cada usuario reportó (texto sanitizado). Cada usuario ve SOLO los suyos.
--   incidente_mensajes: 'interno' (notas técnicas, solo propietario) o 'publico'. Un mensaje PÚBLICO se ata a UN reporte
--     (reporte_id): lo que se le responde a un usuario nunca llega a otro, aunque compartan incidente.
--
-- Repetible: solo CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS incidentes (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  sitio VARCHAR(80) NOT NULL,
  huella CHAR(64) NOT NULL,
  tipo VARCHAR(20) NOT NULL DEFAULT 'codigo',
  origen VARCHAR(12) NOT NULL DEFAULT 'servidor',
  severidad VARCHAR(10) NOT NULL DEFAULT 'media',
  estado VARCHAR(24) NOT NULL DEFAULT 'nuevo',
  corregible TINYINT(1) NOT NULL DEFAULT 1,
  titulo VARCHAR(200) NOT NULL,
  operacion VARCHAR(200) NULL,
  codigo VARCHAR(60) NULL,
  version_despliegue VARCHAR(64) NULL,
  ocurrencias INT NOT NULL DEFAULT 1,
  primera_vez DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ultima_vez DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  exp_hecho TEXT NULL,
  exp_posible_causa TEXT NULL,
  exp_causa_confirmada TEXT NULL,
  exp_accion_temporal TEXT NULL,
  exp_estado_correccion TEXT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_incidentes_sitio_huella (sitio, huella),
  KEY idx_incidentes_estado (estado, ultima_vez),
  KEY idx_incidentes_ultima (ultima_vez)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS incidente_eventos (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  incidente_id BIGINT NOT NULL,
  tipo VARCHAR(30) NOT NULL,
  detalle VARCHAR(500) NULL,
  actor_usuario_id INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_incidente_eventos (incidente_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS incidente_evidencias (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  incidente_id BIGINT NOT NULL,
  tipo VARCHAR(12) NOT NULL,
  contenido TEXT NOT NULL,
  usuario_id INT NULL,
  request_id VARCHAR(64) NULL,
  version_despliegue VARCHAR(64) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_incidente_evidencias (incidente_id, id),
  KEY idx_incidente_evidencias_request (request_id),
  KEY idx_incidente_evidencias_usuario (usuario_id, tipo, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS incidente_reportes (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  incidente_id BIGINT NOT NULL,
  usuario_id INT NOT NULL,
  texto VARCHAR(1000) NOT NULL,
  pantalla VARCHAR(200) NULL,
  request_id VARCHAR(64) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_incidente_reportes_usuario (usuario_id, id),
  KEY idx_incidente_reportes_incidente (incidente_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS incidente_mensajes (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  incidente_id BIGINT NOT NULL,
  reporte_id BIGINT NULL,
  visibilidad VARCHAR(8) NOT NULL,
  autor VARCHAR(12) NOT NULL DEFAULT 'propietario',
  texto VARCHAR(1000) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_incidente_mensajes_incidente (incidente_id, id),
  KEY idx_incidente_mensajes_reporte (reporte_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
