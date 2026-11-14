-- migracion_v49_producto_columnas.sql
-- Amplía tres columnas de `producto` que el catálogo oficial del RNDC
-- (catalogo_productos.csv) supera:
--   - grupo_embalaje VARCHAR(5) -> VARCHAR(20): 288 mercancías peligrosas
--     traen varios grupos, p.ej. "I, II, III" (10 caracteres).
--   - nombre VARCHAR(400) -> VARCHAR(600): el producto A1180 tiene 503.
--   - alerta VARCHAR(3) -> VARCHAR(255): el mercurio (2809) trae una alerta
--     legal de 120 caracteres.
-- Con modo estricto la carga del catálogo fallaba en esas filas; sin él, se
-- habrían guardado recortadas (p.ej. "I, II, III" -> "I, II", que es otro dato).
-- Estos campos solo se muestran en pantalla y en el PDF; no viajan al RNDC.
--
-- Repetible: MODIFY a la misma definición no cambia nada.

ALTER TABLE producto
  MODIFY nombre VARCHAR(600) NOT NULL COMMENT '[NOMBREYDESCRIPCION]',
  MODIFY grupo_embalaje VARCHAR(20) NULL COMMENT '[GRUPOEMBALAJEENVASE]',
  MODIFY alerta VARCHAR(255) NULL;
