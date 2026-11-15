/**
 * Light TMS - Sanitización de lo que se guarda en incidentes (funciones PURAS).
 *
 * Nada que pueda ser un secreto o un dato personal entra a la base: tokens, contraseñas, XML del RNDC, correos y
 * números largos (cédulas, placas numéricas) se reemplazan ANTES de guardar. Se aplica también al texto que escriben
 * los usuarios en un reporte: la gente pega contraseñas y tokens en las descripciones.
 */

import { createHash } from 'node:crypto';

const CLAVES_SECRETAS = 'password|passwd|pwd|pass|clave|contraseña|contrasena|secret|secreto|token|apikey|api_key|api-key|authorization|auth|cookie|set-cookie|jwt|bearer';

/** Quita lo sensible de un texto libre y lo acota. */
export function sanitizarTexto(entrada: unknown, max = 500): string {
  let s = typeof entrada === 'string' ? entrada : entrada === null || entrada === undefined ? '' : String(entrada);
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');

  // XML del RNDC (credenciales, documentos): se omite completo, no se intenta limpiar por partes.
  s = s.replace(/<\?xml[\s\S]*?(?:<\/root>|$)/gi, '[XML omitido]');
  s = s.replace(/<root[\s\S]*?(?:<\/root>|$)/gi, '[XML omitido]');
  s = s.replace(new RegExp(`<(${CLAVES_SECRETAS}|username|usuario|nit|numidentificador)[^>]*>[\\s\\S]*?</\\1>`, 'gi'), '<$1>[oculto]</$1>');

  // JWT, Bearer, tokens largos
  s = s.replace(/\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{3,}/g, '[token]');
  s = s.replace(/\bBearer\s+[\w.~+/=-]{6,}/gi, 'Bearer [token]');
  // clave=valor / "clave":"valor" / clave: valor
  s = s.replace(
    new RegExp(`(["']?(?:${CLAVES_SECRETAS})["']?\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|[^\\s"',;&}]+)`, 'gi'),
    '$1[oculto]',
  );
  // cadenas largas tipo clave de API (hex/base64 de 24+ caracteres sin espacios)
  s = s.replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[secreto]');
  // correos, uuids, números largos (cédulas, teléfonos, ids de documentos)
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[correo]');
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[uuid]');
  s = s.replace(/\b\d{7,}\b/g, '[num]');

  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** `/api/manifiesto/123/pdf?token=abc` → `/api/manifiesto/:id/pdf` (sin consulta; los segmentos que parecen ids se normalizan). */
export function normalizarRuta(ruta: unknown, max = 200): string {
  const s = typeof ruta === 'string' ? ruta : '';
  const sinConsulta = (s.split('?')[0] ?? '').split('#')[0] ?? '';
  const partes = sinConsulta.split('/').map((seg) => {
    if (!seg) return seg;
    if (/^\d+$/.test(seg)) return ':id';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ':id';
    if (/^[0-9a-f]{12,}$/i.test(seg)) return ':id';
    if (/^[A-Za-z0-9_-]{20,}$/.test(seg)) return ':id';
    if (/[@%]/.test(seg) || /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9-]{5,}$/.test(seg)) return ':id'; // placas, números de manifiesto, correos
    return seg;
  });
  const r = partes.join('/') || '/';
  return r.length > max ? r.slice(0, max) : r;
}

/** Pila de errores: sin rutas absolutas del servidor, sin secretos, acotada. */
export function sanitizarPila(pila: unknown, maxLineas = 12): string {
  if (typeof pila !== 'string') return '';
  return pila
    .split('\n')
    .slice(0, maxLineas)
    .map((l) => sanitizarTexto(l.replace(/(?:\/[\w.@-]+)+\/(?=(?:src|dist|node_modules)\/)/g, ''), 220))
    .join('\n');
}

/** Mensaje "sin ruido" para agrupar: lo que cambia entre ocurrencias del mismo fallo (ids, números, textos entre comillas) no cuenta. */
export function normalizarParaHuella(mensaje: unknown): string {
  return sanitizarTexto(mensaje, 300)
    .toLowerCase()
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '#')
    .replace(/\[(?:num|uuid|correo|token|secreto|oculto)\]/g, '#')
    .replace(/\b\d+\b/g, '#')
    .replace(/\b[0-9a-f]{8,}\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Huella de agrupación: mismo sitio + mismo tipo + misma operación + mismo código + mismo mensaje normalizado. */
export function huella(partes: { sitio: string; tipo: string; operacion?: string | null; codigo?: string | null; mensaje?: string | null }): string {
  const base = [partes.sitio, partes.tipo, normalizarRuta(partes.operacion ?? ''), partes.codigo ?? '', normalizarParaHuella(partes.mensaje)].join('|');
  return createHash('sha256').update(base).digest('hex');
}
