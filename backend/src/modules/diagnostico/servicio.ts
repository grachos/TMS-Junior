/**
 * Light TMS - Servicio de diagnóstico: ejecuta las reglas, guarda el resultado y aplica los EFECTOS permitidos.
 *
 * Efectos (todos con UPDATE condicional, así lo que haga el propietario al mismo tiempo siempre gana):
 *  - nuevo → en_diagnostico (nada más: "causa identificada" lo fija el propietario al aplicar el borrador, o la política de la fase 5);
 *  - `corregible` solo puede BAJAR (1 → 0) y solo con una causa confirmada de categoría no corregible con código; ningún diagnóstico lo sube
 *    (la elegibilidad de la fase 4 lee ese indicador);
 *  - tipo: de "codigo" a "migracion" cuando una migración pendiente quedó confirmada.
 * Nunca envía push: avisar al usuario es una decisión explícita del propietario (`notificar`).
 */

import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { db, withTransaction } from '../../db/pool.js';
import { evento } from '../incidentes/incidentes.repo.js';
import { sanitizarTexto } from '../incidentes/sanitizar.js';
import { versionDespliegue } from '../incidentes/version.js';
import { reunirContexto } from './contexto.js';
import { borradorPublicoDe, diagnosticar, type Confianza, type Diagnostico } from './reglas.js';

const MAX_POR_INCIDENTE = 5;
const PAUSA_MS = 60_000;
let pausadoHasta = 0;
/** Solo pruebas. */
export function reiniciarInterruptorDiagnostico(): void { pausadoHasta = 0; }

export async function diagnosticarIncidente(incidenteId: number, actorId: number | null = null): Promise<(Diagnostico & { id: number }) | null> {
  const ctx = await reunirContexto(incidenteId);
  if (!ctx) return null;
  const d = diagnosticar(ctx);
  const id = await withTransaction(async (conn) => {
    const [r] = await conn.query<ResultSetHeader>(
      `INSERT INTO incidente_diagnosticos (incidente_id, version_reglas, version_despliegue, categoria, confianza, corregible_con_codigo, resumen, posible_causa, causa_confirmada, accion_temporal, siguiente_paso, hechos, referencias)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [incidenteId, d.versionReglas, versionDespliegue(), d.categoria, d.confianza, d.corregibleConCodigo === null ? null : d.corregibleConCodigo ? 1 : 0, sanitizarTexto(d.resumen, 400),
        d.posibleCausa && sanitizarTexto(d.posibleCausa, 1000), d.causaConfirmada && sanitizarTexto(d.causaConfirmada, 1000), d.accionTemporal && sanitizarTexto(d.accionTemporal, 1000),
        sanitizarTexto(d.siguientePaso, 1000), JSON.stringify(d.hechos), JSON.stringify(d.referencias)]);
    // Se conservan los últimos MAX_POR_INCIDENTE.
    await conn.query(
      `DELETE FROM incidente_diagnosticos WHERE incidente_id = ? AND id <= COALESCE((SELECT id FROM (SELECT id FROM incidente_diagnosticos WHERE incidente_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?) t), 0)`,
      [incidenteId, incidenteId, MAX_POR_INCIDENTE]);
    await evento(incidenteId, 'diagnostico', `${d.categoria} / ${d.confianza}`, actorId, conn);
    // Efectos condicionales (el propietario manda: si ya cambió algo, no se pisa).
    const [e1] = await conn.query<ResultSetHeader>("UPDATE incidentes SET estado = 'en_diagnostico' WHERE id = ? AND estado = 'nuevo'", [incidenteId]);
    if (e1.affectedRows) await evento(incidenteId, 'estado', 'nuevo → en_diagnostico (diagnóstico automático)', actorId, conn);
    if (d.confianza === 'confirmada' && d.corregibleConCodigo === false) {
      const [e2] = await conn.query<ResultSetHeader>('UPDATE incidentes SET corregible = 0 WHERE id = ? AND corregible = 1', [incidenteId]);
      if (e2.affectedRows) await evento(incidenteId, 'edicion', 'Corregible con código: sí → no (causa confirmada que no se resuelve con código)', actorId, conn);
      if (d.categoria === 'migracion') {
        const [e3] = await conn.query<ResultSetHeader>("UPDATE incidentes SET tipo = 'migracion' WHERE id = ? AND tipo = 'codigo'", [incidenteId]);
        if (e3.affectedRows) await evento(incidenteId, 'edicion', 'Tipo: codigo → migracion (confirmado)', actorId, conn);
      }
    }
    return r.insertId;
  });
  return { ...d, id };
}

/** Diagnóstico automático: nunca lanza hacia quien llama y, si falla, se calla un minuto (mismo criterio que la captura). */
export async function diagnosticarEnSegundoPlano(incidenteId: number): Promise<void> {
  try {
    if (Date.now() < pausadoHasta) return;
    await diagnosticarIncidente(incidenteId);
  } catch {
    pausadoHasta = Date.now() + PAUSA_MS;
  }
}

export interface DiagnosticoGuardado {
  id: number; incidente_id: number; version_reglas: string; version_despliegue: string | null; categoria: string; confianza: Confianza; corregible_con_codigo: number | null;
  resumen: string; posible_causa: string | null; causa_confirmada: string | null; accion_temporal: string | null; siguiente_paso: string | null;
  hechos: unknown[]; referencias: unknown[]; aplicado_en: string | null; created_at: string;
}

export async function listarDiagnosticos(incidenteId: number): Promise<DiagnosticoGuardado[]> {
  const [rows] = await db().query<RowDataPacket[]>('SELECT * FROM incidente_diagnosticos WHERE incidente_id = ? ORDER BY id DESC LIMIT ?', [incidenteId, MAX_POR_INCIDENTE]);
  const j = (v: unknown) => { try { return JSON.parse(String(v ?? '[]')) as unknown[]; } catch { return []; } };
  return rows.map((r) => ({ ...(r as unknown as DiagnosticoGuardado), hechos: j(r.hechos), referencias: j(r.referencias) }));
}

/**
 * Usa el borrador PÚBLICO de un diagnóstico como explicación del incidente. Se aplica en el SERVIDOR:
 *  - el texto sale de las plantillas fijas según categoría y confianza GUARDADAS (no de lo que mande el navegador);
 *  - `causa confirmada` solo se copia si la confianza guardada es "confirmada";
 *  - no pisa lo que el propietario ya escribió, salvo `sobrescribir`.
 * No notifica a nadie.
 */
export async function aplicarBorrador(
  incidenteId: number, diagnosticoId: number, opciones: { sobrescribir?: boolean }, actorId: number,
): Promise<{ campos: string[] } | null> {
  return withTransaction(async (conn) => {
    const [[d]] = await conn.query<RowDataPacket[]>('SELECT categoria, confianza FROM incidente_diagnosticos WHERE id = ? AND incidente_id = ?', [diagnosticoId, incidenteId]);
    if (!d) return null;
    const [[i]] = await conn.query<RowDataPacket[]>('SELECT exp_hecho, exp_posible_causa, exp_causa_confirmada, exp_accion_temporal, exp_estado_correccion FROM incidentes WHERE id = ? FOR UPDATE', [incidenteId]);
    if (!i) return null;
    const b = borradorPublicoDe(d.categoria, d.confianza as Confianza);
    const pares: [string, string, string | null][] = [
      ['hecho', 'exp_hecho', b.hecho], ['posibleCausa', 'exp_posible_causa', b.posibleCausa], ['causaConfirmada', 'exp_causa_confirmada', b.causaConfirmada],
      ['accionTemporal', 'exp_accion_temporal', b.accionTemporal], ['estadoCorreccion', 'exp_estado_correccion', b.estadoCorreccion],
    ];
    const sets: string[] = []; const args: (string | number)[] = []; const campos: string[] = [];
    for (const [nombre, col, valor] of pares) {
      if (valor === null) continue;
      const vacio = !String(i[col] ?? '').trim();
      if (!vacio && !opciones.sobrescribir) continue;
      sets.push(`${col} = ?`); args.push(sanitizarTexto(valor, 1000)); campos.push(nombre);
    }
    if (sets.length) await conn.query(`UPDATE incidentes SET ${sets.join(', ')} WHERE id = ?`, [...args, incidenteId]);
    await conn.query('UPDATE incidente_diagnosticos SET aplicado_en = NOW() WHERE id = ?', [diagnosticoId]);
    await evento(incidenteId, 'diagnostico_aplicado', campos.length ? `Borrador público aplicado: ${campos.join(', ')}` : 'Borrador público: no había campos vacíos', actorId, conn);
    return { campos };
  });
}
