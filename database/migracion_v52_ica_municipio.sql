-- migracion_v52_ica_municipio.sql
-- Tarifa de ICA (por mil) por municipio de origen del viaje.
--
-- Por qué: el ICA se cobra según la ciudad de origen y se digitaba a mano en
-- cada solicitud. Ahora un administrador la parametriza una vez por municipio
-- (página Impuestos) y el formulario de solicitud la propone al elegir el
-- remitente. Cada solicitud conserva la tarifa con la que se guardó
-- (solicitud_servicio.porcentaje_ica): cambiar esta tabla no altera las
-- solicitudes existentes.
--
-- La tarifa guarda 2 decimales, igual que solicitud_servicio.porcentaje_ica
-- (DECIMAL(5,2)): con más, la solicitud la redondearía distinto de como se
-- calcula la retención. El ICA es un impuesto MUNICIPAL: la tarifa se
-- configura por municipio (código DIVIPOLA terminado en 000) y los centros
-- poblados (Palmitas, Santa Elena...) usan la de su municipio (Medellín).
--
-- Sin llave foránea a `municipio` a propósito: esa tabla se recrea al
-- reimportar DIVIPOLA y una FK lo impediría. El código valida que el
-- municipio exista al guardar.
--
-- Repetible: CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS ica_municipio (
  codigo_rndc VARCHAR(8) NOT NULL PRIMARY KEY COMMENT 'municipio.codigo_rndc del origen del viaje',
  tarifa_por_mil DECIMAL(5,2) NOT NULL COMMENT 'Tarifa de ICA por mil (p.ej. 9.66); 2 decimales, igual que solicitud_servicio.porcentaje_ica',
  updated_by BIGINT UNSIGNED NULL COMMENT 'staff_users.id de quien la dejó así',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT chk_ica_tarifa CHECK (tarifa_por_mil >= 0 AND tarifa_por_mil <= 100)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
