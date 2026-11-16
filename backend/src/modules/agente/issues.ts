/**
 * Light TMS - Crear el issue de GitHub de un incidente (fase 4). Solo propietario, a mano, opt-in.
 *  - elegibilidad decidida en el servidor (`politica.ts`);
 *  - un solo issue por incidente: se RESERVA con un UPDATE condicional antes de llamar a GitHub (doble clic / dos pestañas);
 *  - el agente NO se dispara aquí: el propietario pone la etiqueta `agente-corregir` en GitHub (esa es su aprobación);
 *  - los errores de GitHub no se reenvían (podrían repetir lo enviado).
 */
import type { RowDataPacket } from 'mysql2';
import { config } from '../../config/env.js';
import { db } from '../../db/pool.js';
import { evento } from '../incidentes/incidentes.repo.js';
import { avisarPropietarioPorCorreo } from '../incidentes/notificar.js';
import { cuerpoIssue, ETIQUETA_INCIDENTE, neutralizar, tituloIssue } from './cuerpoIssue.js';
import { evaluarElegibilidad, type Veredicto } from './politica.js';

export class IssueError extends Error {
  constructor(readonly codigo: 'deshabilitado' | 'no_elegible' | 'en_curso' | 'proveedor', mensaje: string) { super(mensaje); }
}

export const githubDisponible = (): boolean => { const g = config().soporteGithub; return Boolean(g.habilitado && g.token); };

export async function elegibilidadDe(incidenteId: number): Promise<Veredicto | null> {
  const [[i]] = await db().query<RowDataPacket[]>('SELECT corregible, tipo, issue_numero FROM incidentes WHERE id = ?', [incidenteId]);
  if (!i) return null;
  const [[d]] = await db().query<RowDataPacket[]>('SELECT categoria, confianza, corregible_con_codigo FROM incidente_diagnosticos WHERE incidente_id = ? ORDER BY id DESC LIMIT 1', [incidenteId]);
  return evaluarElegibilidad({
    corregible: Number(i.corregible), tipo: String(i.tipo), issueNumero: i.issue_numero ? Number(i.issue_numero) : null,
    diagnostico: d ? { categoria: String(d.categoria), confianza: String(d.confianza), corregibleConCodigo: d.corregible_con_codigo === null ? null : Number(d.corregible_con_codigo) } : null,
  });
}

export async function crearIssueDeIncidente(incidenteId: number, actorId: number): Promise<{ numero: number; url: string } | null> {
  const g = config().soporteGithub;
  if (!githubDisponible()) throw new IssueError('deshabilitado', 'La creación de issues no está habilitada en este sitio.');
  const [[i]] = await db().query<RowDataPacket[]>('SELECT id, titulo, operacion, tipo FROM incidentes WHERE id = ?', [incidenteId]);
  if (!i) return null;
  const v = await elegibilidadDe(incidenteId);
  if (!v?.elegible) throw new IssueError('no_elegible', v?.motivo ?? 'No elegible.');

  // Reserva: solo una petición pasa (y una reserva abandonada se puede retomar a los 2 minutos).
  const [res] = await db().query<import('mysql2').ResultSetHeader>(
    'UPDATE incidentes SET issue_reservado_en = NOW() WHERE id = ? AND issue_numero IS NULL AND (issue_reservado_en IS NULL OR issue_reservado_en < NOW() - INTERVAL 2 MINUTE)', [incidenteId]);
  if (res.affectedRows !== 1) throw new IssueError('en_curso', 'Ya se está creando (o ya existe) el issue de este incidente.');

  try {
    const [[d]] = await db().query<RowDataPacket[]>('SELECT categoria, confianza, resumen, hechos FROM incidente_diagnosticos WHERE incidente_id = ? ORDER BY id DESC LIMIT 1', [incidenteId]);
    const [[ev]] = await db().query<RowDataPacket[]>('SELECT contenido FROM incidente_evidencias WHERE incidente_id = ? ORDER BY id DESC LIMIT 1', [incidenteId]);
    let hechos: { texto?: unknown }[] = [];
    try { hechos = JSON.parse(String(d!.hechos ?? '[]')) as typeof hechos; } catch { /* sin hechos */ }
    const cuerpo = cuerpoIssue({
      id: incidenteId, titulo: String(i.titulo), operacion: i.operacion, tipo: String(i.tipo),
      diagnostico: { categoria: String(d!.categoria), confianza: String(d!.confianza), resumen: String(d!.resumen), hechos },
      evidencia: ev ? String(ev.contenido) : null, repoPrivado: g.repoPrivado,
    });
    let numero = 0; let url = '';
    try {
      const resp = await fetch(`${g.apiUrl.replace(/\/+$/, '')}/repos/${g.repo}/issues`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${g.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
        body: JSON.stringify({ title: tituloIssue(incidenteId, String(i.titulo)), body: cuerpo, labels: [ETIQUETA_INCIDENTE] }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const j = (await resp.json()) as { number?: unknown; html_url?: unknown };
      numero = Number(j.number); url = String(j.html_url ?? '');
      if (!Number.isInteger(numero) || numero <= 0 || !/^https:\/\//.test(url)) throw new Error('respuesta inesperada');
    } catch {
      throw new IssueError('proveedor', 'No se pudo crear el issue en GitHub. Intenta de nuevo más tarde.');
    }
    await db().query('UPDATE incidentes SET issue_numero = ?, issue_url = ? WHERE id = ?', [numero, url.slice(0, 255), incidenteId]);
    await evento(incidenteId, 'issue_creado', `Issue ${numero} creado en GitHub`, actorId);
    // Aviso al propietario por correo (GitHub no avisa al autor de su propio issue). Sin evidencia: solo título, enlace y el siguiente paso.
    void avisarPropietarioPorCorreo(`[Konekto soporte] Issue ${numero} creado para el incidente ${incidenteId}`, [
      `Se creó el issue ${numero} en GitHub para el incidente ${incidenteId}: ${neutralizar(i.titulo, 120)}`,
      url,
      'El agente no actúa solo: para que proponga una corrección, ponle la etiqueta agente-corregir en GitHub.',
    ]);
    return { numero, url };
  } catch (e) {
    // Si no se creó, se libera la reserva para poder reintentar. Si ya se creó (numero guardado) no se toca.
    await db().query('UPDATE incidentes SET issue_reservado_en = NULL WHERE id = ? AND issue_numero IS NULL', [incidenteId]);
    throw e;
  }
}
