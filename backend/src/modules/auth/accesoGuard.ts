/**
 * Light TMS - Defensas del login (parte pública).
 *
 *  - Límites por IP y por cuenta, contados en la BASE (auth_intentos, v55): el
 *    hosting puede correr varios procesos y la memoria no se comparte.
 *  - El intento se inserta ANTES de verificar la contraseña y se cuenta junto
 *    con los anteriores: una ráfaga simultánea no se cuela por encima del límite.
 *  - Los fallos de una cuenta se cuentan desde el último éxito POR ORDEN (id),
 *    no por hora (la hora tiene precisión de segundos).
 *  - Mismo límite exista o no la cuenta: no se averigua quién existe por cuándo
 *    se bloquea. El correo se guarda solo como hash SHA-256.
 *  - Los bloqueos vencen solos (nunca hay bloqueo permanente: sería un arma para
 *    dejar fuera a un usuario real).
 *  - Cada intento queda en auth_auditoria (IP, navegador, resultado). Nunca
 *    contraseñas ni tokens.
 */

import { createHash } from 'node:crypto';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import { db } from '../../db/pool.js';

export interface Limites {
  ventanaMin: number;
  /** Intentos totales por IP en la ventana (cualquier resultado). */
  ipTotal: number;
  /** Intentos FALLIDOS por IP: probar una contraseña en muchas cuentas. */
  ipFallos: number;
  /** Intentos fallidos por cuenta desde su último éxito. */
  cuentaFallos: number;
}

const num = (v: string | undefined, def: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
};

/**
 * Valores por defecto. Una oficina entra desde una sola IP, así que el límite
 * por IP cuenta solo FALLOS (no los ingresos buenos). En pruebas automáticas
 * todo viene de 127.0.0.1: el límite por IP se sube; los límites por IP se
 * prueban pasando `Limites` a mano.
 */
export function limitesPorDefecto(): Limites {
  const prueba = process.env.NODE_ENV === 'test';
  return {
    ventanaMin: 15,
    ipTotal: prueba ? 1_000_000 : num(process.env.AUTH_IP_TOTAL_MAX, 60),
    ipFallos: prueba ? 1_000_000 : num(process.env.AUTH_IP_FALLOS_MAX, 20),
    cuentaFallos: num(process.env.AUTH_CUENTA_FALLOS_MAX, 5),
  };
}

/** Lo tecleado como correo se guarda solo como hash (y sin distinguir mayúsculas). */
export function hashIdentificador(raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const v = String(raw).trim().toLowerCase().slice(0, 190);
  return v ? createHash('sha256').update(v).digest('hex') : null;
}

export type Bloqueo = 'IP' | 'CUENTA' | null;

async function contar(sql: string, args: unknown[]): Promise<number> {
  const [rows] = await db().query<RowDataPacket[]>(sql, args as never[]);
  return Number(rows[0]?.n ?? 0);
}

/** Registra el intento (como fallido) y dice si hay que bloquearlo. */
export async function registrarIntento(
  ip: string, identificadorHash: string | null, lim: Limites = limitesPorDefecto(),
): Promise<{ id: number; bloqueo: Bloqueo }> {
  const [ins] = await db().query<ResultSetHeader>(
    'INSERT INTO auth_intentos (ip, identificador_hash, exito) VALUES (?, ?, 0)', [ip, identificadorHash],
  );
  const id = ins.insertId;
  const w = lim.ventanaMin;

  const total = await contar('SELECT COUNT(*) AS n FROM auth_intentos WHERE ip = ? AND created_at >= NOW() - INTERVAL ? MINUTE', [ip, w]);
  if (total > lim.ipTotal) return { id, bloqueo: 'IP' };
  const fallosIp = await contar(
    'SELECT COUNT(*) AS n FROM auth_intentos WHERE ip = ? AND exito = 0 AND created_at >= NOW() - INTERVAL ? MINUTE', [ip, w],
  );
  if (fallosIp > lim.ipFallos) return { id, bloqueo: 'IP' };

  if (identificadorHash) {
    const fallosCuenta = await contar(
      `SELECT COUNT(*) AS n FROM auth_intentos
       WHERE identificador_hash = ? AND exito = 0 AND created_at >= NOW() - INTERVAL ? MINUTE
         AND id > COALESCE((SELECT MAX(id) FROM auth_intentos WHERE identificador_hash = ? AND exito = 1), 0)`,
      [identificadorHash, w, identificadorHash],
    );
    if (fallosCuenta > lim.cuentaFallos) return { id, bloqueo: 'CUENTA' };
  }
  return { id, bloqueo: null };
}

/** Un ingreso correcto reinicia el conteo de fallos de esa cuenta y purga lo viejo. */
export async function marcarExito(id: number): Promise<void> {
  await db().query('UPDATE auth_intentos SET exito = 1 WHERE id = ?', [id]);
  await db().query('DELETE FROM auth_intentos WHERE created_at < NOW() - INTERVAL 2 DAY LIMIT 1000');
}

export type ResultadoAcceso = 'EXITO' | 'CREDENCIALES' | 'BLOQUEO_CUENTA' | 'BLOQUEO_IP' | 'SOLICITUD_INVALIDA';

/** Auditoría del intento. Nunca debe tumbar el login: un fallo se registra en el log y ya. */
export async function auditarAcceso(a: {
  ip: string; userAgent: string | null; identificadorHash: string | null; usuarioId: number | null; resultado: ResultadoAcceso;
}): Promise<void> {
  try {
    await db().query(
      'INSERT INTO auth_auditoria (ip, user_agent, identificador_hash, usuario_id, resultado) VALUES (?, ?, ?, ?, ?)',
      [a.ip.slice(0, 64), a.userAgent ? a.userAgent.slice(0, 255) : null, a.identificadorHash, a.usuarioId, a.resultado],
    );
    if (a.resultado === 'EXITO') {
      await db().query('DELETE FROM auth_auditoria WHERE created_at < NOW() - INTERVAL 365 DAY LIMIT 1000');
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[auth] no se pudo registrar la auditoría de acceso', (e as Error).message);
  }
}
