# Despliegue: GitHub → Hostinger (stack Node/React)

> Esta guía reemplaza a [`legacy/DEPLOY.md`](legacy/DEPLOY.md) (la de la app PHP).
> El stack cambió: ahora hay un **backend Node/Express** (proceso persistente) y
> un **frontend React (SPA) compilado a archivos estáticos** — ya no es un LAMP
> puro, así que el despliegue tiene una pieza nueva: la app Node.

Repo: <https://github.com/grachos/TMS-TechCol> (rama `main`).

---

## Sitios y ramas: prueba primero, producción después

Un mismo repositorio alimenta **varios sitios**, cada uno con **su propia base de
datos** y sus propias variables de entorno:

| Sitio | Papel | Despliega desde | Base de datos |
|---|---|---|---|
| `tmslight.techcol-service.cc` | **Prueba** | rama `main` (cada PR fusionado) | `u279856486_tms_light_new` |
| `trading-solucion.konekto.site` | **Producción** | rama `produccion` | `u279856486_trading` |
| *(futuros sitios de producción)* | Producción | rama `produccion` | una base nueva por sitio |

**Flujo de una versión:**

1. Se fusiona el PR a `main` → solo el sitio de **prueba** se despliega.
2. Si la versión trae migraciones nuevas, se corren primero en la base de **prueba**.
3. Se revisa el cambio en el sitio de prueba.
4. **Liberar:** se adelanta `produccion` al mismo commit ya probado
   (`git push origin <commit>:produccion`, siempre avance rápido, nunca código
   que no pasó por prueba) → todos los sitios de producción se despliegan.
5. Las mismas migraciones se corren en **cada** base de producción.

**Sitio de prueba:** `RNDC_AMBIENTE=pruebas`, para que nada de lo que se haga
ahí se radique ante el Ministerio.

**Agregar un sitio de producción nuevo:**

1. hPanel: crear el sitio Node.js y **una base de datos nueva** para él.
2. Variables de entorno (sección 3): `DB_*` de **su** base, un `JWT_SECRET`
   **propio** (si dos sitios comparten secreto, un token de uno sirve en el
   otro), `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` del administrador de esa
   empresa y `RNDC_*` / `COLA_*` de esa empresa.
3. phpMyAdmin: importar en esa base **un solo archivo**, `instalacion_nueva.sql`,
   que trae todo en orden (esquema, catálogos, municipios, migraciones y
   productos). Se genera con `node database/generar_instalacion.mjs` (no se
   versiona). Solo para bases vacías.
4. Configuración de compilación igual a la de los demás sitios: punto de
   entrada `backend/dist/server.js`, salida `backend/dist`, script `build`.
5. Conectar el despliegue a la rama **`produccion`** (no `main`). El primer
   arranque crea el administrador (sección 4).
6. Cron del worker para ese sitio (sección 5).

---

## 0. Verifica que tu plan de Hostinger soporte Node.js

hPanel → busca la sección **"Node.js"** (bajo "Avanzado" o "Sitio web"). Está
disponible en planes **Business, Cloud Startup/Professional/Enterprise, KVM
VPS**. Si no la ves, tu plan es solo LAMP compartido y necesitas subir de
plan (o usar un VPS) para correr el backend — el frontend estático sí
funcionaría en cualquier plan, pero sin backend la app no sirve de nada.

**Limitación importante a aceptar de entrada:** los generadores de PDF usan
`puppeteer-core` con **Chrome del sistema**. Los planes compartidos/Node App
de Hostinger no permiten instalar Chrome, así que en producción **los PDFs
caerán automáticamente al fallback de HTML imprimible** (ya está contemplado
en el código, no es un bug). Si necesitas el PDF real, hace falta un VPS con
Chrome instalado.

---

## 1. Base de datos en Hostinger

Si ya tenías la app PHP corriendo ahí, **reutiliza esa misma base** — el
rewrite es 1:1 sobre el mismo esquema, así que tus datos (terceros, remesas,
manifiestos, RNDC…) se preservan. Si es una instalación nueva:

1. hPanel → **Bases de datos → Bases de datos MySQL**.
2. Crea una base (ej. `uXXXX_light_tms`) y un usuario; **anota** host, nombre,
   usuario y clave. En Hostinger `DB_HOST` suele ser `localhost`.
3. **phpMyAdmin** → selecciona la base → pestaña **Importar**, y sube estos
   archivos de [`database/`](database/) **en este orden exacto** (los nombres
   no ordenan bien alfabéticamente — v10 va después de v2, no antes):

   ```
   schema.sql
   maestros.sql
   catalogos.sql
   catalogo_configuracion.sql   ← configuraciones de vehículo (sin ella falla la página Vehículos)
   municipios.sql
   migracion_v2.sql   migracion_v3.sql   migracion_v4.sql   migracion_v5.sql
   migracion_v6.sql   migracion_v7.sql   migracion_v8.sql   migracion_v9.sql
   migracion_v10.sql  migracion_v11.sql  migracion_v12.sql  migracion_v13.sql
   migracion_v14.sql  migracion_v15.sql  migracion_v16.sql  migracion_v17.sql
   migracion_v18.sql  migracion_v19_municipios.sql          migracion_v20.sql
   migracion_v21.sql  migracion_v22.sql  migracion_v23.sql  migracion_v24.sql
   migracion_v25.sql  migracion_v26.sql  migracion_v27.sql  migracion_v28.sql
   migracion_v29.sql  migracion_v30.sql
   migracion_v31_staff_users.sql   ← NUEVO (login del personal)
   migracion_v32_pdf_oficial.sql   ← NUEVO (plantilla PDF oficial)
   migracion_v33_rndc_credenciales.sql   ← NUEVO (usuario/contraseña RNDC en maestro_empresa)
   migracion_v34_drop_peso_vacio_remolque.sql
   migracion_v35_manifiesto_observaciones.sql
   migracion_v36_manifiesto_seguridadqr_error.sql
   migracion_v37_cola_tipo_documento_cumplido.sql
   migracion_v38_staff_users_paginas.sql   ← permisos por página del operador
   migracion_v39_cumplido_cargue_entrada_salida.sql   ← fechas/horas entrada+salida cargue del cumplido
   migracion_v40_push_subscriptions.sql   ← NUEVO (notificaciones push por usuario)
   migracion_v41_indices_estado.sql   ← NUEVO (índices para los contadores de los badges)
   migracion_v42_anulacion.sql   ← NUEVO (columnas de anulación en manifiesto/remesa)
   migracion_v43_cola_tipo_documento_anulacion.sql   ← NUEVO — CRÍTICA, correr cuanto antes
   migracion_v44_estado_rndc_anulacion.sql   ← NUEVO — CRÍTICA, correr cuanto antes
   migracion_v45_reparar_anulacion_huerfana.sql   ← NUEVO — reparación puntual, idempotente
   migracion_v46_contenedor_serial.sql
   migracion_v47_unique_consecutivos.sql   ← NUEVO — llave única de No. manifiesto/remesa (ver nota)
   migracion_v48_login_intentos.sql   ← NUEVO — límite de intentos de login (5 fallos / 15 min)
   migracion_v49_producto_columnas.sql   ← NUEVO — amplía columnas de producto para el catálogo RNDC
   migracion_v50_auditoria.sql   ← NUEVO — bitácora de auditoría (página Actividad)
   migracion_v51_ocultar_clave_rndc.sql   ← NUEVO — borra la clave RNDC de previsualizaciones guardadas
   migracion_v52_ica_municipio.sql   ← NUEVO — tarifa de ICA por municipio de origen (página Impuestos)
   migracion_v53_solicitud_interna.sql   ← NUEVO — solicitudes internas (nada viaja al RNDC). CORRER ANTES de desplegar el código (agrega el estado 'interno'); revisa antes los dos SELECT que trae en su encabezado
   migracion_v54_permisos_acciones.sql   ← NUEVO — permisos por acción (botones críticos) por usuario. CORRER ANTES de desplegar el código; no cambia el comportamiento de nadie hasta que un admin configure una lista
   migracion_v55_seguridad_acceso.sql   ← NUEVO — límites por IP/cuenta y auditoría de accesos del login. CORRER ANTES de desplegar el código; sin ella el login usa el límite anterior por correo (y avisa en el log)
   migracion_v56_recuperar_contrasena.sql   ← NUEVO — "Olvidé mi contraseña" por correo (enlaces de un solo uso y límites). CORRER ANTES de desplegar el código; sin ella solo falla esa función, el login sigue igual
   migracion_v57_propietario_sesiones.sql   ← NUEVO — identidad (uuid) de cada cuenta y revocación de sesiones; base del soporte del propietario único. CORRER ANTES de desplegar el código (requiere MariaDB 10.2+: `SELECT VERSION();`); sin ella el soporte queda denegado y el resto sigue igual
   migracion_v58_incidentes.sql   ← NUEVO — incidentes y reportes de usuarios (soporte, fase 2). Repetible; sin ella la captura falla en silencio y los reportes responden con error, el resto de la app sigue
   migracion_v59_diagnosticos.sql   ← NUEVO — diagnósticos de incidentes (soporte, fase 3b). Repetible; sin ella el diagnóstico automático falla en silencio, el resto sigue
   migracion_v60_explicaciones_ia.sql   ← NUEVO — borradores con IA para el propietario (soporte, fase 3c). Repetible; solo se usa si `SOPORTE_IA_HABILITADO=true`
   productos.sql   ← SIEMPRE AL FINAL: catálogo de productos (solo carga si la tabla está vacía)
   ```

   > **v43 y v44 corrigen corrupción silenciosa de datos, no son solo ajustes
   > de esquema.** `cola_envios.tipo_documento` (v43) y `manifiesto`/`remesa`
   > `.estado_rndc` (v44) son columnas ENUM; los valores nuevos de anulación
   > nunca se agregaron a esas listas, así que en MySQL sin modo estricto cada
   > escritura con un valor fuera del ENUM se guardó como `''` en vez de
   > fallar — es la causa del círculo vacío en la columna RNDC de Despachos.
   > Si ya usaste "Anular" (cascada o individual) antes de correr estas
   > migraciones, **ambas reparan** las filas afectadas usando las columnas de
   > auditoría (`anulacion_motivo`, `anulacion_rndc_id`) para inferir el
   > estado real. Ejecútalas en orden (v43 antes que v44) antes de seguir
   > anulando.
   >
   > **Instalación nueva:** `migracion_v21.sql` falla con "Unknown column
   > 'cantidad_cargada'" porque `schema.sql` ya trae ese cambio. Es esperado:
   > sigue con v22. `productos.sql` carga los 3.758 productos del catálogo oficial
   > del RNDC; se genera desde `catalogo_productos.csv` con
   > `node database/generar_productos_sql.mjs` (reemplaza a
   > `importar_productos_csv.php`). En una base que ya tiene productos no cambia nada.

   > **v47** agrega una llave única a `manifiesto.num_manifiesto` y
   > `remesa.num_remesa`. Es repetible y no falla con datos existentes: si ya hay
   > números repetidos, no crea esa llave y la última consulta los lista (tabla,
   > número, ids). Corrígelos y vuelve a correrla; revisa que el resultado diga
   > `llave_manifiesto_activa = 1` y `llave_remesa_activa = 1`.

   > **v45** repara un caso más puntual: si cancelaste un paso de anulación en
   > Cola *antes* de que existiera `revertirAnulacionSiNoQuedaNadaActivo()`
   > (commit `a022900`), ese manifiesto/remesa quedó atascado en
   > `anulacion_pendiente` para siempre — sin ningún paso activo en `cola_envios`
   > que lo explique, sin poder anularse ni cumplirse de nuevo. v45 es
   > idempotente (se puede correr las veces que haga falta) y solo toca esos
   > casos huérfanos.

   Todas las migraciones usan `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF
   NOT EXISTS` / `ADD INDEX IF NOT EXISTS`, así que son **idempotentes**: si tu
   base ya tenía aplicadas varias de la app PHP, no pasa nada por
   re-importarlas. Importa **siempre la lista completa hasta la más reciente**
   cada vez que despliegues cambios que traigan migraciones nuevas (las últimas
   son **v40** —push— y **v41** —índices—). Como mínimo, **v31 y v32 son
   obligatorias y nuevas** respecto a la app PHP.
4. Solo en instalación nueva: los catálogos CSV (`municipios_dane.csv`,
   `catalogo_productos.csv`, etc.) se importan una vez con phpMyAdmin
   (pestaña Importar, formato CSV, elige la tabla destino) o con
   `php database/importar_productos_csv.php <ruta_csv>` si tienes acceso SSH
   con PHP. Si vienes de la app PHP, esto ya está poblado — sáltalo.

---

## 2. Importa el repo desde GitHub (un solo deploy para todo)

Hostinger ofrece dos maneras distintas de desplegar Node — cuál ves depende
de tu plan/cuenta:

- **Flujo nuevo tipo "Import from GitHub"** (el que probablemente tienes):
  una pantalla de una sola app con **Rama**, **Versión de Node**,
  **Directorio raíz**, **Comando de compilación / Directorio de salida /
  Archivo de entrada**, y **Variables de entorno**. Es del estilo
  Vercel/Netlify: un repo → un proceso Node.
- **Flujo clásico de hPanel** (`Avanzado → Git` + `Node.js` por separado):
  el de la app PHP original.

Esta guía usa el flujo nuevo porque es monorepo-friendly con un solo truco:
como `backend/` y `frontend/` son dos paquetes npm separados, y el cliente
HTTP del frontend (`frontend/src/lib/api.ts`) **siempre llama a rutas
relativas `/api/...` del mismo origen** (no hay forma de apuntar a otro
host sin tocar código), la solución más simple es que **el propio backend
Express sirva también el frontend ya compilado** — así todo queda en un
solo proceso, un solo dominio, cero problemas de CORS. Esto ya está resuelto
en el código (`backend/src/app.ts` sirve `frontend/dist/` estático + hace
fallback a `index.html` para las rutas de React Router, si esa carpeta
existe en el build).

Al conectar el repo (`https://github.com/grachos/TMS-TechCol`, rama `main`),
configura:

| Campo | Valor |
|---|---|
| **Directorio raíz** | `.` (la raíz del repo, **no** `backend`) |
| **Comando de compilación** | `npm run build` (el de la raíz — compila backend Y frontend en un solo paso: `npm --prefix backend run build && npm --prefix frontend run build`) |
| **Gestor de paquetes** | `npm` |
| **Directorio de salida** | `backend/dist` |
| **Archivo de entrada** | `backend/dist/server.js` |
| **Versión de Node** | 20.x (el backend requiere ≥ 20) |

> Ojo con el **Directorio de salida** y el **Archivo de entrada**: como el
> directorio raíz es `.` (todo el repo), las rutas son relativas a la raíz,
> no a `backend/` — por eso llevan el prefijo `backend/`. Si los dejas como
> `dist` y `dist/server.js` a secas, el deploy falla porque esos paths no
> existen en la raíz del repo.

---

## 3. Variables de entorno

En la sección **"Variables de entorno"** de esa misma pantalla, agrega:

```env
APP_ENV=produccion
APP_DEBUG=false
CORS_ORIGINS=*                 # no hace falta restringirlo — front y API comparten origen

JWT_SECRET=<genera-uno-largo-y-aleatorio>   # OBLIGATORIO, 32+ caracteres (ver nota abajo)
JWT_EXPIRES=8h

# --- Seguridad de la parte pública (todas opcionales) ---
# Detrás de cuántos proxies está la app (Hostinger pone uno). Con 0 se ignora X-Forwarded-For.
# Sirve para leer la IP REAL del visitante: los límites por IP y la auditoría dependen de esto.
TRUST_PROXY=1
# Content-Security-Policy: report (por defecto, solo anota en la consola del navegador), enforce (bloquea) u off.
CSP_MODO=report
# Límites del login en 15 min: fallos por cuenta, fallos por IP, peticiones totales por IP.
AUTH_CUENTA_FALLOS_MAX=5
AUTH_IP_FALLOS_MAX=20
AUTH_IP_TOTAL_MAX=60

# --- Soporte: propietario único (ver docs/SOPORTE.md) ---
# uuid de TU cuenta (SELECT uuid FROM staff_users WHERE email='...'). Una por sitio. Sin esto, o si no es válida, el
# módulo de soporte queda DENEGADO para todos. No lo publiques.
# PLATFORM_OWNER_UUID=

# --- Soporte: identidad del sitio y versión desplegada (OPCIONALES; ver docs/SOPORTE.md) ---
# Cada incidente que registra el módulo de soporte guarda de QUÉ SITIO viene y QUÉ VERSIÓN estaba desplegada.
#
# SITE_ID = nombre corto y único de ESTE sitio (cada sitio tiene su base y sus incidentes; nunca se mezclan).
#   Ejemplo: trading-solucion  (usa letras, números y guiones; máximo 80 caracteres).
#   Si no la pones, se usa el dominio de APP_URL (por ejemplo tmslight.techcol-service.cc), que normalmente basta.
#   Ponla solo si dos sitios compartieran dominio o quieres un nombre más legible.
# SITE_ID=trading-solucion
#
# APP_COMMIT = commit desplegado. Al compilar, el build intenta escribir dist/build-info.json con el commit (usa `git`);
#   si en ese entorno no hay git, la versión queda como "desconocida" (no se adivina). Después del primer despliegue,
#   abre un incidente y mira su versión: si es "desconocida", ponla a mano con el hash del commit desplegado (el log del
#   build de Hostinger lo muestra: "Checked out commit xxxxxxx") y actualízala en cada despliegue.
# APP_COMMIT=

# --- Recuperar contraseña por correo ("Olvidé mi contraseña") ---
# Dirección pública del sitio, con https y sin barra final. El enlace del correo se arma con ESTO
# (no con el encabezado Host de la petición, que un atacante podría falsear).
APP_URL=https://tu-dominio.com
# Buzón desde el que se envía (en Hostinger: crea un buzón, p. ej. no-responder@tu-dominio.com, y usa
# su servidor SMTP: smtp.hostinger.com, puerto 465).
SMTP_HOST=smtp.hostinger.com
SMTP_PORT=465
SMTP_USER=no-responder@tu-dominio.com
SMTP_PASS=<contraseña del buzón; solo aquí, nunca en el repositorio ni en el chat>
SMTP_FROM="Konekto <no-responder@tu-dominio.com>"
# Opcional: adonde llegan las respuestas de los usuarios (si no se define, el correo no lleva Reply-To).
# SMTP_REPLY_TO=soporte@tu-dominio.com
# Para que NO caiga en spam: usa el MISMO dominio en SMTP_FROM, en APP_URL y en el buzón (SMTP_USER), y deja
# SPF + DKIM + DMARC en el DNS de ese dominio. Un dominio nuevo suele ir a spam al principio: marca los primeros
# correos como "No es spam" y mejora con el uso.
# Sin SMTP_* o sin APP_URL el sistema responde igual ("si el correo existe, te enviamos un enlace")
# pero NO envía nada, y lo avisa en el log del servidor. Cada usuario necesita un correo REAL en
# Usuarios (un correo como admin@tms.local no recibe nada).

# --- Cloudflare Turnstile en el login (captcha) ---
# APAGADO por defecto: un sitio sin claves no queda bloqueado al recibir el código.
# También protege "Olvidé mi contraseña" y "Restablecer" (acciones forgot_password / reset_password).
# Para activarlo, en ESTE ORDEN: (1) crea el widget en Cloudflare con el dominio del sitio,
# (2) pon estas 4 variables, (3) reinicia la app y prueba el ingreso.
TURNSTILE_SITE_KEY=<clave pública del widget>
TURNSTILE_SECRET_KEY=<clave SECRETA del widget; solo aquí, nunca en el repositorio ni en el chat>
TURNSTILE_ALLOWED_HOSTNAMES=<dominio de ESTE sitio, sin https://, p. ej. tmslight.techcol-service.cc>
TURNSTILE_ENFORCE=true
# PALANCA DE EMERGENCIA: si por cualquier motivo nadie puede ingresar, pon TURNSTILE_ENFORCE=false
# y reinicia la app; el login deja de exigir el reto y la pantalla no muestra el widget.
# Con ENFORCE=true el servidor FALLA CERRADO: sin clave secreta o sin dominios rechaza todo.

DB_HOST=localhost
DB_PORT=3306
DB_NAME=uXXXX_light_tms
DB_USER=uXXXX_usuario
DB_PASS=tu_clave
DB_CHARSET=utf8mb4

RNDC_AMBIENTE=pruebas           # cámbialo a produccion solo cuando ya probaste todo
RNDC_HOST_OVERRIDE=
RNDC_TIMEOUT=30

COLA_MAX_INTENTOS=10
COLA_MINUTOS_REINTENTO=15
COLA_MINUTOS_ENVIANDO_ATASCADO=10      # opcional: minutos en "enviando" tras los que se recupera una fila interrumpida
COLA_ENVIO_HABILITADO=false     # true SOLO cuando quieras enviar de verdad al RNDC

# --- Notificaciones push (Web Push, VAPID propio, sin servicio de terceros) ---
# Genera el par de llaves UNA vez con: npx --prefix backend web-push generate-vapid-keys
# Si las dejas vacías, el push queda deshabilitado (no rompe nada más).
VAPID_PUBLIC_KEY=<llave-publica>
VAPID_PRIVATE_KEY=<llave-privada>
VAPID_SUBJECT=mailto:tu-correo@dominio.com
PUSH_WATCH_MS=60000             # cada cuánto revisa los contadores para notificar
```

> **`JWT_SECRET` es obligatorio.** Desde esta versión la API **no arranca** si
> `JWT_SECRET` falta, es el valor por defecto (`change-me-in-production`, público en
> el repositorio) o tiene menos de 32 caracteres: con ese valor cualquiera podría
> firmar un token de administrador. Genéralo con
> `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`
> y agrégalo en hPanel → Node.js → Variables de entorno **antes** de desplegar.
> Al cambiarlo se cierran todas las sesiones abiertas (cada usuario vuelve a iniciar sesión).


No definas `PORT` — Hostinger asigna uno y lo inyecta él solo; el backend ya
lo lee de `process.env.PORT` vía `config()`.

> **Push requiere HTTPS válido.** Los service workers y la Push API solo
> funcionan en un "secure context": el certificado SSL del dominio debe estar
> activo y la app servirse por `https://`. Si el navegador marca el sitio como
> "no seguro", el push falla en silencio. Además, abre siempre la app por el
> **host que cubre el certificado** (sin `www.` si tu certificado es para el
> dominio pelado) — el backend ya redirige `www.*` al host base por esto.

> **Usuario/contraseña RNDC y NIT ya no van aquí.** Se editan desde el
> formulario **Empresa** (solo admin) una vez que la app está corriendo —
> el NIT es el mismo campo "NIT \*" del formulario, y las credenciales se
> guardan en `maestro_empresa` (columnas `rndc_username`/`rndc_password`,
> migración v33). Solo hace falta importar esa migración y luego cargar los
> datos desde la UI — no hay nada que poner en variables de entorno.

Finaliza/guarda y lanza el deploy (o "Redesplegar" si ya existía).

---

## 4. Primer arranque: crear el admin

En una instalación nueva (tabla `staff_users` vacía) el primer administrador
se crea **solo, al arrancar la app**, con estas variables de entorno:

```
SEED_ADMIN_EMAIL=admin@tudominio.com
SEED_ADMIN_PASSWORD=<al menos 12 caracteres>
SEED_ADMIN_NOMBRE=Admin            # opcional
```

- Solo actúa si **no hay ningún usuario**: en los reinicios siguientes no hace
  nada, y nunca cambia ni reactiva a un usuario existente.
- El log de arranque dice `[auth] Se creó el primer administrador (...)`. Si
  falta algo, lo explica ahí mismo (variables vacías, contraseña corta, o
  falta importar `schema.sql`); la API arranca igual.
- Después de entrar: cambia la contraseña en **Usuarios** y borra
  `SEED_ADMIN_PASSWORD` de las variables de entorno.

Si tienes terminal (SSH), también sigue disponible el script, que además
sirve para restablecer la contraseña de un admin existente:

```bash
cd <ruta-de-tu-app>          # la misma que "Directorio raíz" del deploy
npm --prefix backend run seed:admin -- --email admin@tudominio.com --password "CAMBIA-ESTO" --nombre "Admin"
```

Prueba:
- `https://<tu-dominio-asignado>/api/health` → `{"ok":true,"database":{"ok":true}}`
- `https://<tu-dominio-asignado>/` → la pantalla de login de React (ya no
  "Cannot GET /").

---

## 5. Cron del worker de reintento

Reemplaza al cron de `legacy/cron/retry_worker.php`. hPanel → **Avanzado →
Trabajos Cron**, cada 15 minutos:

```
*/15 * * * * cd <ruta-de-tu-app> && <ruta-al-node> backend/dist/queue/worker.js >> <ruta-a-tus-logs>/tms-worker.log 2>&1
```

La ruta exacta del binario `node` para ese Node.js version la ves en la
pantalla de la app (o en `Avanzado → SSH Access`, corriendo `which node`).

---

## 6. (Opcional) Chatbot de datos con OpenRouter

El asistente de datos (widget flotante) responde preguntas en lenguaje
natural sobre la BD ("¿cuántos manifiestos he creado?", "¿qué falta por
cumplir?"). Usa **OpenRouter** (API compatible con OpenAI, con modelos
gratuitos) — no requiere instalar ningún SDK. Está **deshabilitado por
defecto**; para activarlo:

1. Crea una cuenta en <https://openrouter.ai> y genera una API key.
2. En las **Variables de entorno** de la app Node agrega:
   ```env
   CHAT_HABILITADO=true
   OPENROUTER_API_KEY=sk-or-...
   OPENROUTER_MODEL=deepseek/deepseek-chat-v3-0324:free   # gratis, con tool-calling
   ```
3. **Muy recomendado — usuario de BD de solo lectura** (mínimo privilegio).
   El chat **ya no escribe SQL libre**: usa herramientas tipadas con consultas fijas
   (ver `docs/SOPORTE.md`, fase 3a), filtradas por los permisos de quien pregunta, y su
   conexión arranca en modo **solo lectura**. Aun así, un usuario de BD con SELECT solo
   sobre las tablas que lee el chat es la última barrera. En phpMyAdmin → SQL (reemplaza el
   nombre de la BD y la clave; la lista sale del registro de herramientas y una prueba
   comprueba que no se desactualice):
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
   -- NO concedas staff_users, maestro_empresa, auditoria ni las tablas de incidentes.
   ```
   Luego, en variables de entorno (la base de datos de hosting antepone un prefijo al
   usuario, p. ej. `u123456789_tms_ro`: usa el nombre completo que muestre hPanel):
   ```env
   DB_READONLY_USER=<usuario_de_solo_lectura>
   DB_READONLY_PASS=<su contraseña; solo aquí, nunca en el repositorio ni en el chat>
   ```
   **En Hostinger compartido esto NO es posible** (`CREATE USER` responde #1227): ahí omite `DB_READONLY_*` y pon
   `DB_READONLY_ACEPTADO=true` para dejar constancia del riesgo aceptado (ver `docs/SOPORTE.md`).

   Si omites `DB_READONLY_*`, el chat usa el usuario principal con la sesión en modo
   **solo lectura** y al arrancar el log avisa (`[chat] ATENCIÓN…`): funciona y no puede
   escribir, pero pierdes la última barrera de mínimo privilegio.

Verificación: al entrar a la app aparece un botón de chat abajo a la derecha;
`GET /api/chat/estado` responde `{"habilitado":true}`.

---

## 7. Checklist post-despliegue

- [ ] `GET /api/health` responde `{"ok":true,"database":{"ok":true}}`.
- [ ] `/` sirve la pantalla de login de React (no "Cannot GET /").
- [ ] Login con el primer administrador (creado al arrancar o con `seed:admin`) funciona.
- [ ] `COLA_ENVIO_HABILITADO=false` mientras pruebas — la cola arma y
      previsualiza el XML pero no envía nada real al RNDC.
- [ ] `RNDC_AMBIENTE=pruebas` hasta confirmar que todo el flujo (solicitud →
      despacho → cola → cumplido) funciona contra el ambiente de pruebas del
      Ministerio.
- [ ] Solo entonces: `RNDC_AMBIENTE=produccion` + `COLA_ENVIO_HABILITADO=true`,
      y reinicia la app Node para que tome el cambio.
- [ ] El cron del worker corre cada 15 min (revisa el log).
- [ ] PDFs: si no hay Chrome instalado, confirma que cae al HTML imprimible
      sin romper la descarga (comportamiento esperado, no error).
- [ ] Push (opcional): con SSL válido y `VAPID_*` puestas, el botón de campana
      en la cabecera pide permiso y suscribe el dispositivo; `GET /api/push/public-key`
      responde `{"habilitado":true,...}`.

---

## 8. Dependencias de desarrollo y alertas del escáner

El escáner de Hostinger (que refleja el análisis de dependencias de **GitHub**)
va a marcar de vez en cuando paquetes como `vitest`, `vite` o `esbuild`. Antes
de correr a "parchear", ten claro esto:

**Esos paquetes son herramientas de desarrollo/compilación, no de ejecución.**
Están en `devDependencies`. La app que corre en el servidor es el `backend/dist/`
ya compilado + las `dependencies` de runtime (express, mysql2, web-push, etc.).
`vitest`/`vite`/`esbuild` **nunca se ejecutan en producción**, así que su
superficie de ataque real en tu servidor es nula aunque figuren en el árbol.

**Por qué no siempre se pueden "subir de versión":** el build necesita esas
dev-deps (`tsc`, `vite`, `tsx`), así que no puedes saltártelas al compilar. Y
forzar una versión más nueva de una dep transitiva puede romper el build — p.ej.
forzar `esbuild@0.28` bajo `vite@6` rompe `vite build` (Vite 6 está atado al
rango `0.25.x`). En esos casos, subir la versión cuesta más de lo que vale para
una herramienta que ni corre en producción.

**Qué hacer, en orden de preferencia:**

1. **No dejar las dev-deps instaladas en el servidor que corre.** Idealmente,
   tras compilar, deja solo las deps de runtime. Si tu panel te permite un paso
   después del build (o tienes SSH), corre:
   ```bash
   npm prune --omit=dev
   ```
   Esto borra `vitest`/`vite`/`esbuild`/`typescript`/`tsx` del `node_modules`
   del servidor. Ojo: **no** uses `npm ci --omit=dev` como reemplazo del install
   del pipeline, porque entonces el `npm run build` fallaría (faltarían `tsc` y
   `vite`). El orden correcto es: install completo → build → `prune --omit=dev`.

2. **El escáner de GitHub lee el `package-lock.json` del repo, no tu servidor.**
   Por eso `--omit=dev` reduce el riesgo real (lo que corre) pero **puede seguir
   mostrando la alerta**, porque el lockfile sigue listando la dev-dep. Para
   silenciar esas alertas concretas: márcalas como *descartadas / falso positivo*
   en el panel, o configura Dependabot para ignorar `devDependencies`.

3. **Verifica siempre el "Withdrawn Advisory".** Si la propia alerta dice
   *"This advisory has been withdrawn…"*, GitHub la retiró: `npm audit` no la
   cuenta y no hay nada que parchear (le pasó al aviso de `esbuild`
   GHSA-gv7w-rqvm-qjhr, que además era solo del runtime **Deno**, no Node).

Regla práctica: corre `npm audit` (dentro de `backend/`) — si dice
`found 0 vulnerabilities`, estás bien aunque el panel muestre ruido de dev-deps.

## Resumen del flujo diario

```
editar en local  →  git add/commit  →  git push origin main
                                            │
                                            ▼
                Hostinger detecta el push y corre el pipeline solo:
                git pull → npm install (raíz) → npm run build
                (backend + frontend) → reinicia el proceso Node
```

Con el flujo "Import from GitHub", el build y el reinicio **son
automáticos** en cada push a `main` — a diferencia del hPanel clásico
(Git + Node.js App por separado), donde sí haría falta un paso manual de
`npm run build` + reinicio. Si tu deploy no se dispara solo, revisa que el
webhook/auto-deploy esté activado en la pantalla de la app.

> Si el push trae **migraciones nuevas** (ver §1) o cambia **variables de
> entorno** (ver §3), el auto-deploy **no** las aplica: impórtalas/edítalas a
> mano. Y para no arrastrar herramientas de desarrollo al servidor, considera
> el `npm prune --omit=dev` de la **§8**.
