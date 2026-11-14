/**
 * Light TMS - Typed configuration loader.
 *
 * Port of src/config.php. Loads environment variables from server/.env and,
 * as a fallback, from the repo-root .env (the PHP app's file), so DB/RNDC/COLA
 * values can live in a single place. Values already present in process.env win.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// server/src/config -> server root is ../../ ; repo root is ../../../
const serverRoot = path.resolve(__dirname, '..', '..');
const repoRoot = path.resolve(serverRoot, '..');

// Load server/.env first (highest priority among files), then repo-root .env as
// a fallback for shared DB/RNDC/COLA values. dotenv does not overwrite existing
// keys, so the first file loaded for a given key wins.
dotenv.config({ path: path.join(serverRoot, '.env') });
dotenv.config({ path: path.join(repoRoot, '.env') });

/** Reads a string env var with a default; treats "" as absent. */
function str(key: string, def = ''): string {
  const v = process.env[key];
  return v === undefined || v === '' ? def : v;
}

/** Reads an integer env var with a default. */
function int(key: string, def: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? def : n;
}

/** Reads a boolean env var (true/1/yes) with a default. */
function bool(key: string, def: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  return ['true', '1', 'yes', 'on'].includes(v.toLowerCase());
}

export interface AppConfig {
  app: { name: string; env: string; debug: boolean; port: number; corsOrigins: string[] };
  auth: { jwtSecret: string; jwtExpires: string };
  /** Detrás de cuántos proxies está (para leer la IP real del visitante) y modo de la CSP. */
  seguridad: { trustProxy: number; cspModo: string };
  /** Cloudflare Turnstile en el login. enforce=false es la palanca de emergencia (y el estado de un sitio aún sin claves). */
  /** Envío de correo (recuperar contraseña). Sin SMTP_HOST el correo no se envía (se avisa en el log). */
  correo: { appUrl: string; host: string; port: number; secure: boolean; user: string; pass: string; from: string };
  turnstile: { enforce: boolean; siteKey: string; secretKey: string; allowedHostnames: string[] };
  db: { host: string; port: number; name: string; user: string; pass: string; charset: string };
  /** Read-only DB user for the chatbot (least privilege). Falls back to the main user. */
  dbReadonly: { user: string; pass: string };
  rndc: {
    ambiente: string;
    hostOverride: string;
    timeout: number;
  };
  cola: { maxIntentos: number; minutosReintento: number; minutosEnviandoAtascado: number; envioHabilitado: boolean };
  /** Web Push (own VAPID keypair, no third-party notification service). */
  push: { vapidPublicKey: string; vapidPrivateKey: string; vapidSubject: string; watchMs: number; habilitado: boolean };
  /** Data chatbot via OpenRouter (OpenAI-compatible API). */
  chat: {
    habilitado: boolean;
    apiKey: string;
    modelo: string;
    baseUrl: string;
    maxFilas: number;
  };
}

let cached: AppConfig | null = null;

/** Consolidated application configuration (memoised). Mirrors config() in config.php. */
export function config(): AppConfig {
  if (cached) return cached;
  cached = {
    app: {
      name: str('APP_NAME', 'Konekto'),
      env: str('APP_ENV', 'local'),
      debug: bool('APP_DEBUG', false),
      port: int('PORT', 4000),
      corsOrigins: str('CORS_ORIGINS', 'http://localhost:5173')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    },
    auth: {
      jwtSecret: str('JWT_SECRET', 'change-me-in-production'),
      jwtExpires: str('JWT_EXPIRES', '8h'),
    },
    seguridad: {
      // Hostinger pone UN proxy delante de la app. 0 = sin proxy (la IP es la de la conexión).
      trustProxy: int('TRUST_PROXY', 1),
      cspModo: str('CSP_MODO', 'report'),
    },
    correo: {
      // Dirección pública del sitio (https://...): con ella se arma el enlace del correo. NO se toma del
      // encabezado Host de la petición (un atacante podría fabricar enlaces hacia su propio sitio).
      appUrl: str('APP_URL', '').replace(/\/+$/, ''),
      host: str('SMTP_HOST', ''),
      port: int('SMTP_PORT', 465),
      secure: bool('SMTP_SECURE', int('SMTP_PORT', 465) === 465),
      user: str('SMTP_USER', ''),
      pass: str('SMTP_PASS', ''),
      from: str('SMTP_FROM', str('SMTP_USER', '')),
    },
    turnstile: {
      // Apagado por defecto: un sitio sin claves no debe quedar bloqueado al recibir el código.
      // Con TURNSTILE_ENFORCE=true el login exige el reto y FALLA CERRADO si falta algo (clave, dominio).
      enforce: bool('TURNSTILE_ENFORCE', false),
      siteKey: str('TURNSTILE_SITE_KEY', ''),
      secretKey: str('TURNSTILE_SECRET_KEY', ''),
      allowedHostnames: str('TURNSTILE_ALLOWED_HOSTNAMES', '')
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
    },
    db: {
      host: str('DB_HOST', 'localhost'),
      port: int('DB_PORT', 3306),
      name: str('DB_NAME', 'light_tms'),
      user: str('DB_USER', 'root'),
      pass: str('DB_PASS', ''),
      charset: str('DB_CHARSET', 'utf8mb4'),
    },
    dbReadonly: {
      // If DB_READONLY_* are unset, the chatbot uses the main DB user. Strongly
      // recommended: create a MySQL user with SELECT-only grants (see chat.repo.ts).
      user: str('DB_READONLY_USER', str('DB_USER', 'root')),
      pass: str('DB_READONLY_PASS', str('DB_PASS', '')),
    },
    rndc: {
      // 'pruebas' (servidor rndc) o 'produccion' (rndcws/rndcws2/plc).
      ambiente: str('RNDC_AMBIENTE', 'pruebas'),
      hostOverride: str('RNDC_HOST_OVERRIDE', ''),
      timeout: int('RNDC_TIMEOUT', 30),
    },
    cola: {
      maxIntentos: int('COLA_MAX_INTENTOS', 10),
      minutosReintento: int('COLA_MINUTOS_REINTENTO', 15),
      // A row left in 'enviando' longer than this is considered interrupted
      // (process died mid-send) and is recovered by drenar(). Must be well above
      // the RNDC timeout (30 s per call).
      minutosEnviandoAtascado: int('COLA_MINUTOS_ENVIANDO_ATASCADO', 10),
      // Safety switch: false builds/previews XML but does NOT send to the RNDC.
      envioHabilitado: bool('COLA_ENVIO_HABILITADO', false),
    },
    push: (() => {
      const vapidPublicKey = str('VAPID_PUBLIC_KEY');
      const vapidPrivateKey = str('VAPID_PRIVATE_KEY');
      return {
        vapidPublicKey,
        vapidPrivateKey,
        vapidSubject: str('VAPID_SUBJECT', 'mailto:admin@example.com'),
        watchMs: int('PUSH_WATCH_MS', 60_000),
        // Opt-in: only active once both VAPID keys are set.
        habilitado: Boolean(vapidPublicKey && vapidPrivateKey),
      };
    })(),
    chat: {
      // Opt-in: the chatbot only works once an OpenRouter key is set and enabled.
      habilitado: bool('CHAT_HABILITADO', false),
      apiKey: str('OPENROUTER_API_KEY', ''),
      // Free/cheap model with tool-calling support. Override via OPENROUTER_MODEL.
      // When the model ends in ':free', the service adds free fallback models so
      // a rate-limited provider auto-routes to the next one (OpenRouter `models`).
      modelo: str('OPENROUTER_MODEL', 'meta-llama/llama-3.3-70b-instruct:free'),
      baseUrl: str('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1'),
      maxFilas: int('CHAT_MAX_FILAS', 200),
    },
  };
  return cached;
}
