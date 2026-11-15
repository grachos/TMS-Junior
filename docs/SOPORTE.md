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

## Fase 2a — incidentes y reportes (backend)

**Qué hay**: el servidor registra como *incidente* sus errores 5xx (sanitizados) y los usuarios pueden *reportar* un problema.
La interfaz (Error Boundary, pestaña de reporte, consola) llega en la fase 2b.

- **Correlación**: cada petición lleva `X-Request-Id` (se conserva el del navegador si es válido; si no, se genera) y los errores JSON
  traen `requestId` (campo extra: las respuestas de siempre no cambian).
- **Captura del servidor** (`errorMiddleware`): solo 5xx, **después** de responder, sin poder cambiar ni retrasar la respuesta; con
  interruptor (si registrar falla, se calla ~60 s); nunca captura `/api/reportes` ni `/api/soporte`; los rechazos de negocio del RNDC no
  se vuelven incidentes (ya viven en la cola de envíos).
- **Agrupación**: UN incidente por (`sitio`, `huella`). La huella ignora ids, números y textos entre comillas; dos sitios nunca se mezclan.
  Cuenta ocurrencias, guarda la **versión desplegada** (`APP_COMMIT` o `dist/build-info.json` que escribe el build; si no hay git queda
  `desconocida`, no se adivina) y reabre un incidente verificado/cerrado si reaparece. Se conservan las últimas ~20 evidencias.
- **Clasificación por reglas** (no IA): código, datos, permisos, migración, configuración, RNDC, proveedor de IA, infraestructura.
  Migración pendiente, RNDC, IA, configuración e infraestructura quedan **no corregibles con código** (`corregible = 0`): un cambio de
  código no las arregla y ocultarlas sería peor.
- **Sanitización antes de guardar** (también del texto que escribe el usuario): JWT, Bearer, `clave=valor`, XML del RNDC, correos, uuids,
  números largos y cadenas tipo clave de API se reemplazan; las rutas se normalizan (`/api/x/123` → `/api/x/:id`) y las pilas pierden las
  rutas del servidor.
- **Reportes de usuarios** (`/api/reportes`, cualquier usuario autenticado): `POST` (funciona aunque el chat de IA esté apagado o caído;
  tope 5 cada 10 min por usuario, en la base), `GET` (mis reportes), `GET /:id` (solo el mío: de otro —**incluso un administrador**— responde
  **404**). `POST /telemetria` recibe errores del navegador (autenticado, validado, 10 por minuto por usuario; un 5xx que el servidor ya
  capturó no se duplica).
- **Lo que ve el usuario** sale de una **lista blanca**: estado con etiqueta pública, su texto, los 5 campos de explicación (hecho observado,
  posible causa, causa confirmada, acción temporal, estado de la corrección; vacíos si nadie los ha completado) y los mensajes públicos
  de SU reporte. Nunca evidencias, pilas, notas internas, versión, sitio ni datos de otros usuarios (probado con un volcado).
- **Consola del propietario** (en `soporteRouter`, ya protegido): `GET /api/soporte/incidentes`, `GET …/:id` (evidencias, eventos, reportes,
  mensajes), `PATCH …/:id` (estado, severidad, tipo, corregible, explicación; auditado) y `POST …/:id/mensajes` (interno o público).
- **Mensajes públicos atados al reporte**: lo que se le responde a un usuario no llega a otro que comparta el incidente.
- **Avisos (push) solo a destinatarios concretos** (`enviarAUsuarios`; `enviarATodos` no se usa aquí): lo técnico solo al propietario
  (resuelto por su uuid; sin propietario configurado no se avisa a nadie) y los avisos al usuario solo a quienes reportaron **ese**
  incidente, **después** de guardar el cambio y con el estado releído. Una nota interna no avisa a nadie. Las etiquetas públicas no
  prometen de más: "corregido" ≠ "publicado" ≠ "verificado".

**Variables**: `SITE_ID` (opcional; si falta se usa el dominio de `APP_URL`) y `APP_COMMIT` (opcional; si falta se usa `build-info.json`).
**Migración**: `database/migracion_v58_incidentes.sql` (repetible). Sin ella no se pierde nada: la captura falla en silencio y los reportes
responden con error; el resto de la app sigue.

**Límites conocidos**: los reportes de usuario sin un `X-Request-Id` de un error real se agrupan por pantalla (no por contenido);
el diagnóstico automático y la explicación con IA llegan en la fase 3. El chat de datos actual **no** se tocó: la corrección de su
contexto de autorización es de la fase 3, antes de darle herramientas.

## Fase 2b — interfaz (reportar, seguir el estado y consola)

- **Asistente con tres pestañas** (`ChatWidget`): **Reportar** (siempre disponible, no depende del chat de IA), **Mis reportes** (estado real y la
  explicación en 5 partes) y **Consultar datos** (el chat de siempre; solo aparece si el backend lo informa habilitado; su comportamiento no cambió).
  El botón muestra una marca con las novedades que aún no viste (comodidad por navegador, no fuente de verdad).
- **Las 5 partes siempre se distinguen**: lo que observamos · posible causa · causa confirmada (solo con evidencia) · qué puedes hacer mientras
  tanto · estado de la corrección. Lo que nadie ha completado se muestra como "todavía no hay información": no se inventa ni se promete nada;
  sin recomendación, la pantalla dice que antes de repetir la operación se revise si quedó registrada.
- **Reportar con contexto**: se adjunta la pantalla actual y, si hubo un error del servidor hace poco, su `X-Request-Id` para atar el reporte a ese
  incidente. La pantalla de error trae el botón "Reportar el problema" (abre el reporte prellenado).
- **Error Boundary** dentro de `<BrowserRouter>`, por pantalla y con reinicio al cambiar de ruta: un error de una pantalla no tumba el menú ni el
  asistente. Hay uno global de último recurso en `main.tsx`.
- **Telemetría del navegador** (`lib/telemetria.ts`, fábrica pura probada sin navegador): solo con sesión; sin conexión no reporta; descarta ruido
  (red, cancelaciones, extensiones, la propia telemetría); deduplica; tope por carga de página; una sola llamada en vuelo; usa `fetch` directo;
  nunca lanza ni se reporta a sí misma; `api()` no reporta las llamadas a `/reportes`. Reporta errores no controlados, de React y respuestas 5xx.
- **Consola del propietario** (Soporte → Incidentes): filtros, severidad, frecuencia, reportes, estado y tipo; detalle con evidencia sanitizada,
  historial, reportes de usuarios, mensajes **internos o públicos** (un público puede ir a todos los reportes o a uno), explicación pública de 5
  campos y la opción "Avisar a quienes reportaron" (solo si el estado cambia y quedó guardado).
- **Pendiente para las siguientes fases**: ejecuciones y consumo del agente, diff/PR/commit, estado por sitio, política de autonomía, pausa global,
  reintento y escalamiento (no hay nada de eso todavía, por eso la consola no los muestra).

Verificado en Chromium (app compilada, CSP en modo bloqueo, chat de IA apagado): reporte → vista del propietario → cambio de estado con aviso →
novedad en el botón del usuario; pantalla de error con menú vivo y reporte prellenado; telemetría de error de React y de un 500 con su id de
correlación; el login no envía telemetría; 0 violaciones de CSP.

## Fase 3a — chat de datos: herramientas tipadas y autorización del servidor

**Cambio de comportamiento (léelo):** el chat de datos **ya no escribe SQL libre**. Antes el modelo generaba un `SELECT` y una expresión
regular era la barrera real —el propio código decía que en producción no había usuario de solo lectura—, y además el chat no sabía quién
preguntaba: cualquier usuario autenticado podía consultar datos de pantallas a las que no tenía acceso. Ahora:

- **Herramientas tipadas** (`chat/herramientas.ts`): cada una con consulta fija, columnas enumeradas, parámetros validados (zod `.strict()`),
  enlazados y con `LIMIT`. Cubren solicitudes, manifiestos, remesas, cumplidos pendientes, cola de envíos, terceros, vehículos, productos y
  municipios. Las preguntas de ejemplo del asistente ("¿cuántos manifiestos…?", "¿qué falta por cumplir?", "¿cuántos envíos con error hay en
  la cola?") siguen funcionando. Lo que **no** cubran las herramientas el asistente lo dice con honestidad; si falta un tipo de pregunta, se
  agrega una herramienta.
- **Identidad y permisos desde el servidor**: `responder(ctx, …)` recibe el contexto armado desde `req.user` (releído de la base en cada
  petición, **no** de los claims del token). Al modelo solo se le ofrecen las herramientas que ese usuario puede usar (la misma regla que
  protege las pantallas, `tienePagina`), y cada llamada se vuelve a comprobar al ejecutarla: una herramienta inventada o de otra página
  devuelve el mismo error y no ejecuta ninguna consulta. El historial del navegador es solo texto de conversación (acotado); un cuerpo con
  `rol`, `paginas`, `userId`… responde 400.
- **Secretos y administración fuera del alcance**: ninguna herramienta toca `staff_users`, `maestro_empresa`, `auditoria`, intentos de login,
  suscripciones push ni las tablas de incidentes; la cola no devuelve el contenido enviado. Un test lo comprueba sembrando marcas.
- **Sesión de solo lectura**: cada conexión del pool del chat arranca con `SET SESSION TRANSACTION READ ONLY`; una escritura falla (error 1792)
  aunque se usen las credenciales principales. Al arrancar el log avisa si no hay un `DB_READONLY_USER` distinto de `DB_USER`.
- **Rate limit** del chat: ahora responde 429 (antes 400). Sigue en memoria por proceso (límite conocido; pendiente pasarlo a la base).
- **Pendiente (no se omite en silencio):** la conversación del chat de datos no se persiste en el servidor (los reportes sí); el historial del
  navegador no decide permisos, así que no afecta la seguridad.

**Resultado real en Hostinger compartido: NO se puede crear el usuario de solo lectura.** Se probó `CREATE USER` desde phpMyAdmin en la
base del sitio de pruebas y respondió `#1227 - Access denied; you need (at least one of) the CREATE USER privilege(s)`. El conector de
Hostinger solo crea una base con su usuario y **todos** los permisos, sin `GRANT` por tabla; un segundo usuario así no aportaría nada.
**Riesgo aceptado**, con estas protecciones que sí se tienen: el modelo no escribe SQL; herramientas con consulta fija y argumentos
validados; permisos por usuario desde el servidor; la sesión del chat forzada a `READ ONLY` (error 1792 ante cualquier escritura); y una
guarda que solo deja pasar UNA sentencia `SELECT`. Lo que falta es la barrera del usuario de base de datos con `SELECT` solo sobre algunas
tablas; se lograría con un VPS o un plan con control de usuarios de base de datos. Para silenciar el aviso del arranque en un sitio que
acepta este riesgo, pon `DB_READONLY_ACEPTADO=true`.

**Si tu hosting SÍ permite crear usuarios (VPS, otro plan):** crea el usuario de BD de solo lectura así (producción todavía no lo tiene). Crea este usuario una vez, en phpMyAdmin, y ponlo en
`DB_READONLY_USER` / `DB_READONLY_PASS`. Estas sentencias se generan del registro de herramientas y una prueba comprueba que no se
desactualicen; reemplaza `<base_de_datos>` y la contraseña:

```sql
CREATE USER 'tms_ro'@'localhost' IDENTIFIED BY '<contraseña-larga-y-aleatoria>';
GRANT SELECT ON `<base_de_datos>`.`cola_envios` TO 'tms_ro'@'localhost';
GRANT SELECT ON `<base_de_datos>`.`manifiesto` TO 'tms_ro'@'localhost';
GRANT SELECT ON `<base_de_datos>`.`municipio` TO 'tms_ro'@'localhost';
GRANT SELECT ON `<base_de_datos>`.`producto` TO 'tms_ro'@'localhost';
GRANT SELECT ON `<base_de_datos>`.`remesa` TO 'tms_ro'@'localhost';
GRANT SELECT ON `<base_de_datos>`.`solicitud_servicio` TO 'tms_ro'@'localhost';
GRANT SELECT ON `<base_de_datos>`.`tercero` TO 'tms_ro'@'localhost';
GRANT SELECT ON `<base_de_datos>`.`vehiculo` TO 'tms_ro'@'localhost';
```

Las herramientas **exclusivas del propietario** (diagnóstico, evidencias, configuración) viven en un módulo aparte y nunca se registran aquí.

## Fase 3b — diagnóstico por reglas

Motor **determinista** (sin IA): `backend/src/modules/diagnostico/`. Se ejecuta solo, en segundo plano, cuando un incidente es **nuevo o se reabre**, y a mano con "Diagnosticar ahora" (solo propietario).

- **Confianza la decide el código**, nunca un modelo: `confirmada` solo si la regla comprobó el estado *actual* (p. ej. la tabla/columna sigue ausente en `information_schema`, la variable sigue sin definir); `probable` si hay indicios; `sin_evidencia` en otro caso. Un error de código nunca es "confirmado".
- **Reglas** (`reglas.ts`, versión `VERSION_REGLAS`): migración pendiente (índice de migraciones generado en el build: `dist/migraciones-indice.json`), configuración, RNDC (caída del RNDC → no se toca código; consulta solo `ultimo_error`/estado de `cola_envios` y el catálogo `error_rndc`), infraestructura, proveedor de IA, código (versión/regresión), reportes de usuarios.
- **Solo lectura**: las comprobaciones corren en `START TRANSACTION READ ONLY`. No reenvía documentos, no anula, no cambia estados operativos, no llama al RNDC ni al proveedor de IA.
- **Efectos sobre el incidente**: `nuevo → en_diagnostico` (condicional; no pisa lo que el propietario ya movió). `corregible` solo **baja** (nunca sube) y solo con diagnóstico confirmado; una migración confirmada reclasifica `codigo → migracion`.
- **Borrador público**: plantillas fijas por categoría+confianza (sin rutas, ids, códigos ni texto de la evidencia). "Usar como explicación pública" llena solo campos vacíos (o sobrescribe si se pide) y se calcula en el servidor con la categoría y confianza guardadas. **No notifica** a nadie.
- Se guardan hasta 5 diagnósticos por incidente (`incidente_diagnosticos`, migración v59, repetible).
- Límites: sin IA no explica errores nuevos; lo no reconocido queda `sin_evidencia` y pasa al propietario.

## Fase 3c — explicación con IA (borrador)

Módulo aparte `backend/src/modules/soporteIa/` (no está en el registro de herramientas del chat; el modelo **no tiene herramientas**). Opt-in: `SOPORTE_IA_HABILITADO=true` + `OPENROUTER_API_KEY` (modelo opcional `SOPORTE_IA_MODELO`, por defecto el del chat). Migración v60.

- Solo el propietario, a mano ("Explicar con IA"); requiere un diagnóstico previo. Pausa de 30 s y tope de 5 por incidente.
- Entrada: diagnóstico por reglas + última evidencia, **vueltos a sanitizar**, sin `<`/`>` y dentro de un bloque `<datos>` marcado como no confiable. Sin datos de usuarios.
- Salida: se sanitiza y recorta; se guarda solo como texto para el propietario. **No** cambia confianza, estado, tipo, `corregible` ni la explicación pública, y no notifica.
- Si el proveedor falla: 502 genérico (no se reenvía su mensaje).

## Enlace "Reportar este error" y error conocido

- Todo aviso rojo (`Alert` de error) muestra **"Reportar este error"** cuando hay sesión (el panel de reportes está montado): abre el chat en la pestaña Reportar con el mensaje ya escrito. El código técnico del último 5xx se adjunta solo.
- Al abrir Reportar tras un error, `GET /api/reportes/error/:requestId` dice si ese error **del propio usuario** ya es un incidente conocido y, de serlo, se muestra la explicación pública en 5 partes. Siempre 200; de otro usuario, inexistente o inválido → `{conocido:false}`.

## Fase 4 — issue sanitizado y agente de corrección (PR, nunca integración)

**Lo que hace la app** (solo propietario, a mano, opt-in): botón "Crear issue en GitHub" en el incidente. Migración v61 (`issue_numero`, `issue_url`, `issue_reservado_en`; repetible).

- **Elegibilidad en el servidor** (`backend/src/modules/agente/politica.ts`, un solo lugar; la fase 5 lo leerá): `corregible=1`, tipo `codigo`, diagnóstico de categoría `codigo` y que no diga "no se resuelve con código". Migración, configuración, RNDC, infraestructura, proveedor de IA, datos y permisos **nunca** pasan al agente.
- **Un issue por incidente**: se reserva con un UPDATE condicional antes de llamar a GitHub (doble clic o dos pestañas → uno solo). Si GitHub falla: 502 genérico (no se reenvía su mensaje) y se libera la reserva.
- **Cuerpo del issue** (plantilla fija, `cuerpoIssue.ts`): todo re-sanitizado; sin `@` (no avisa a nadie), sin `#123` (no enlaza), sin comillas invertidas (no rompe el bloque), sin HTML. **Nunca** lleva texto de reportes, ids/correos de usuarios, códigos de correlación ni explicaciones de IA.
- **Repositorio público ⇒ cuerpo mínimo, sin evidencia** (rutas y pilas quedarían publicadas aunque estén sanitizadas). La evidencia solo va con `GITHUB_REPO_PRIVADO=true`. Este repositorio hoy es **público**.
- La app **no** pone la etiqueta que dispara al agente: esa es la aprobación explícita del propietario en GitHub.

**El workflow** (`.github/workflows/agente-correccion.yml`) está **inerte** hasta configurarlo y **no se ha ejecutado nunca**. Se dispara solo si: la etiqueta es `agente-corregir`, el issue tiene `incidente-soporte`, quien etiquetó es `vars.AGENTE_PROPIETARIO` y el autor del issue es `vars.AGENTE_AUTOR_ISSUES`. Sin secretos, termina limpio. Abre un PR desde `agente/incidente-<n>` hacia `main`; nunca hace push a `main`/`produccion` ni integra solo (eso es la fase 5).

### Lista de configuración (la haces tú; nada de esto lo hace el agente)

1. **Token de la app** (GitHub → Settings → Developer settings → fine-grained token): repositorio = solo este, permiso **Issues: Read and write**. Variables en hPanel del sitio de pruebas: `GITHUB_ISSUES_HABILITADO=true`, `GITHUB_ISSUES_TOKEN=<token>` (opcional `GITHUB_ISSUES_REPO`, `GITHUB_REPO_PRIVADO`).
2. **Etiquetas** en el repo: `incidente-soporte` y `agente-corregir`.
3. **Variables del repo** (Settings → Secrets and variables → Actions → Variables): `AGENTE_PROPIETARIO` = tu usuario de GitHub; `AGENTE_AUTOR_ISSUES` = el usuario dueño del token del paso 1.
4. **Secretos del repo**: `CLAUDE_CODE_OAUTH_TOKEN` (con tu suscripción Pro/Max: ejecuta `claude setup-token` en tu computador y pega el resultado; si prefieres pagar por uso, cambia el workflow a `anthropic_api_key` y el secreto `ANTHROPIC_API_KEY`) y `AGENTE_GITHUB_TOKEN` (token de grano fino o GitHub App con Contents y Pull requests: write). Hace falta un token propio porque **los PR abiertos con el `GITHUB_TOKEN` por defecto no disparan el CI** (build/db-tests no correrían sobre el PR del agente).
5. **Fijar la acción a un SHA**: cambia `anthropics/claude-code-action@v1` por el SHA de commit de esa versión tras revisarlo (el tag es móvil).
6. **Proteger `main`**: exigir los checks `build` y `db-tests` y revisión antes de integrar.
7. Antes de la primera prueba real, revisa los permisos/`allowedTools` del workflow contra el README actual de la acción (no pude verificarlos desde aquí).

## Siguientes fases (en pruebas primero)

5. Integración automática al sitio de pruebas.
El chat actual de datos **no** tiene herramientas técnicas: cuando las haya, vivirán solo en el contexto del propietario.
