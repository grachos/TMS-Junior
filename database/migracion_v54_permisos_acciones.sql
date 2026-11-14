-- migracion_v54_permisos_acciones.sql
-- Permisos por acción: además de las páginas (menús), un administrador puede
-- decidir qué botones críticos puede usar cada operador (enviar al RNDC,
-- anular, cancelar envíos, configurar impuestos...).
--
--   staff_users.acciones: lista JSON de acciones permitidas al operador.
--     NULL = valores por defecto (lo que el operador ya podía hacer antes:
--     despachar, marcar Interna, editar despachos y guardar cumplidos).
--     El administrador siempre puede todo e ignora esta columna.
--
-- No cambia el comportamiento de nadie hasta que un admin configure una lista.
-- Debe correrse ANTES de desplegar el código nuevo: sin la columna, guardar un
-- usuario desde Usuarios falla (el resto de la app sigue funcionando).
-- Repetible: ADD COLUMN IF NOT EXISTS.

ALTER TABLE staff_users
  ADD COLUMN IF NOT EXISTS acciones LONGTEXT NULL DEFAULT NULL AFTER paginas;
