/**
 * Light TMS - Clasificación de un error en el tipo de incidente (reglas, no IA).
 *
 * `corregible` dice si un cambio de CÓDIGO podría resolverlo: una caída del RNDC, una migración pendiente, una
 * configuración o la infraestructura NO se "arreglan" con código (ocultar el síntoma sería peor que el error).
 */

export type TipoIncidente = 'codigo' | 'datos' | 'permisos' | 'migracion' | 'configuracion' | 'rndc' | 'proveedor_ia' | 'infraestructura' | 'otro';
export const TIPOS_INCIDENTE: readonly TipoIncidente[] = ['codigo', 'datos', 'permisos', 'migracion', 'configuracion', 'rndc', 'proveedor_ia', 'infraestructura', 'otro'];

export interface Clasificacion {
  tipo: TipoIncidente;
  severidad: 'baja' | 'media' | 'alta' | 'critica';
  corregible: boolean;
  codigo: string | null;
}

export function clasificarError(err: unknown, ctx: { status?: number; ruta?: string } = {}): Clasificacion {
  const e = (err ?? {}) as { code?: unknown; message?: unknown; name?: unknown };
  const codigo = typeof e.code === 'string' ? e.code.slice(0, 60) : null;
  const mensaje = typeof e.message === 'string' ? e.message : String(err ?? '');
  const ruta = ctx.ruta ?? '';

  if (codigo === 'ER_BAD_FIELD_ERROR' || codigo === 'ER_NO_SUCH_TABLE' || /migraci[oó]n|falta la tabla|unknown column/i.test(mensaje)) {
    return { tipo: 'migracion', severidad: 'alta', corregible: false, codigo };
  }
  if (/openrouter|proveedor de ia|chatbot|\bllm\b/i.test(mensaje) || ruta.startsWith('/api/chat')) {
    return { tipo: 'proveedor_ia', severidad: 'baja', corregible: false, codigo };
  }
  if (/\brndc\b|rndcws|servicio del rndc/i.test(mensaje)) {
    return { tipo: 'rndc', severidad: 'media', corregible: false, codigo };
  }
  if (
    ['ENOSPC', 'EMFILE', 'ENOMEM', 'ER_CON_COUNT_ERROR', 'PROTOCOL_CONNECTION_LOST', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'].includes(codigo ?? '') ||
    /too many connections|no space left|out of memory|pool is closed/i.test(mensaje)
  ) {
    return { tipo: 'infraestructura', severidad: 'alta', corregible: false, codigo };
  }
  if (/jwt_secret|smtp_|app_url|falta configurar|no est[aá] configurad/i.test(mensaje)) {
    return { tipo: 'configuracion', severidad: 'alta', corregible: false, codigo };
  }
  if (ctx.status === 403 || /no autorizado|no tienes permiso/i.test(mensaje)) {
    return { tipo: 'permisos', severidad: 'baja', corregible: false, codigo };
  }
  if (ctx.status !== undefined && ctx.status >= 400 && ctx.status < 500) {
    return { tipo: 'datos', severidad: 'baja', corregible: false, codigo };
  }
  return { tipo: 'codigo', severidad: 'media', corregible: true, codigo };
}
