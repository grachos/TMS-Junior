/**
 * Light TMS - Recuperar la contraseña por correo.
 *
 *  - "Olvidé mi contraseña" responde SIEMPRE lo mismo (204), exista o no la cuenta, esté activa o no:
 *    no se puede averiguar qué correos existen. El correo se manda DESPUÉS de responder, así el
 *    tiempo de respuesta tampoco delata nada.
 *  - El enlace trae un token aleatorio de 256 bits; en la base solo queda su hash SHA-256.
 *    Es de un solo uso (se reclama con un UPDATE condicional: dos clics a la vez, uno solo gana),
 *    vence a los 30 minutos y una solicitud nueva invalida las anteriores.
 *  - Límites en la base: por correo (3 por hora; pasado el tope se ignora EN SILENCIO, sin delatar)
 *    y por IP (10 por hora; ese sí responde 429, no depende de la cuenta).
 *  - El enlace se arma con APP_URL (configurado), nunca con el encabezado Host de la petición.
 *  - Al restablecer, el conteo de fallos de ingreso de esa cuenta se reinicia: es la salida de un bloqueo.
 */

import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { db, withTransaction } from '../../db/pool.js';
import { config } from '../../config/env.js';
import { findByEmail } from './auth.repo.js';
import { auditarAcceso, hashIdentificador } from './accesoGuard.js';
import { enviarCorreo as enviarCorreoReal, type Correo } from './correo.js';

export const VENCE_MIN = 30;
export const MAX_POR_CORREO_HORA = 3;
export const MAX_POR_IP_HORA = 10;
export const MIN_PASSWORD = 8;

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export function armarCorreo(nombre: string, enlace: string): Correo {
  const asunto = 'Restablece tu contraseña de Konekto';
  const texto =
    `Hola ${nombre},\n\nRecibimos una solicitud para restablecer tu contraseña. Abre este enlace (vale ${VENCE_MIN} minutos y solo se puede usar una vez):\n\n${enlace}\n\n` +
    'Si no fuiste tú, ignora este mensaje: tu contraseña no cambia hasta que abras el enlace y elijas una nueva.\n\nKonekto';
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const html =
    `<p>Hola ${esc(nombre)},</p><p>Recibimos una solicitud para restablecer tu contraseña. El enlace vale ${VENCE_MIN} minutos y solo se puede usar una vez:</p>` +
    `<p><a href="${esc(enlace)}">Restablecer mi contraseña</a></p><p style="color:#64748b;font-size:13px">Si no fuiste tú, ignora este mensaje: tu contraseña no cambia hasta que abras el enlace y elijas una nueva.</p><p>Konekto</p>`;
  return { para: '', asunto, texto, html };
}

export type Remitente = (c: Correo) => Promise<boolean>;

/**
 * Registra la solicitud y, si corresponde, programa el correo (sin esperarlo).
 * Devuelve 'LIMITE_IP' solo cuando la IP superó su tope; en cualquier otro caso 'OK'.
 */
export async function solicitarRecuperacion(
  email: string, ip: string, userAgent: string | null, enviar: Remitente = enviarCorreoReal,
): Promise<'OK' | 'LIMITE_IP'> {
  const emailHash = hashIdentificador(email);
  await db().query('INSERT INTO recuperacion_solicitudes (ip, email_hash) VALUES (?, ?)', [ip, emailHash]);
  await db().query('DELETE FROM recuperacion_solicitudes WHERE created_at < NOW() - INTERVAL 2 DAY LIMIT 1000');

  const [[porIp]] = await db().query<RowDataPacket[]>(
    'SELECT COUNT(*) AS n FROM recuperacion_solicitudes WHERE ip = ? AND created_at >= NOW() - INTERVAL 1 HOUR', [ip]);
  if (Number(porIp!.n) > MAX_POR_IP_HORA) {
    await auditarAcceso({ ip, userAgent, identificadorHash: emailHash, usuarioId: null, resultado: 'RECUPERACION_LIMITE' });
    return 'LIMITE_IP';
  }
  const [[porCorreo]] = await db().query<RowDataPacket[]>(
    'SELECT COUNT(*) AS n FROM recuperacion_solicitudes WHERE email_hash = ? AND created_at >= NOW() - INTERVAL 1 HOUR', [emailHash]);
  const excedido = Number(porCorreo!.n) > MAX_POR_CORREO_HORA;

  const user = excedido ? null : await findByEmail(email); // findByEmail solo trae cuentas activas
  const { appUrl } = config().correo;
  if (!user || !appUrl) {
    if (user && !appUrl) {
      // eslint-disable-next-line no-console
      console.error('[recuperación] Falta APP_URL: no se puede armar el enlace del correo.');
    }
    await auditarAcceso({ ip, userAgent, identificadorHash: emailHash, usuarioId: null, resultado: 'RECUPERACION_SOLICITADA' });
    return 'OK';
  }

  const token = randomBytes(32).toString('base64url');
  await withTransaction(async (conn) => {
    await conn.query('UPDATE password_resets SET usado_en = NOW() WHERE usuario_id = ? AND usado_en IS NULL', [user.id]);
    await conn.query(
      'INSERT INTO password_resets (usuario_id, token_hash, expira_en, ip) VALUES (?, ?, NOW() + INTERVAL ? MINUTE, ?)',
      [user.id, hashToken(token), VENCE_MIN, ip],
    );
  });
  await auditarAcceso({ ip, userAgent, identificadorHash: emailHash, usuarioId: user.id, resultado: 'RECUPERACION_SOLICITADA' });

  const correo = { ...armarCorreo(user.nombre, `${appUrl}/restablecer?token=${token}`), para: user.email };
  // Sin await: la respuesta HTTP no espera al servidor de correo.
  void enviar(correo).catch(() => false);
  return 'OK';
}

export type ResultadoReset = 'OK' | 'INVALIDO';

/** Cambia la contraseña con un token válido. El token se gasta de forma atómica. */
export async function restablecerContrasena(
  token: string, passwordNueva: string, ip: string, userAgent: string | null,
): Promise<ResultadoReset> {
  const hash = hashToken(token);
  const passwordHash = await bcrypt.hash(passwordNueva, 10);
  const usuarioId = await withTransaction(async (conn) => {
    const [claim] = await conn.query<ResultSetHeader>(
      'UPDATE password_resets SET usado_en = NOW() WHERE token_hash = ? AND usado_en IS NULL AND expira_en > NOW()', [hash]);
    if (claim.affectedRows !== 1) return null;
    const [[fila]] = await conn.query<RowDataPacket[]>('SELECT usuario_id FROM password_resets WHERE token_hash = ?', [hash]);
    const id = Number(fila!.usuario_id);
    const [upd] = await conn.query<ResultSetHeader>('UPDATE staff_users SET password_hash = ? WHERE id = ? AND activo = 1', [passwordHash, id]);
    if (upd.affectedRows !== 1) throw new Error('cuenta inactiva'); // revierte el reclamo
    // Salida de un bloqueo por intentos fallidos: el siguiente ingreso parte de cero.
    const [[u]] = await conn.query<RowDataPacket[]>('SELECT email FROM staff_users WHERE id = ?', [id]);
    const idHash = hashIdentificador(u!.email);
    await conn.query("INSERT INTO auth_intentos (ip, identificador_hash, exito) VALUES (?, ?, 1)", [ip, idHash]).catch(() => undefined);
    await conn.query('UPDATE password_resets SET usado_en = NOW() WHERE usuario_id = ? AND usado_en IS NULL', [id]);
    return id;
  }).catch((e: Error) => (e.message === 'cuenta inactiva' ? null : Promise.reject(e)));
  const resultado = usuarioId === null ? 'RECUPERACION_INVALIDA' : 'RECUPERACION_COMPLETADA';
  await auditarAcceso({ ip, userAgent, identificadorHash: null, usuarioId, resultado });
  return usuarioId === null ? 'INVALIDO' : 'OK';
}
