/**
 * Light TMS - Política de autonomía del agente de corrección (fase 4; la fase 5 la lee también).
 * Está AQUÍ y no repartida por el código: un solo lugar que decide si un incidente puede pasar al agente.
 * Pura y sin I/O para poder probarla caso por caso.
 */

export interface EntradaPolitica {
  corregible: number | boolean;
  tipo: string;
  /** Último diagnóstico (null si no hay). */
  diagnostico: { categoria: string; confianza: string; corregibleConCodigo: number | boolean | null } | null;
  issueNumero: number | null;
}

export interface Veredicto { elegible: boolean; motivo: string }

/** Categorías cuya causa se arregla con un cambio de código. Todo lo demás (migración, configuración, RNDC, infraestructura, proveedor de IA, datos, permisos) NO. */
export const CATEGORIAS_CORREGIBLES_CON_CODIGO: readonly string[] = ['codigo'];

export function evaluarElegibilidad(e: EntradaPolitica): Veredicto {
  if (e.issueNumero) return { elegible: false, motivo: 'Este incidente ya tiene un issue.' };
  if (!e.corregible) return { elegible: false, motivo: 'El incidente está marcado como no corregible con cambios de código.' };
  if (e.tipo !== 'codigo') return { elegible: false, motivo: `El tipo "${e.tipo}" no se corrige con cambios de código.` };
  if (!e.diagnostico) return { elegible: false, motivo: 'Primero hay que diagnosticar el incidente.' };
  if (!CATEGORIAS_CORREGIBLES_CON_CODIGO.includes(e.diagnostico.categoria)) return { elegible: false, motivo: `El diagnóstico lo ubica en "${e.diagnostico.categoria}", que no se corrige con código.` };
  if (e.diagnostico.corregibleConCodigo === false || e.diagnostico.corregibleConCodigo === 0) return { elegible: false, motivo: 'El diagnóstico indica que no se resuelve con código.' };
  return { elegible: true, motivo: 'Elegible: error de código sin causa externa identificada.' };
}
