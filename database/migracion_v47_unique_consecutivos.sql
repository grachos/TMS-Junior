-- migracion_v47_unique_consecutivos.sql
-- Llave única en manifiesto.num_manifiesto y remesa.num_remesa.
--
-- Por qué: dos despachos simultáneos podían recibir el mismo número de
-- manifiesto/remesa (la reserva del consecutivo no bloqueaba la fila de
-- maestro_empresa). El código ya lo corrige con SELECT ... FOR UPDATE; esta
-- llave es la última barrera en la base: un número repetido nunca se guarda.
-- Los NULL no chocan entre sí (filas sin número siguen permitidas).
--
-- Repetible y segura con datos existentes: solo crea cada índice si no existe
-- Y si no hay números repetidos hoy. Si los hay, no lo crea (el ALTER fallaría)
-- y la consulta del final los lista para revisarlos a mano; después de
-- corregirlos, vuelve a correr esta migración.

SET @dup_man = (SELECT COUNT(*) FROM (SELECT num_manifiesto FROM manifiesto
                 WHERE num_manifiesto IS NOT NULL GROUP BY num_manifiesto HAVING COUNT(*) > 1) d);
SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'manifiesto' AND INDEX_NAME = 'uq_manifiesto_num') = 0 AND @dup_man = 0,
  'ALTER TABLE manifiesto ADD UNIQUE KEY uq_manifiesto_num (num_manifiesto)',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

SET @dup_rem = (SELECT COUNT(*) FROM (SELECT num_remesa FROM remesa
                 WHERE num_remesa IS NOT NULL GROUP BY num_remesa HAVING COUNT(*) > 1) d);
SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'remesa' AND INDEX_NAME = 'uq_remesa_num') = 0 AND @dup_rem = 0,
  'ALTER TABLE remesa ADD UNIQUE KEY uq_remesa_num (num_remesa)',
  'SELECT 1');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- Resultado: qué quedó activo y qué números repetidos impiden crear la llave.
SELECT
  (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'manifiesto' AND INDEX_NAME = 'uq_manifiesto_num') > 0 AS llave_manifiesto_activa,
  (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'remesa' AND INDEX_NAME = 'uq_remesa_num') > 0 AS llave_remesa_activa;
SELECT 'manifiesto' AS tabla, num_manifiesto AS numero, COUNT(*) AS veces, GROUP_CONCAT(id) AS ids
  FROM manifiesto WHERE num_manifiesto IS NOT NULL GROUP BY num_manifiesto HAVING COUNT(*) > 1
UNION ALL
SELECT 'remesa', num_remesa, COUNT(*), GROUP_CONCAT(id)
  FROM remesa WHERE num_remesa IS NOT NULL GROUP BY num_remesa HAVING COUNT(*) > 1;
