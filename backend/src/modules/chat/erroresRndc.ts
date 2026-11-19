/**
 * Light TMS - Guía de errores del Ministerio (RNDC) para el chat.
 *
 * El chat NO inventa causas ni soluciones: cuando un envío falla, el servidor busca el código del error en este catálogo y le
 * pasa al modelo la guía ya escrita (significado, causa probable, qué hacer). Si el código no está, la herramienta lo dice y el
 * modelo debe explicar solo lo que dice el mensaje del Ministerio, sin proponer soluciones inventadas.
 *
 * PARA AGREGAR UN ERROR: añade una entrada abajo (código exacto como lo devuelve el RNDC, p. ej. "MAN045"). Una prueba comprueba
 * que no haya códigos repetidos ni campos vacíos. `patron` es opcional: sirve cuando el mensaje llega sin el código.
 */

export interface GuiaErrorRndc {
  /** Código tal como lo devuelve el RNDC (3 letras + 3 dígitos). */
  codigo: string;
  /** Texto que identifica el error cuando el mensaje llega sin código (opcional). */
  patron?: RegExp;
  /** Qué significa, en lenguaje claro para el transportador. */
  significado: string;
  /** Causa probable en el documento. */
  causa: string;
  /** Pasos concretos para corregirlo y reenviar. */
  solucion: string[];
  /** Campo(s) del documento que normalmente hay que revisar. */
  campos?: string[];
}

export const GUIAS_ERROR_RNDC: readonly GuiaErrorRndc[] = [
  {
    codigo: 'MAN045',
    patron: /costos eficientes de operaci[oó]n|por debajo de los costos/i,
    significado: 'El flete pactado del manifiesto está por debajo de los costos eficientes de operación que establece el SICETAC para ese viaje; por eso el Ministerio no lo acepta.',
    causa: 'El valor del flete (valor total del viaje) es menor al costo de referencia del SICETAC para la ruta, la configuración del vehículo y el tipo de carga.',
    solucion: [
      'Consultar en el SICETAC el costo de referencia del viaje (origen, destino, configuración del vehículo, tipo de carga y horas logísticas).',
      'Subir el flete pactado del manifiesto a un valor igual o mayor al costo de referencia y verificar que el valor del anticipo/saldo sigan siendo coherentes con el nuevo flete.',
      'Corregir el manifiesto y reenviarlo desde la cola.',
    ],
    campos: ['valor_flete_pactado', 'origen y destino', 'configuración del vehículo'],
  },
];

const CODIGO = /\b([A-Z]{3}\d{3})\b/;

/** Código del RNDC dentro del texto del error ("MAN045: …"), o null. */
export function extraerCodigoRndc(texto: string | null | undefined): string | null {
  const m = CODIGO.exec(String(texto ?? ''));
  return m ? m[1]! : null;
}

/** Guía del catálogo para ese texto de error: primero por código exacto, luego por el patrón del mensaje. */
export function guiaDeError(texto: string | null | undefined): GuiaErrorRndc | null {
  const t = String(texto ?? '');
  const codigo = extraerCodigoRndc(t);
  if (codigo) {
    const porCodigo = GUIAS_ERROR_RNDC.find((g) => g.codigo === codigo);
    if (porCodigo) return porCodigo;
  }
  return GUIAS_ERROR_RNDC.find((g) => g.patron?.test(t)) ?? null;
}
