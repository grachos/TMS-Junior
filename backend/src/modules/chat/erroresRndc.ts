/**
 * Light TMS - Guía de errores del Ministerio (RNDC) para el chat.
 *
 * Fuente: el "Maestro Diccionario de Errores RNDC" (docs/diccionario_errores_rndc.tsv → diccionarioErroresRndc.data.ts, generado con
 * scripts/generar-diccionario-errores.mjs). El chat NO inventa causas ni soluciones: el servidor busca el error en el diccionario y le
 * pasa al modelo lo que dice el Ministerio (significado, variable y solución).
 *
 * Un mismo código puede tener VARIOS significados (p. ej. MAN055 tiene tres), así que si hay varias entradas se elige por parecido
 * del mensaje real con el del diccionario. Resultados posibles:
 *   - encontrada: una entrada clara  → se usa su solución.
 *   - ambigua:    varias plausibles  → se le pasan al modelo como opciones (no se adivina).
 *   - variante_nueva: el código existe pero ningún significado se parece → se avisa al dueño de la herramienta (soporte).
 *   - desconocido: el código no está en el diccionario                     → se avisa al dueño de la herramienta (soporte).
 *   - sin_codigo: el error no trae código del Ministerio (p. ej. falla de conexión) → no es del diccionario; no se avisa.
 */

import { DICCIONARIO_ERRORES_RNDC } from './diccionarioErroresRndc.data.js';

export interface EntradaDiccionario {
  codigo: string;
  procesoId: number;
  proceso: string;
  /** E = error, A = alerta, I = información. */
  tipo: string;
  variable: string;
  mensaje: string;
  solucion: string;
}

const PORCODIGO = new Map<string, EntradaDiccionario[]>();
for (const [codigo, procesoId, proceso, tipo, variable, mensaje, solucion] of DICCIONARIO_ERRORES_RNDC) {
  const e: EntradaDiccionario = { codigo, procesoId, proceso, tipo, variable, mensaje, solucion };
  const lista = PORCODIGO.get(codigo);
  if (lista) lista.push(e); else PORCODIGO.set(codigo, [e]);
}

export const TOTAL_ENTRADAS = DICCIONARIO_ERRORES_RNDC.length;
export const entradasDe = (codigo: string): readonly EntradaDiccionario[] => PORCODIGO.get(codigo) ?? [];

/** Ampliaciones escritas a mano para errores frecuentes: pasos concretos además de la solución oficial. Se asocian por código. */
export const AMPLIACIONES: Readonly<Record<string, readonly string[]>> = {
  MAN045: [
    'Consultar en el SICETAC el costo de referencia del viaje (origen, destino, configuración del vehículo, tipo de carga y horas logísticas).',
    'Subir el flete pactado del manifiesto a un valor igual o mayor al costo de referencia y verificar que el anticipo y el saldo sigan siendo coherentes con el nuevo flete.',
    'Corregir el manifiesto y reenviarlo desde la cola.',
  ],
};

const CANDIDATO = /\b([A-Z]{3,6}\d{2,3})\b/g;

/** Códigos con forma de código del Ministerio dentro del texto del error, en orden de aparición. */
export function codigosEnTexto(texto: string | null | undefined): string[] {
  return [...String(texto ?? '').matchAll(CANDIDATO)].map((m) => m[1]!);
}

/** Código del error: el primero que esté en el diccionario; si ninguno, el primero con forma de código; si no hay, null. */
export function extraerCodigoRndc(texto: string | null | undefined): string | null {
  const todos = codigosEnTexto(texto);
  return todos.find((c) => PORCODIGO.has(c)) ?? todos[0] ?? null;
}

const quitarAcentos = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
function palabras(s: string): Set<string> {
  return new Set(quitarAcentos(s.toLowerCase()).split(/[^a-z0-9]+/).filter((p) => p.length >= 3 && !/^\d+$/.test(p)));
}
/** Coeficiente de Dice entre dos textos (0–1) sobre sus palabras; ignora números (son datos del caso, no del tipo de error). */
export function parecido(a: string, b: string): number {
  const A = palabras(a); const B = palabras(b);
  if (!A.size || !B.size) return 0;
  let comunes = 0;
  for (const p of A) if (B.has(p)) comunes++;
  return (2 * comunes) / (A.size + B.size);
}

export const UMBRAL_CLARO = 0.45;
export const UMBRAL_PLAUSIBLE = 0.25;
const MARGEN = 0.1;

export type ResultadoGuia =
  | { estado: 'encontrada'; codigo: string; entrada: EntradaDiccionario; ampliacion: readonly string[] }
  | { estado: 'ambigua'; codigo: string; candidatas: EntradaDiccionario[] }
  | { estado: 'variante_nueva'; codigo: string }
  | { estado: 'desconocido'; codigo: string }
  | { estado: 'sin_codigo' };

/** Busca el error del Ministerio en el diccionario. `texto` es el mensaje real tal como lo devolvió el RNDC. */
export function buscarGuia(texto: string | null | undefined): ResultadoGuia {
  const t = String(texto ?? '');
  const codigo = extraerCodigoRndc(t);
  if (!codigo) return { estado: 'sin_codigo' };
  const entradas = PORCODIGO.get(codigo);
  if (!entradas) return { estado: 'desconocido', codigo };

  // El mensaje sin el código: lo que queda se compara con cada significado del diccionario.
  const mensaje = t.split(codigo).join(' ');
  const hayMensaje = palabras(mensaje).size > 0;
  const puntuadas = entradas.map((e) => ({ e, p: hayMensaje ? parecido(mensaje, e.mensaje) : 0 })).sort((x, y) => y.p - x.p);
  const mejor = puntuadas[0]!;
  const ampliacion = AMPLIACIONES[codigo] ?? [];

  if (!hayMensaje) {
    return entradas.length === 1 ? { estado: 'encontrada', codigo, entrada: entradas[0]!, ampliacion } : { estado: 'ambigua', codigo, candidatas: entradas.slice(0, 3) };
  }
  // Un solo significado conocido para ese código: el código manda; solo se descarta si el mensaje no se parece en nada (significado nuevo).
  if (entradas.length === 1) return mejor.p >= UMBRAL_PLAUSIBLE ? { estado: 'encontrada', codigo, entrada: mejor.e, ampliacion } : { estado: 'variante_nueva', codigo };
  if (mejor.p >= UMBRAL_CLARO && mejor.p - puntuadas[1]!.p >= MARGEN) return { estado: 'encontrada', codigo, entrada: mejor.e, ampliacion };
  const plausibles = puntuadas.filter((x) => x.p >= UMBRAL_PLAUSIBLE).slice(0, 3).map((x) => x.e);
  if (plausibles.length === 1) return { estado: 'encontrada', codigo, entrada: plausibles[0]!, ampliacion };
  if (plausibles.length > 1) return { estado: 'ambigua', codigo, candidatas: plausibles };
  return { estado: 'variante_nueva', codigo };
}
