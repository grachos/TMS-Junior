-- migracion_v51_ocultar_clave_rndc.sql
-- Borra la clave del RNDC de las previsualizaciones ya guardadas en la cola.
--
-- Por qué: en "modo seguro" (COLA_ENVIO_HABILITADO=false) cada envío guardaba
-- en cola_envios.respuesta_rndc la previsualización del XML, que incluía
-- <acceso><password>CLAVE REAL</password>. Esa columna se veía en "Ver XML"
-- (cualquier usuario con acceso a Cola) y la podía leer el chatbot. El código
-- ya guarda la previsualización con la clave enmascarada; esta migración
-- limpia las filas viejas. Después de correrla, cambia la clave en el RNDC.
--
-- Repetible: reemplazar de nuevo una clave ya enmascarada no cambia nada.

UPDATE cola_envios
SET respuesta_rndc = REGEXP_REPLACE(respuesta_rndc, '<password>[^<]*</password>', '<password>********</password>')
WHERE respuesta_rndc LIKE '%<password>%';
