/**
 * Light TMS - Reúne el contexto de un incidente para el diagnóstico.
 *
 * LECTURAS SOLAMENTE: todo lo operativo (cola, catálogo RNDC, information_schema) se lee dentro de `START TRANSACTION READ ONLY`
 * (la base impide que el diagnóstico cambie estado operativo). Nunca se selecciona `payload_xml` ni `respuesta_rndc` (pueden
 * contener credenciales del RNDC) ni se usa `SELECT *` sobre la cola: solo estado, tipo, intentos y `ultimo_error`, y este último
 * se SANITIZA antes de usarse. De configuración solo se registra si está definida y es válida; nunca el valor.
 */

import type { RowDataPacket } from 'mysql2';
import { db, leerSoloLectura } from '../../db/pool.js';
import { problemaSecretoJwt } from '../auth/jwt.js';
import { vinculoPropietario } from '../auth/propietario.js';
import { sanitizarTexto } from '../incidentes/sanitizar.js';
import { versionDespliegue } from '../incidentes/version.js';
import { cargarIndice } from './indiceMigraciones.js';
import { marcoDeLaApp, type EntradaDiagnostico } from './reglas.js';

const VARIABLES_CONOCIDAS = [
  'JWT_SECRET', 'PLATFORM_OWNER_UUID', 'APP_URL', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'TURNSTILE_SECRET_KEY', 'TURNSTILE_SITE_KEY',
  'TURNSTILE_ALLOWED_HOSTNAMES', 'OPENROUTER_API_KEY', 'DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASS', 'SITE_ID', 'APP_COMMIT', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY',
];

/** Valida una variable SIN exponer su valor: devuelve solo "definida" y "válida" (null = no hay regla de validez). */
export function estadoDeVariable(nombre: string, env: NodeJS.ProcessEnv = process.env): { nombre: string; definida: boolean; valida: boolean | null } {
  const valor = (env[nombre] ?? '').trim();
  const definida = valor !== '';
  let valida: boolean | null = null;
  if (definida) {
    if (nombre === 'JWT_SECRET') valida = problemaSecretoJwt(valor) === null;
    else if (nombre === 'PLATFORM_OWNER_UUID') valida = vinculoPropietario(env).ok;
    else if (nombre === 'APP_URL') { try { valida = /^https?:$/.test(new URL(valor).protocol); } catch { valida = false; } }
  }
  return { nombre, definida, valida };
}

const sinMojibake = (t: string | null) => (t === null ? null : sanitizarTexto(t.replace(/�/g, '?'), 400));
const ultimo = (a: string[]) => a[a.length - 1] ?? '';

export async function reunirContexto(incidenteId: number): Promise<EntradaDiagnostico | null> {
  const [[inc]] = await db().query<RowDataPacket[]>(
    'SELECT id, tipo, origen, operacion, codigo, titulo, ocurrencias, primera_vez, ultima_vez, version_despliegue, corregible, estado FROM incidentes WHERE id = ?', [incidenteId]);
  if (!inc) return null;
  const [evs] = await db().query<RowDataPacket[]>('SELECT contenido, version_despliegue FROM incidente_evidencias WHERE incidente_id = ? ORDER BY id DESC LIMIT 20', [incidenteId]);
  let evidencia: EntradaDiagnostico['evidencia'] = null;
  if (evs[0]) {
    try {
      const j = JSON.parse(String(evs[0].contenido)) as { mensaje?: string; pila?: string; status?: number; ruta?: string };
      evidencia = { mensaje: String(j.mensaje ?? ''), pila: String(j.pila ?? ''), status: j.status, ruta: j.ruta };
    } catch { /* evidencia ilegible */ }
  }
  const entrada: EntradaDiagnostico = {
    incidente: {
      id: Number(inc.id), tipo: String(inc.tipo), origen: String(inc.origen), operacion: inc.operacion ?? null, codigo: inc.codigo ?? null, titulo: String(inc.titulo),
      ocurrencias: Number(inc.ocurrencias), primera_vez: String(inc.primera_vez), ultima_vez: String(inc.ultima_vez), version_despliegue: inc.version_despliegue ?? null,
      corregible: Number(inc.corregible) === 1, estado: String(inc.estado),
    },
    versionActual: versionDespliegue(), evidencia, observado: new Date().toISOString(),
  };
  const mensaje = `${evidencia?.mensaje ?? ''} ${String(inc.titulo)}`;

  await leerSoloLectura(async (conn) => {
    // --- Migración pendiente: ¿qué objeto señala el error y existe AHORA?
    const col = /Unknown column '([^']+)'/i.exec(mensaje)?.[1];
    const tab = /Table '([^']+)' doesn't exist/i.exec(mensaje)?.[1];
    if (col || tab) {
      const indice = cargarIndice();
      let objeto: { tabla: string; columna?: string } | null = null;
      if (tab) objeto = { tabla: ultimo(tab.split('.')).toLowerCase() };
      else if (col) {
        const c = ultimo(col.split('.')).toLowerCase();
        const candidatas = Object.keys(indice?.objetos ?? {}).filter((k) => k.endsWith(`.${c}`)).map((k) => k.split('.')[0]!);
        objeto = { tabla: candidatas[0] ?? '', columna: c };
        if (!candidatas.length) objeto = null;
        for (const t of candidatas) {
          const [[x]] = await conn.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [t, c]);
          if (Number(x!.n) === 0) { objeto = { tabla: t, columna: c }; break; }
        }
      }
      let ausenteAhora: boolean | null = null;
      if (objeto) {
        const [[x]] = objeto.columna
          ? await conn.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [objeto.tabla, objeto.columna])
          : await conn.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [objeto.tabla]);
        ausenteAhora = Number(x!.n) === 0;
      }
      entrada.migracion = {
        objeto, ausenteAhora, indiceDisponible: indice !== null,
        migracion: objeto && indice ? (indice.objetos[objeto.columna ? `${objeto.tabla}.${objeto.columna}` : objeto.tabla] ?? null) : null,
      };
    }

    // --- Configuración: qué variables menciona el error y si están definidas/válidas (sin leer valores)
    const nombres = VARIABLES_CONOCIDAS.filter((v) => new RegExp(`\\b${v}\\b`, 'i').test(mensaje));
    if (nombres.length) entrada.configuracion = { variables: nombres.map((n) => estadoDeVariable(n)) };

    // --- RNDC: lo que la cola registra (solo columnas no sensibles) y el catálogo
    if (String(inc.tipo) === 'rndc') {
      const [[e24]] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM cola_envios WHERE updated_at >= NOW() - INTERVAL 24 HOUR AND (estado = 'error' OR ultimo_error IS NOT NULL)");
      const [[con]] = await conn.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS n FROM cola_envios WHERE updated_at >= NOW() - INTERVAL 24 HOUR AND ultimo_error IS NOT NULL AND
         (ultimo_error LIKE '%ECONN%' OR ultimo_error LIKE '%ETIMEDOUT%' OR ultimo_error LIKE '%ENOTFOUND%' OR ultimo_error LIKE '%EAI_AGAIN%' OR ultimo_error LIKE '%timeout%' OR ultimo_error LIKE '%no respond%' OR ultimo_error LIKE '%servicio del RNDC%')`);
      const [[pen]] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM cola_envios WHERE estado = 'pendiente'");
      const [muestras] = await conn.query<RowDataPacket[]>('SELECT ultimo_error FROM cola_envios WHERE ultimo_error IS NOT NULL ORDER BY id DESC LIMIT 50');
      const codigos = [...new Set(muestras.flatMap((m) => sanitizarTexto(m.ultimo_error, 600).match(/\b[A-Z]{3,4}\d{3}\b/g) ?? []))].slice(0, 10);
      let catalogo: RowDataPacket[] = [];
      if (codigos.length) [catalogo] = await conn.query<RowDataPacket[]>('SELECT codigo, mensaje, solucion FROM error_rndc WHERE codigo IN (?) LIMIT 10', [codigos]);
      entrada.rndc = {
        errores24h: Number(e24!.n), conexion24h: Number(con!.n), pendientes: Number(pen!.n),
        codigos: catalogo.map((c) => ({ codigo: String(c.codigo), mensaje: sinMojibake(c.mensaje ?? null), solucion: sinMojibake(c.solucion ?? null) })),
      };
    }

    // --- Infraestructura
    if (String(inc.tipo) === 'infraestructura') {
      let ok = true;
      try { await conn.query('SELECT 1'); } catch { ok = false; }
      entrada.infraestructura = { baseDeDatosAhora: ok };
    }
  });

  // --- Código: versiones, regresión y archivo
  if (String(inc.tipo) === 'codigo' && String(inc.origen) !== 'usuario') {
    const versiones = [...evs].reverse().map((e) => e.version_despliegue as string | null).filter((v): v is string => !!v);
    const marco = evidencia ? marcoDeLaApp(evidencia.pila) : null;
    let mismo = 0;
    if (marco) {
      const [[x]] = await db().query<RowDataPacket[]>('SELECT COUNT(DISTINCT incidente_id) AS n FROM incidente_evidencias WHERE incidente_id <> ? AND contenido LIKE ?', [incidenteId, `%${marco.archivo.replace(/[\\%_]/g, '\\$&')}:%`]);
      mismo = Number(x!.n);
    }
    entrada.codigo = { primeraVersion: versiones[0] ?? null, versionesVistas: new Set(versiones).size, mismoArchivo: mismo };
  }

  // --- Reportes de usuario: incidentes cercanos por pantalla y tiempo (siempre "posible", solo para el propietario)
  if (String(inc.origen) === 'usuario' || String(inc.tipo) === 'otro') {
    const seg = (String(inc.operacion ?? '').split('/')[1] ?? '').replace(/[^a-z0-9_-]/gi, '');
    let cercanos: RowDataPacket[] = [];
    if (seg) {
      [cercanos] = await db().query<RowDataPacket[]>(
        "SELECT id, tipo, titulo FROM incidentes WHERE id <> ? AND origen <> 'usuario' AND ultima_vez >= NOW() - INTERVAL 1 DAY AND operacion LIKE ? ORDER BY ultima_vez DESC LIMIT 3", [incidenteId, `%/${seg}%`]);
    }
    entrada.reportes = { pantalla: inc.operacion ?? null, cercanos: cercanos.map((c) => ({ id: Number(c.id), tipo: String(c.tipo), titulo: sanitizarTexto(c.titulo, 150) })) };
  }
  return entrada;
}
