/**
 * Light TMS - Motor de reglas del diagnóstico (PURO: sin base de datos, sin red, sin IA).
 *
 * Principios:
 *  - "confirmada" exige haber COMPROBADO el estado actual del sistema (columna ausente AHORA, variable sin definir AHORA, la cola con
 *    fallas de conexión registradas). Que el texto del error "se parezca" nunca basta. La confianza la decide ESTE código; la IA
 *    (fase 3c) nunca la fija.
 *  - Un problema de CÓDIGO nunca se confirma aquí: confirmarlo exige reproducirlo (fase 4). Aquí solo se ubica.
 *  - Una caída del RNDC, una migración pendiente, la configuración y la infraestructura NO se resuelven con código
 *    (`corregibleConCodigo = false`): ocultar el síntoma sería peor que el error.
 *  - Hechos para el PROPIETARIO (técnicos: archivo, migración, variable, código RNDC) separados del BORRADOR PÚBLICO, que sale de
 *    plantillas FIJAS por categoría. La evidencia no se interpola jamás en el borrador: el usuario no ve código, configuración
 *    ni registros.
 */

import type { TipoIncidente } from '../incidentes/clasificar.js';

export const VERSION_REGLAS = '1';

export type Confianza = 'confirmada' | 'probable' | 'insuficiente';

export interface Hecho {
  texto: string;
  fuente: string;
  /** Cuándo se observó (ISO): un problema que ya se despejó al diagnosticar no cuenta como "resuelto". */
  observadoEn: string;
}

export interface BorradorPublico {
  hecho: string | null;
  posibleCausa: string | null;
  causaConfirmada: string | null;
  accionTemporal: string | null;
  estadoCorreccion: string | null;
}

export interface Referencia {
  tipo: 'doc' | 'migracion' | 'catalogo_rndc' | 'codigo' | 'config';
  valor: string;
}

export interface Diagnostico {
  categoria: TipoIncidente;
  confianza: Confianza;
  /** true/false = la regla opina; null = sin opinión (no cambia nada). Un diagnóstico solo puede BAJAR `corregible`, nunca subirlo. */
  corregibleConCodigo: boolean | null;
  resumen: string;
  hechos: Hecho[];
  posibleCausa: string | null;
  causaConfirmada: string | null;
  accionTemporal: string | null;
  siguientePaso: string;
  referencias: Referencia[];
  borradorPublico: BorradorPublico;
  versionReglas: string;
}

export interface EntradaDiagnostico {
  incidente: {
    id: number; tipo: TipoIncidente | string; origen: string; operacion: string | null; codigo: string | null; titulo: string;
    ocurrencias: number; primera_vez: string; ultima_vez: string; version_despliegue: string | null; corregible: boolean; estado: string;
  };
  versionActual: string;
  /** Evidencia ya SANITIZADA. */
  evidencia: { mensaje: string; pila: string; status?: number; ruta?: string } | null;
  observado: string;
  migracion?: { objeto: { tabla: string; columna?: string } | null; ausenteAhora: boolean | null; migracion: string | null; indiceDisponible: boolean };
  configuracion?: { variables: { nombre: string; definida: boolean; valida: boolean | null }[] };
  rndc?: { errores24h: number; pendientes: number; conexion24h: number; codigos: { codigo: string; mensaje: string | null; solucion: string | null }[] };
  infraestructura?: { baseDeDatosAhora: boolean };
  codigo?: { primeraVersion: string | null; versionesVistas: number; mismoArchivo: number };
  reportes?: { pantalla: string | null; cercanos: { id: number; tipo: string; titulo: string }[] };
}

// ---------------------------------------------------------------- borradores públicos: plantillas FIJAS

const REVISA = 'Antes de repetir la operación, revisa en la pantalla si lo que hiciste quedó registrado.';

/** Frases por categoría. Nada de aquí cambia con la evidencia; solo `causaConfirmada` aparece si la confianza es "confirmada". */
const PLANTILLAS: Record<TipoIncidente, { hecho: string; posible: string; confirmada: string; accion: string; estado: string }> = {
  migracion: {
    hecho: 'Una función de la aplicación no pudo completarse.',
    posible: 'Una actualización del sistema todavía no se terminó de aplicar en este sitio.',
    confirmada: 'Falta completar una actualización de la base de datos de este sitio.',
    accion: `Espera a que el equipo termine la actualización. ${REVISA}`,
    estado: 'El equipo técnico debe completar la actualización; no requiere cambios en la aplicación.',
  },
  rndc: {
    hecho: 'Los envíos al RNDC (Ministerio de Transporte) están presentando fallas.',
    posible: 'El servicio del RNDC puede estar caído o estar rechazando algunos documentos.',
    confirmada: 'El servicio del RNDC está presentando fallas de conexión.',
    accion: 'El sistema reintenta los envíos pendientes según su configuración. Revisa su estado en la Cola de envíos antes de volver a crear algo.',
    estado: 'No requiere cambios en la aplicación: depende del servicio del RNDC.',
  },
  configuracion: {
    hecho: 'Una función de la aplicación no pudo completarse.',
    posible: 'Falta ajustar una configuración de este sitio.',
    confirmada: 'Una configuración de este sitio está incompleta o es inválida.',
    accion: `Evita repetir la operación hasta que el equipo ajuste la configuración. ${REVISA}`,
    estado: 'El equipo técnico debe ajustar la configuración; no requiere cambios en la aplicación.',
  },
  infraestructura: {
    hecho: 'La aplicación tuvo una interrupción del servicio.',
    posible: 'El servidor o la base de datos tuvo una falla temporal.',
    confirmada: 'El servidor o la base de datos tuvo una falla.',
    accion: `Espera unos minutos. ${REVISA}`,
    estado: 'Se revisa la infraestructura; no requiere cambios en la aplicación.',
  },
  proveedor_ia: {
    hecho: 'El asistente de datos no estuvo disponible.',
    posible: 'El servicio de inteligencia artificial externo falló.',
    confirmada: 'El servicio de inteligencia artificial externo no está disponible.',
    accion: 'El resto de la aplicación no se ve afectado; consulta los datos directamente en cada pantalla.',
    estado: 'Depende de un proveedor externo; no requiere cambios en la aplicación.',
  },
  codigo: {
    hecho: 'Una pantalla o función falló de forma inesperada.',
    posible: 'Un error en la aplicación.',
    confirmada: 'Un error en la aplicación.', // no se usa: el código nunca se confirma aquí
    accion: REVISA,
    estado: 'El equipo técnico lo está analizando. Todavía no hay una corrección.',
  },
  datos: {
    hecho: 'Una operación no pudo completarse con los datos enviados.',
    posible: 'Algún dato está incompleto o no es válido.',
    confirmada: 'Algún dato está incompleto o no es válido.',
    accion: 'Revisa los datos que ingresaste e inténtalo de nuevo. ' + REVISA,
    estado: 'No requiere cambios en la aplicación.',
  },
  permisos: {
    hecho: 'Una operación no estuvo permitida para tu usuario.',
    posible: 'Tu usuario no tiene habilitada esa función.',
    confirmada: 'Tu usuario no tiene habilitada esa función.',
    accion: 'Pídele a un administrador que revise tus permisos.',
    estado: 'No requiere cambios en la aplicación.',
  },
  otro: {
    hecho: 'Recibimos tu reporte.',
    posible: 'Todavía no sabemos qué lo causó.',
    confirmada: 'Todavía no sabemos qué lo causó.',
    accion: REVISA,
    estado: 'El equipo técnico lo está revisando. Todavía no hay una corrección.',
  },
};

export function borradorPublicoDe(categoria: TipoIncidente, confianza: Confianza): BorradorPublico {
  const p = PLANTILLAS[categoria] ?? PLANTILLAS.otro;
  return {
    hecho: p.hecho,
    posibleCausa: confianza === 'confirmada' ? null : p.posible,
    // La causa confirmada SOLO existe si la regla la confirmó comprobando el estado actual; el código nunca se confirma aquí.
    causaConfirmada: confianza === 'confirmada' && categoria !== 'codigo' ? p.confirmada : null,
    accionTemporal: p.accion,
    estadoCorreccion: p.estado,
  };
}

// ---------------------------------------------------------------- reglas

type Parcial = Omit<Diagnostico, 'borradorPublico' | 'versionReglas'>;

const hecho = (e: EntradaDiagnostico, texto: string, fuente: string): Hecho => ({ texto, fuente, observadoEn: e.observado });

function reglaMigracion(e: EntradaDiagnostico): Parcial {
  const m = e.migracion;
  const hechos: Hecho[] = [hecho(e, `El error indica un objeto de la base de datos que no existe (${e.incidente.ocurrencias} ocurrencia(s)).`, 'evidencia del incidente')];
  const base: Parcial = {
    categoria: 'migracion', confianza: 'probable', corregibleConCodigo: false, resumen: 'Posible migración pendiente.', hechos, posibleCausa: 'Una migración de la base de datos no se ha corrido en este sitio.',
    causaConfirmada: null, accionTemporal: null, siguientePaso: 'Correr la migración en la base de ESTE sitio (acción manual en phpMyAdmin). No hay cambio de código que hacer: ocultar el error no lo resuelve.',
    referencias: [{ tipo: 'doc', valor: 'DEPLOY.md (lista de migraciones)' }],
  };
  if (!m || !m.objeto) {
    hechos.push(hecho(e, 'No se pudo identificar qué tabla o columna falta.', 'análisis del mensaje'));
    return { ...base, confianza: 'insuficiente', resumen: 'Parece una migración pendiente, pero no se identificó cuál.' };
  }
  const nombre = m.objeto.columna ? `${m.objeto.tabla}.${m.objeto.columna}` : m.objeto.tabla;
  hechos.push(hecho(e, `Objeto señalado: ${nombre}.`, 'análisis del mensaje'));
  if (!m.indiceDisponible) {
    hechos.push(hecho(e, 'No hay índice de migraciones en este servidor: no se puede decir cuál la crea.', 'índice de migraciones'));
    return { ...base, resumen: `Falta ${nombre} (no se pudo identificar la migración).` };
  }
  if (m.migracion) {
    hechos.push(hecho(e, `${nombre} lo crea ${m.migracion}.`, 'índice de migraciones (generado al compilar)'));
    base.referencias.push({ tipo: 'migracion', valor: m.migracion });
  } else hechos.push(hecho(e, `Ninguna migración del índice crea ${nombre}.`, 'índice de migraciones'));
  if (m.ausenteAhora === true) {
    hechos.push(hecho(e, `Comprobado AHORA en la base: ${nombre} NO existe.`, 'information_schema'));
    const cual = m.migracion === 'schema.sql' ? 'schema.sql (la instalación está incompleta)' : (m.migracion ?? 'la migración correspondiente');
    return {
      ...base, confianza: m.migracion ? 'confirmada' : 'probable', resumen: `Falta correr ${m.migracion ?? 'una migración'}: ${nombre} no existe.`,
      causaConfirmada: m.migracion ? `Falta correr ${cual} en esta base: ${nombre} no existe (comprobado en el momento del diagnóstico).` : null,
      siguientePaso: `Correr database/${m.migracion ?? '<migración>'} en la base de ESTE sitio (es repetible) y reiniciar la app. No hay cambio de código que hacer: ocultar el error no lo resuelve.`,
    };
  }
  if (m.ausenteAhora === false) {
    hechos.push(hecho(e, `Comprobado AHORA en la base: ${nombre} SÍ existe.`, 'information_schema'));
    return { ...base, resumen: `${nombre} existe ahora: la migración ya se corrió o el incidente es anterior.`, posibleCausa: 'La migración se corrió después del error.', siguientePaso: 'Vigilar si reaparece. Si reaparece con el objeto ya creado, el diagnóstico cambia: sería otra causa.' };
  }
  hechos.push(hecho(e, 'No se pudo comprobar si el objeto existe ahora.', 'information_schema'));
  return base;
}

function reglaConfiguracion(e: EntradaDiagnostico): Parcial {
  const vars = e.configuracion?.variables ?? [];
  const hechos: Hecho[] = [hecho(e, 'El error menciona una configuración del sitio.', 'evidencia del incidente')];
  const base: Parcial = {
    categoria: 'configuracion', confianza: 'insuficiente', corregibleConCodigo: false, resumen: 'Posible problema de configuración.', hechos, posibleCausa: null,
    causaConfirmada: null, accionTemporal: null, siguientePaso: 'Revisar las variables de entorno del sitio en hPanel (DEPLOY.md, sección 3). No hay cambio de código que hacer.',
    referencias: [{ tipo: 'doc', valor: 'DEPLOY.md, sección 3 (variables de entorno)' }],
  };
  if (vars.length === 0) { hechos.push(hecho(e, 'No se identificó qué variable.', 'análisis del mensaje')); return base; }
  const mal = vars.filter((v) => !v.definida || v.valida === false);
  for (const v of vars) {
    // Solo se registra definida/válida: NUNCA el valor.
    hechos.push(hecho(e, `${v.nombre}: ${v.definida ? 'definida' : 'NO definida'}${v.definida && v.valida !== null ? (v.valida ? ' y válida' : ' pero INVÁLIDA') : ''}.`, 'configuración del servidor (sin leer valores)'));
    base.referencias.push({ tipo: 'config', valor: v.nombre });
  }
  if (mal.length) {
    return { ...base, confianza: 'confirmada', resumen: `Configuración incompleta o inválida: ${mal.map((v) => v.nombre).join(', ')}.`, causaConfirmada: `${mal.map((v) => v.nombre).join(', ')} ${mal.length > 1 ? 'no están definidas o son inválidas' : 'no está definida o es inválida'} (comprobado en el momento del diagnóstico).`, posibleCausa: null };
  }
  return { ...base, confianza: 'probable', resumen: 'Las variables mencionadas están definidas y son válidas ahora.', posibleCausa: 'La configuración se corrigió después del error, o el fallo fue puntual.', siguientePaso: 'Vigilar si reaparece; si reaparece con la configuración correcta, el diagnóstico cambia.' };
}

function reglaRndc(e: EntradaDiagnostico): Parcial {
  const r = e.rndc;
  const hechos: Hecho[] = [hecho(e, 'El incidente se relaciona con el RNDC.', 'evidencia del incidente')];
  const base: Parcial = {
    categoria: 'rndc', confianza: 'probable', corregibleConCodigo: false, resumen: 'Posible caída o rechazo del RNDC.', hechos, posibleCausa: 'El servicio del RNDC no está disponible o rechazó un documento.',
    causaConfirmada: null, accionTemporal: null,
    siguientePaso: 'No cambiar código. Si es una caída, esperar: la cola reintenta. Si es un rechazo, corregir los datos del documento. Si el MISMO código se repite en documentos distintos y bien llenados, podría ser un defecto de mapeo: requiere revisión humana (semántica RNDC).',
    referencias: [{ tipo: 'doc', valor: 'docs/RNDC.md (Cómo funciona; Procesos clave)' }, { tipo: 'doc', valor: 'docs/GUIA_Web_Service_RNDC_V5.md' }],
  };
  if (!r) return base;
  hechos.push(hecho(e, `Cola de envíos (24 h): ${r.errores24h} con error, ${r.conexion24h} por falla de conexión, ${r.pendientes} pendientes ahora.`, 'cola_envios (solo lectura)'));
  for (const c of r.codigos) {
    hechos.push(hecho(e, `Código ${c.codigo}: ${c.mensaje ?? '(sin texto)'}${c.solucion ? ` — Solución del catálogo: ${c.solucion}` : ''}`, 'catálogo de errores del RNDC'));
    base.referencias.push({ tipo: 'catalogo_rndc', valor: c.codigo });
  }
  if (r.conexion24h > 0) {
    return { ...base, confianza: 'confirmada', resumen: `La cola registra ${r.conexion24h} falla(s) de conexión con el RNDC en 24 h.`, causaConfirmada: `La cola de envíos registra ${r.conexion24h} falla(s) de conexión con el RNDC en las últimas 24 horas.`, posibleCausa: null };
  }
  if (r.codigos.length) return { ...base, resumen: 'Rechazos del RNDC con códigos del catálogo (ver hechos).', posibleCausa: 'El RNDC rechazó documentos por los motivos del catálogo.' };
  return base;
}

const MARCO_APP = /\b((?:src|dist)\/[\w./-]+\.(?:ts|tsx|js|mjs)):(\d+)(?::\d+)?/;

/** Primer marco de la PILA que es código de la aplicación (no node_modules), o null. */
export function marcoDeLaApp(pila: string): { archivo: string; linea: number } | null {
  for (const l of pila.split('\n')) {
    if (/node_modules/.test(l)) continue;
    const m = MARCO_APP.exec(l);
    if (m) return { archivo: m[1]!, linea: Number(m[2]) };
  }
  return null;
}

function reglaCodigo(e: EntradaDiagnostico): Parcial {
  const hechos: Hecho[] = [hecho(e, `${e.incidente.ocurrencias} ocurrencia(s); primera ${e.incidente.primera_vez}, última ${e.incidente.ultima_vez}.`, 'incidente')];
  const marco = e.evidencia ? marcoDeLaApp(e.evidencia.pila) : null;
  const refs: Referencia[] = [];
  if (marco) { hechos.push(hecho(e, `Ubicación probable: ${marco.archivo}:${marco.linea}.`, 'pila sanitizada')); refs.push({ tipo: 'codigo', valor: `${marco.archivo}:${marco.linea}` }); }
  else hechos.push(hecho(e, 'La pila no trae un marco de la aplicación.', 'pila sanitizada'));
  const c = e.codigo;
  if (c) {
    if (c.primeraVersion) hechos.push(hecho(e, `Primera versión en que apareció: ${c.primeraVersion.slice(0, 12)}; versiones distintas con este fallo: ${c.versionesVistas}.`, 'evidencias'));
    if (c.primeraVersion && c.primeraVersion === e.versionActual && c.versionesVistas === 1) hechos.push(hecho(e, 'Apareció con la versión desplegada actualmente (posible regresión de este despliegue).', 'comparación de versiones'));
    if (c.mismoArchivo > 0) hechos.push(hecho(e, `${c.mismoArchivo} otro(s) incidente(s) apuntan al mismo archivo.`, 'incidentes'));
  }
  return {
    categoria: 'codigo', confianza: marco ? 'probable' : 'insuficiente', corregibleConCodigo: true,
    resumen: marco ? `Error no controlado en ${marco.archivo}:${marco.linea}.` : 'Error no controlado sin ubicación clara.', hechos,
    posibleCausa: marco ? `Un defecto en ${marco.archivo} cerca de la línea ${marco.linea}.` : 'Un defecto en la aplicación.',
    causaConfirmada: null, // nunca se confirma sin reproducirlo (fase 4)
    accionTemporal: null,
    siguientePaso: 'Reproducirlo con una prueba de regresión en un entorno aislado (fase 4). Hasta reproducirlo, la causa NO está confirmada.',
    referencias: refs,
  };
}

function reglaInfraestructura(e: EntradaDiagnostico): Parcial {
  const hechos: Hecho[] = [hecho(e, `Código del error: ${e.incidente.codigo ?? 'sin código'}.`, 'incidente')];
  const i = e.infraestructura;
  if (i) hechos.push(hecho(e, i.baseDeDatosAhora ? 'La base de datos responde AHORA (que haya vuelto no significa que la causa esté resuelta).' : 'La base de datos NO responde ahora.', 'comprobación al diagnosticar'));
  return {
    categoria: 'infraestructura', confianza: 'probable', corregibleConCodigo: false, resumen: 'Posible falla de infraestructura (disco, memoria, conexiones o base de datos).', hechos,
    posibleCausa: 'Un recurso del servidor o la base de datos falló o se agotó.', causaConfirmada: null, accionTemporal: null,
    siguientePaso: 'Revisar el estado del hosting (disco, memoria, conexiones de BD). No hay cambio de código que hacer.', referencias: [],
  };
}

function reglaProveedorIa(e: EntradaDiagnostico): Parcial {
  return {
    categoria: 'proveedor_ia', confianza: 'probable', corregibleConCodigo: false, resumen: 'Posible falla del proveedor de IA.', hechos: [hecho(e, 'El error viene del asistente de datos (proveedor de IA).', 'incidente')],
    posibleCausa: 'El servicio externo de IA falló, está saturado o la clave no es válida.', causaConfirmada: null, accionTemporal: null,
    siguientePaso: 'Revisar OPENROUTER_API_KEY y el estado del proveedor. El asistente es opcional y el resto de la aplicación no se ve afectado.', referencias: [{ tipo: 'config', valor: 'OPENROUTER_API_KEY' }],
  };
}

function reglaReporte(e: EntradaDiagnostico, categoria: TipoIncidente): Parcial {
  const r = e.reportes;
  const hechos: Hecho[] = [hecho(e, `Reporte de usuario${r?.pantalla ? ` en ${r.pantalla}` : ''}; ${e.incidente.ocurrencias} reporte(s).`, 'incidente')];
  const cercanos = r?.cercanos ?? [];
  for (const c of cercanos) hechos.push(hecho(e, `Posible relación con el incidente #${c.id} (${c.tipo}): ${c.titulo}.`, 'correlación por pantalla y tiempo'));
  return {
    categoria, confianza: cercanos.length ? 'probable' : 'insuficiente', corregibleConCodigo: null,
    resumen: cercanos.length ? 'El reporte coincide en pantalla y tiempo con otros incidentes (posible relación).' : 'No hay evidencia técnica asociada a este reporte.', hechos,
    posibleCausa: cercanos.length ? 'Podría estar relacionado con los incidentes cercanos (solo una posibilidad).' : null, causaConfirmada: null, accionTemporal: null,
    siguientePaso: 'Pedir más detalles al usuario o esperar a que se repita con un identificador de error.', referencias: [],
  };
}

/** Diagnostica con reglas. La confianza sale de aquí; nada del contexto puede declararla. */
export function diagnosticar(e: EntradaDiagnostico): Diagnostico {
  const tipo = e.incidente.tipo as TipoIncidente;
  let p: Parcial;
  // Si el contexto trae un objeto de BD señalado, es de migración aunque el tipo se hubiera guardado como código.
  if (tipo === 'migracion' || (e.migracion && e.migracion.objeto)) p = reglaMigracion(e);
  else if (tipo === 'configuracion') p = reglaConfiguracion(e);
  else if (tipo === 'rndc') p = reglaRndc(e);
  else if (tipo === 'infraestructura') p = reglaInfraestructura(e);
  else if (tipo === 'proveedor_ia') p = reglaProveedorIa(e);
  else if (tipo === 'codigo' && e.incidente.origen !== 'usuario') p = reglaCodigo(e);
  else if (tipo === 'datos' || tipo === 'permisos') p = { ...reglaReporte(e, tipo), corregibleConCodigo: false };
  else p = reglaReporte(e, 'otro');
  return { ...p, borradorPublico: borradorPublicoDe(p.categoria, p.confianza), versionReglas: VERSION_REGLAS };
}
