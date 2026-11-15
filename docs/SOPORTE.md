# Soporte y mantenimiento de Konekto — Fase 1: propietario único

El módulo de soporte y mantenimiento (consola, diagnóstico, correcciones) es **privado de una sola cuenta: el propietario de
la plataforma**. Ningún otro usuario —aunque tenga el rol `admin`— puede abrirlo, asignarse acceso ni modificar la cuenta
del propietario. Esta fase construye esa separación; las herramientas de incidentes llegan en las fases siguientes.

## Cómo funciona

- **Identidad**: cada cuenta tiene un `uuid` estable e inmutable (`staff_users.uuid`, migración v57), generado por la base.
  Ninguna ruta lo escribe y ninguna respuesta lo devuelve.
- **Vínculo**: la variable de entorno del servidor `PLATFORM_OWNER_UUID` dice cuál cuenta es la del propietario. No depende
  del correo (editable), del `id`, de ser el primer administrador, de ningún rol ni de nada que envíe el navegador.
- **Autorización** (`requirePlatformOwner`, independiente de `requireAuth`/`requireAccion`/roles): en cada petición el
  servidor relee la cuenta y exige (1) cuenta activa, (2) uuid igual al configurado y válido, (3) sesión vigente. Si falta la
  configuración, es inválida, o la columna no existe (migración sin correr), **se deniega todo**, a todos, y se registra en
  el log. Nunca se cae a "cualquier administrador".
- **Denegado por defecto**: la primera línea de `soporteRouter` es el guardia; todo endpoint que se agregue después queda
  protegido, y una prueba recorre el router para comprobarlo.
- **Sin catálogo ordinario**: el soporte no está en `ACCIONES_DEF` ni en `PAGINAS`. Asignar acciones o páginas no concede nada.
- **Cuenta protegida**: la cuenta del propietario no se puede modificar desde **Usuarios** —ni por otro administrador ni por
  ella misma—; la regla vive en el servicio de cuentas (`updateUser`), no solo en la ruta o la interfaz. Los cuerpos con campos
  reservados (`uuid`, `isOwner`, `sesion_version`…) se rechazan con 400. No existe ruta para borrar cuentas.
- **Perfil propio**: el propietario cambia su nombre, correo y contraseña en **Soporte → Mi cuenta**, con su contraseña actual
  en la misma petición (y tope de intentos). Cambiar correo o contraseña **cierra todas sus sesiones** y deja sin efecto los
  enlaces de recuperación pendientes.
- **Sesiones revocables**: `staff_users.sesion_version` sube al cambiar una contraseña (también la recuperación por correo y el
  cambio hecho por un administrador a otra cuenta) o al pulsar "Cerrar todas mis sesiones". El token lleva la versión con la
  que se emitió; si ya no coincide deja de valer.
- **Interfaz**: `/auth/me` y el login devuelven `capabilities.supportOwner` (calculada por el servidor). Solo decide si se
  muestra el menú; la ruta `/soporte` valida contra el servidor (`GET /api/soporte/estado`) antes de pintar nada.
  Manipular `localStorage`, entrar por la URL o alterar el JavaScript no recupera información.

## Vincular la cuenta del propietario (una vez por sitio)

1. Corre `database/migracion_v57_propietario_sesiones.sql` en la base (antes: `SELECT VERSION();` debe ser MariaDB 10.2+).
2. En phpMyAdmin, **elige y verifica** tu cuenta (no se supone cuál es):

   ```sql
   SELECT id, nombre, email, rol, activo, uuid FROM staff_users WHERE email = 'tu-correo@dominio.com';
   ```

   Comprueba que sea TU cuenta y esté activa. Debe devolver **una sola fila**.
3. Copia su `uuid` y ponlo en hPanel como `PLATFORM_OWNER_UUID` **de ese sitio** (cada sitio tiene su propia base y su propio
   propietario). No lo publiques en el repositorio ni en el chat.
4. Reinicia la app y mira el log: debe decir `[soporte] Propietario vinculado: exactamente una cuenta activa coincide.` Si dice
   que no está configurado, es inválido o no coincide con una cuenta activa, el soporte permanece **denegado** para todos.
5. Entra con tu cuenta: aparece **Soporte** en el menú.

Debe haber **exactamente una** cuenta vinculada por instalación (el índice único de `uuid` lo garantiza). La propiedad **no se
transfiere desde la aplicación**.

## Recuperación excepcional (solo con acceso controlado al servidor)

Si pierdes el acceso o hay que cambiar de propietario, se hace **fuera de la aplicación**, con acceso a hPanel/base de datos:

1. Verifica la cuenta destino con el `SELECT` de arriba.
2. Cambia `PLATFORM_OWNER_UUID` en hPanel y reinicia.
3. **Revoca las sesiones** de la cuenta anterior y de la nueva:

   ```sql
   UPDATE staff_users SET sesion_version = sesion_version + 1 WHERE uuid IN ('<uuid-anterior>', '<uuid-nuevo>');
   ```
4. **Deja constancia** (auditoría):

   ```sql
   INSERT INTO auditoria (usuario_email, accion, entidad, descripcion, detalle)
   VALUES ('servidor', 'propietario.recuperacion', 'usuario', 'Cambio de propietario por acceso al servidor', '{"motivo":"<explica>"}');
   ```
5. Los administradores comunes no pueden emitir ni recibir credenciales de recuperación de esa cuenta: el enlace por correo
   solo llega al correo de la cuenta, y nadie más puede cambiarlo.

`seed-admin` se niega a modificar la cuenta del propietario.

## Alcance de la garantía

La exclusividad es frente a **usuarios y administradores de la aplicación**. Quien controle el servidor, las credenciales de
base de datos, las variables de entorno o el despliegue **podría modificar estas reglas** (por ejemplo, cambiar
`PLATFORM_OWNER_UUID` o escribir en `staff_users`). Esos accesos de infraestructura —hPanel, phpMyAdmin, GitHub y los secretos—
también deben permanecer bajo tu control.

## Qué cubre cada prueba (backend/test/propietario*.test.ts)

El propietario entra · otro admin y un operador reciben 403 en **cada** ruta del router (y 401 sin sesión) · `isOwner` en
cuerpo/consulta/cabeceras/token no sirve · acciones y páginas asignadas no conceden nada · otro admin no cambia correo,
contraseña, rol, estado ni nombre del propietario · el ataque por recuperación (cambiar el correo y pedir un enlace) no
funciona · campos reservados → 400 y no se crea un segundo propietario · configuración ausente o inválida → todo denegado ·
sesiones revocadas no ejecutan nada · perfil con reautenticación y tope de intentos · auditoría de las acciones del propietario.
Las defensas se rompieron a propósito para comprobar que las pruebas fallan.

## Siguientes fases (en pruebas primero)

2. Incidentes y reporte de usuarios (aunque la IA esté caída) · 3. Diagnóstico por reglas y explicación ·
4. Corrección con PR en un entorno aislado (GitHub Actions) · 5. Integración automática al sitio de pruebas.
El chat actual de datos **no** tiene herramientas técnicas: cuando las haya, vivirán solo en el contexto del propietario.
