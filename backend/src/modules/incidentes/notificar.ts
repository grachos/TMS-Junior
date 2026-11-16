/**
 * Light TMS - Avisos de incidentes. SIEMPRE a destinatarios concretos (nunca enviarATodos):
 *  - detalles técnicos → solo la cuenta del propietario (resuelta por su uuid, no por rol);
 *  - avisos a un usuario → solo quienes reportaron ESE incidente.
 * Un aviso es informativo: si el push no está configurado o falla, no se rompe nada.
 */

import type { RowDataPacket } from 'mysql2';
import { db } from '../../db/pool.js';
import { enviarAUsuarios, type PushPayload } from '../push/push.repo.js';
import { vinculoPropietario } from '../auth/propietario.js';
import { enviarCorreo } from '../auth/correo.js';

/** id de la cuenta del propietario, o null si no está configurado/vinculado (entonces no se avisa a nadie). */
export async function idPropietario(): Promise<number | null> {
  const v = vinculoPropietario();
  if (!v.ok) return null;
  try {
    const [rows] = await db().query<RowDataPacket[]>('SELECT id FROM staff_users WHERE uuid = ? AND activo = 1 LIMIT 1', [v.uuid]);
    return rows[0] ? Number(rows[0].id) : null;
  } catch {
    return null;
  }
}

export async function avisarPropietario(payload: PushPayload): Promise<void> {
  try {
    const id = await idPropietario();
    if (id !== null) await enviarAUsuarios([id], payload);
  } catch {
    /* un aviso no debe romper nada */
  }
}

export async function avisarUsuarios(ids: number[], payload: PushPayload): Promise<void> {
  try {
    await enviarAUsuarios(ids, payload);
  } catch {
    /* idem */
  }
}

const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Correo SOLO a la cuenta del propietario (su email se lee de la base por su uuid; nunca de un parámetro). Informativo: si el SMTP
 * no está configurado o falla, no se rompe nada. El texto lo arma quien llama con datos ya sanitizados (sin evidencia ni secretos).
 */
export async function avisarPropietarioPorCorreo(asunto: string, lineas: string[]): Promise<void> {
  try {
    const id = await idPropietario();
    if (id === null) return;
    const [rows] = await db().query<RowDataPacket[]>('SELECT email FROM staff_users WHERE id = ? LIMIT 1', [id]);
    const para = rows[0] ? String(rows[0].email ?? '') : '';
    if (!para) return;
    await enviarCorreo({
      para, asunto: asunto.slice(0, 150), texto: lineas.join('\n'),
      html: `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1f2937">${lineas.map((l) => `<p>${esc(l)}</p>`).join('')}</div>`,
    });
  } catch {
    /* un aviso no debe romper nada */
  }
}
