/**
 * Light TMS - Cabeceras de seguridad de la parte pública.
 *
 * CSP: limita de dónde puede cargar código la página. Importa porque el token de
 * sesión vive en localStorage: un script ajeno podría leerlo. Se despliega primero
 * en modo "solo reportar" (CSP_MODO=report, por defecto): el navegador anota en la
 * consola lo que bloquearía, pero no bloquea nada. Con CSP_MODO=enforce se aplica.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

export type CspModo = 'off' | 'report' | 'enforce';

export function cspModoDe(valor: string | undefined): CspModo {
  const v = (valor ?? 'report').trim().toLowerCase();
  return v === 'enforce' || v === 'off' ? v : 'report';
}

/** Hash 'sha256-…' de cada <script> en línea del HTML (el del tema oscuro de index.html). */
export function hashesScriptsEnLinea(html: string): string[] {
  const hashes: string[] = [];
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    const contenido = m[1] ?? '';
    if (!contenido.trim()) continue;
    hashes.push(`'sha256-${createHash('sha256').update(contenido).digest('base64')}'`);
  }
  return hashes;
}

/** Lee el index.html compilado para sacar los hashes de sus scripts en línea. */
export function hashesDeIndex(rutaIndex: string): string[] {
  return existsSync(rutaIndex) ? hashesScriptsEnLinea(readFileSync(rutaIndex, 'utf8')) : [];
}

export function construirCsp(hashesScripts: string[], turnstile = false): string {
  // El widget de Cloudflare necesita su script, su iframe y su conexión; sin esto simplemente no aparece.
  const CF = turnstile ? ' https://challenges.cloudflare.com' : '';
  return [
    "default-src 'self'",
    `script-src 'self' ${hashesScripts.join(' ')}${CF}`.trim(),
    ...(turnstile ? [`frame-src 'self'${CF}`] : []),
    // Los estilos en línea de React/Leaflet y el splash lo requieren.
    "style-src 'self' 'unsafe-inline'",
    // Mapa: teselas de OpenStreetMap; PDFs/QR: data: y blob:.
    "img-src 'self' data: blob: https://*.tile.openstreetmap.org",
    "font-src 'self' data:",
    // Búsqueda de direcciones del mapa.
    `connect-src 'self' https://nominatim.openstreetmap.org${CF}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ');
}

/** Cabecera y valor según el modo, o null si está apagada. */
export function cabeceraCsp(modo: CspModo, hashesScripts: string[], turnstile = false): { nombre: string; valor: string } | null {
  if (modo === 'off') return null;
  return {
    nombre: modo === 'enforce' ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only',
    valor: construirCsp(hashesScripts, turnstile),
  };
}
