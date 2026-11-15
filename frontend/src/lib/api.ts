/**
 * Light TMS - API client.
 *
 * Thin fetch wrapper that attaches the JWT from the auth store and normalises
 * errors. On 401 it clears the session so the app falls back to the login page.
 */

import { useAuthStore } from '../store/auth';
import { logoutWithSplash } from './splash';
import { telemetria } from './telemetriaApp';

const BASE = '/api';

/** Id de correlación por petición (el servidor lo conserva y lo devuelve; debe cumplir ^[A-Za-z0-9_-]{8,64}$). */
function nuevoIdPeticion(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  } catch {
    /* sin crypto.randomUUID */
  }
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** Último fallo 5xx (para prellenar un reporte con el id de correlación): vale unos minutos. */
let ultimoFallo: { requestId: string; en: number } | null = null;
export function ultimoRequestIdFallido(maxMs = 10 * 60_000): string | null {
  return ultimoFallo && Date.now() - ultimoFallo.en < maxMs ? ultimoFallo.requestId : null;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** Identificador de correlación de la petición (X-Request-Id): une lo que ve el usuario con el incidente del servidor. */
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Query params appended to the URL. */
  query?: Record<string, string | number | boolean | null | undefined>;
  /** When true, do not attach the Authorization header (e.g. login). */
  anonymous?: boolean;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = new URL(BASE + path, window.location.origin);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  return url.pathname + url.search;
}

/** Best-effort extraction of the `{ error }` JSON body the backend sends on failure. */
async function errorMessage(res: Response): Promise<string> {
  try {
    const data = await res.clone().json();
    if (data && typeof data.error === 'string' && data.error.trim() !== '') return data.error;
  } catch {
    // Not JSON (or empty body) — fall back to the generic message below.
  }
  return `Error ${res.status}`;
}

/**
 * Fetches a binary/document endpoint with the JWT attached and opens it in a new
 * tab (used for PDFs, which can't use a plain <a href> because that omits the
 * Authorization header). Returns false if the popup was blocked.
 */
export async function openAuthedFile(path: string): Promise<boolean> {
  const { token } = useAuthStore.getState();
  const res = await fetch(buildUrl(path), {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (res.status === 401) {
    logoutWithSplash();
    throw new ApiError(401, 'No autenticado.');
  }
  if (!res.ok) throw new ApiError(res.status, await errorMessage(res));
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank');
  // Revoke a bit later so the tab has time to load.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return win != null;
}

/**
 * Downloads a file endpoint (with the JWT attached) and saves it via a temporary
 * <a download>. Used for the CSV report, which can't use a plain link (no auth
 * header). `query` params are appended to the URL.
 */
export async function downloadAuthedFile(
  path: string,
  filename: string,
  query?: RequestOptions['query'],
): Promise<void> {
  const { token } = useAuthStore.getState();
  const res = await fetch(buildUrl(path, query), {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (res.status === 401) {
    logoutWithSplash();
    throw new ApiError(401, 'No autenticado.');
  }
  if (!res.ok) throw new ApiError(res.status, await errorMessage(res));
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { token } = useAuthStore.getState();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (!opts.anonymous && token) headers.Authorization = `Bearer ${token}`;
  const requestId = nuevoIdPeticion();
  headers['X-Request-Id'] = requestId;

  const res = await fetch(buildUrl(path, opts.query), {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  if (res.status === 401 && !opts.anonymous) {
    logoutWithSplash();
  }

  const isJson = res.headers.get('content-type')?.includes('application/json');
  const payload = isJson ? await res.json() : await res.text();

  if (!res.ok) {
    const body = isJson && payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
    const message = String(body?.error ?? body?.mensaje ?? `Error ${res.status}`);
    const rid = String(body?.requestId ?? res.headers.get('x-request-id') ?? requestId);
    // Solo los 5xx (fallos del servidor) y NUNCA las llamadas a /reportes (la telemetría no se reporta a sí misma).
    if (res.status >= 500 && !path.startsWith('/reportes')) {
      ultimoFallo = { requestId: rid, en: Date.now() };
      void telemetria.reportar({ tipo: 'http_5xx', mensaje: `HTTP ${res.status} ${opts.method ?? 'GET'} ${path}`, requestId: rid });
    }
    throw new ApiError(res.status, message, rid);
  }
  return payload as T;
}
