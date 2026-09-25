# Integración con el RNDC

Documentación de la capa de integración con el web service del **RNDC**
(Registro Nacional de Despachos de Carga), Ministerio de Transporte de Colombia.

## Cómo funciona

El RNDC expone una operación **SOAP 1.1**: `AtenderMensajeRNDC`, que recibe un
parámetro string `<Request>` con un **XML interno escapado**:

```xml
<root>
  <acceso><username>..</username><password>..</password></acceso>
  <solicitud><tipo>1</tipo><procesoid>11</procesoid></solicitud>
  <variables>
    <NOMVARIABLE>valor</NOMVARIABLE>
    ...
  </variables>
</root>
```

- `tipo` = tipo de operación (ver tabla).
- `procesoid` = número de proceso (ver abajo).
- La respuesta trae `<ingresoid>` (éxito) o `<ErrorMSG>` / `<error>` (rechazo).

### Tipos de operación (`<solicitud><tipo>`)

| tipo | Operación | Constante en el cliente |
|---|---|---|
| 1 | Registrar información en procesos y maestros | `TIPO_INGRESAR` |
| 2 | Consultar registros de maestros | `TIPO_CONSULTAR_MAESTRO` |
| 3 | Consultar documentos/registros de un proceso | `TIPO_CONSULTAR_PROCESO` |
| 4 | Consulta para la Policía | — |

> Para consultar un manifiesto/remesa usa **tipo 3** con el `procesoid` del documento.

**Headers:** `Content-Type: text/xml; charset=ISO-8859-1` y
`SOAPAction: urn:BPMServicesIntf-IBPMServices#AtenderMensajeRNDC`.
Ruta del servicio: `/soap/IBPMServices`.

> **Encoding:** el RNDC *declara* ISO-8859-1 pero en la práctica **responde en UTF-8**.
> El cliente lo detecta y solo convierte si los bytes no son UTF-8 válido
> (evita la doble codificación de acentos).

## Servidores (balanceo de carga oficial)

Tabla oficial del Ministerio ("Balanceo de Carga a los Servidores del RNDC"),
2026-07-05:

| Servidor | Host:puerto (SOAP) | Procesos | Estado verificado |
|---|---|---|---|
| Pruebas | `rndc.mintransporte.gov.co:8080` | todos (ambiente prueba) | timeout (ver nota IP abajo) |
| Mantenimiento | `rndc2.mintransporte.gov.co:8080` | (fallback si A está en mantenimiento) | no probado |
| Otros | `rndcws.mintransporte.gov.co:8080` | 1,2,5,6,7,8,9,11,12,17,28,29,32,33,34,38,41,44,45,46,54,60,67,68,73,75,79,81,82,83,86,90,91,92,93,96,103,106,… | ✅ responde |
| Expedir | `rndcws2.mintransporte.gov.co:8080` | **3 (Remesa), 4 (Manifiesto)** | ✅ responde |
| Consultas | `plc.mintransporte.gov.co:8080` | 26, 27, 48, 55 | ✅ verificado (consulta real OK) |

> ⚠️ **`rndc.mintransporte.gov.co` (el host oficial de "Ambiente pruebas") no
> respondió (timeout) ni siquiera desde una IP que sí alcanza `rndcws`/`rndcws2`/
> `plc` sin problema** — a diferencia de esos tres, parece requerir autorización
> previa independientemente de la geografía. El viejo alias
> `rndcpruebas.mintransporte.gov.co:8080` sigue respondiendo (WSDL genérico) pero
> puede no ser el endpoint real de pruebas vigente.
>
> Las IP extranjeras están **bloqueadas** (salvo EE. UU.). Para acceder desde una IP
> extranjera hay que solicitarlo al Grupo de Logística del Ministerio. La IP del
> servidor Hostinger debe poder llegar a estos hosts — confirmarla con
> `GET /api/diagnostico/ip-saliente` (temporal, ver `backend/src/app.ts`).
>
> Además del ambiente programático hay **wstest** (sin programar):
> `https://rndc.mintransporte.gov.co/wstest/default.aspx` (y default2/default3 para
> apuntar a rndcws2 / plc). También existe un endpoint REST en `:8081`
> (`inside.mintransporte.gov.co:443` HTTPS es otro que este cliente no usa) —
> el cliente sí lo usa para una cosa puntual: consultar el PDF de un
> manifiesto ya radicado (ver [Consulta de PDF por REST](#consulta-de-pdf-por-rest) abajo).

El cliente resuelve el endpoint automáticamente con `RNDC_AMBIENTE`
(`pruebas` | `produccion`) y enruta por `procesoid`. Se puede forzar con
`RNDC_HOST_OVERRIDE`.

## Procesos clave para Light TMS

| procesoid | Nombre | Campos | Uso |
|---|---|---|---|
| 11 | Tercero | 20 | Registrar remitente/destinatario/propietario/conductor |
| 12 | Vehículo | 30 | Registrar el vehículo |
| **3** | **Remesa Terrestre de Carga** | 60 | Documento de la carga |
| **4** | **Manifiesto de Carga** | 46 | Documento del viaje |

Orden de envío: **Terceros → Vehículo → Remesa → Manifiesto**.

### `retencionFuenteManifiesto` — excepción por Régimen Simple

`<retencionFuenteManifiesto>` (manifiesto, procesoid 4) y `RETENCIONFUENTEMANIFIESTO`
(cumplido de manifiesto, procesoid 6) normalmente llevan el 1% del flete
(`manifiesto.retencion_fuente`, calculado al capturar la solicitud). Pero el
**titular del manifiesto** (`titular_tipo_id`/`titular_num_id` — el tenedor
del vehículo, quien recibe el pago del flete) puede estar en **Régimen Simple
de Tributación**, y esos contribuyentes no son sujetos de retención en la
fuente ordinaria (Art. 911 E.T.). El RNDC igual exige un valor no vacío en
esa etiqueta, así que la convención es enviar el literal `1` en vez del
cálculo cuando el tercero titular tiene `regimen_simple = 'S'` (columna
`tercero.regimen_simple`, editable en el formulario de Tercero).

Implementado en `retencionFuenteManifiesto()` (`backend/src/modules/cola/cola.repo.ts`),
usado tanto por `payloadManifiesto()` como por `payloadCumplidoManifiesto()`
(este último no enviaba la etiqueta en absoluto antes de este cambio). El
formulario de Solicitud ya no pide/muestra este valor manualmente — es
enteramente calculado en el backend, igual que ICA y FOPAT.

### `CONTENEDORSERIAL` — obligatorio en Contenedor Cargado/Vacío

La Remesa (procesoid 3) exige `<CONTENEDORSERIAL>` (serial ISO 6346 de 11
caracteres, p.ej. `SMLU7924873`) cuando `codOperacionTransporte` es
**C** (Contenedor Cargado) o **V** (Contenedor Vacío). Se captura una vez en
el formulario de Solicitud (`solicitud_servicio.contenedor_serial`, migración
v46) — igual que `dueno_poliza` — y se copia a cada remesa sembrada al
confirmar el despacho. Validado en ambos lados: `validarContenedorSerial()`
(`backend/src/util/validaciones.ts`, servidor) y un aviso equivalente en
`SolicitudForm.tsx` (cliente) que bloquea el guardado si falta o no tiene
exactamente 11 caracteres.

> **Nota aparte, no relacionada con este cambio:** `payloadRemesa()` también
> envía `pesoContenedorVacio` **hardcoded a `'2100'` para toda remesa, no solo
> las de contenedor** — vale la pena revisarlo por separado.

El diccionario completo de variables oficiales está en:
- `docs/diccionario_rndc.csv` (fuente, UTF-8)
- `src/Rndc/Diccionario.php` (generado, usado por el código)

Para regenerar el PHP desde el CSV:

```bash
iconv -f ISO-8859-1 -t UTF-8 "Maestro_Diccionario de Datos_RNDC.csv" \
  | awk -f tools/_gen_diccionario.awk > src/Rndc/Diccionario.php
```

## Uso del cliente (PHP)

```php
require_once __DIR__ . '/src/Rndc/RndcClient.php';

$rndc = RndcClient::desdeConfig();          // usa el .env
$resp = $rndc->ingresar(11, [               // proceso 11 = Tercero
    'NUMNITEMPRESATRANSPORTE' => '900000000',
    'CODTIPOIDTERCERO'        => 'N',
    'NUMIDTERCERO'            => '12345678',
    'NOMIDTERCERO'            => 'ACME SAS',
    // ...
]);

if ($resp->ok) {
    echo "ingresoid: {$resp->ingresoId}";
} else {
    echo "Error: {$resp->error}";
}
```

Probar desde la terminal:

```bash
php tools/probar_rndc.php                  # muestra el XML, sin enviar
php tools/probar_rndc.php --enviar         # envía (usa el .env)
php tools/probar_rndc.php --enviar --host="http://rndcws2.mintransporte.gov.co:8080"
```

## Consultas (tipo 3)

```php
$rndc = RndcClient::desdeConfig();
$resp = $rndc->consultar(
    4,                                                  // proceso 4 = Manifiesto
    ['NUMMANIFIESTOCARGA','NUMPLACA','VALORFLETEPACTADOVIAJE'],  // campos a traer
    ['NUMNITEMPRESATRANSPORTE' => $nit, 'NUMMANIFIESTOCARGA' => $num], // filtro <documento>
);
foreach ($resp->datos as $fila) {
    echo $fila['numplaca'];
}
```

- `<documento>` lleva los filtros exactos (sub-elementos).
- `<documentorango>` (4º parámetro) lleva rangos con comillas simples,
  p.ej. `['iniFECHAING' => "'2026/01/01'", 'finFECHAING' => "'2026/12/31'"]`.
- `RndcRespuesta::$datos` es una lista de filas (una por `<documento>` del resultado).

**Verificado** (2026-06-18): consulta del manifiesto `0102002560` devolvió placa
`KSO581`, flete `2198000`, ingresoid `119855230`.

## Consulta de PDF por REST

A diferencia de todo lo anterior (SOAP), el RNDC expone un webservice **REST**
aparte (sección 9 de la guía) para traer el PDF ya generado de un proceso
radicado. Endpoint:

```
POST http://plc.mintransporte.gov.co:8081/Rest/rndc
Content-Type: application/json
```

Cuerpo:

```json
{
  "acceso": { "usuario": "xxxxxxx@1111", "clave": "11111" },
  "solicitud": { "tipo": "21", "procesoid": "4" },
  "documento": {
    "IngresoId": "111111",
    "InformeId": "1",
    "formato": "Json",
    "Base64": "S"
  }
}
```

| Campo | Significado |
|---|---|
| `tipo` | `21` — fijo, "consultar el PDF de un proceso" (no es ninguno de los tipos SOAP de arriba). |
| `procesoid` | `4` — el mismo procesoid del Manifiesto que usa el resto del cliente. |
| `IngresoId` | El **radicado** que el RNDC asignó al aceptar el documento (`manifiesto.rndc_ingreso_id`), no el número de manifiesto interno. |
| `InformeId` | `1` (único valor documentado hoy; la guía deja la puerta abierta a otros diseños de PDF en el futuro). |
| `formato` | `"Json"` — pide tecnología REST en vez de SOAP. |
| `Base64` | `"S"` para recibir el PDF como texto base64 (recomendado); `"N"` para el PDF crudo. Este cliente siempre pide `"S"`. |

Las credenciales (`usuario`/`clave`) son las mismas de `maestro_empresa`
(`rndc_username`/`rndc_password`) que usa el resto del cliente — no hay
variables de entorno nuevas para esto.

> **El esquema del JSON de respuesta no está documentado** — la guía solo
> especifica el REQUEST. `RndcClient.consultarPdfManifiesto()` busca el PDF en
> base64 (o un mensaje de error) bajo varias variantes de nombre de campo
> plausibles en vez de asumir una forma exacta, y siempre conserva el JSON
> crudo para diagnosticar si el RNDC responde con un campo no contemplado.
> Ajusta `interpretarRespuestaPdf()` en `backend/src/rndc/RndcClient.ts` en
> cuanto se vea una respuesta real.

Uso (TypeScript):

```ts
const rndc = await RndcClient.desdeConfig();
const resultado = await rndc.consultarPdfManifiesto(manifiesto.rndc_ingreso_id);
if (resultado.ok) {
  // resultado.pdf es un Buffer con los bytes del PDF.
} else {
  console.error(resultado.error, resultado.crudo);
}
```

Expuesto en la API como `GET /api/manifiesto/:id/pdf-rndc` (requiere que el
manifiesto ya tenga `rndc_ingreso_id`, es decir que el RNDC ya lo haya
aceptado) — ver `backend/src/modules/pdf/pdf.routes.ts`. Distinto de
`GET /api/manifiesto/:id/pdf`, que renderiza nuestra propia réplica del
formato oficial sin llamar al RNDC.
