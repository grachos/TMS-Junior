/**
 * Light TMS - Permisos por acción (botones críticos).
 *
 * Además de las páginas (menús) que ve un usuario, un administrador puede
 * decidir qué acciones críticas puede ejecutar: enviar al RNDC, anular,
 * cancelar envíos, configurar impuestos, etc.
 *
 *   - Administrador: siempre puede todo.
 *   - Operador con `acciones = null`: usa los valores por defecto del catálogo
 *     (lo que ya podía o no podía antes de existir esta configuración).
 *   - Operador con una lista: SOLO esas acciones.
 *
 * El servidor es quien decide (requireAccion); la interfaz solo oculta botones.
 * Usuarios y asignación de permisos siguen siendo exclusivos del administrador.
 */

export interface AccionDef {
  clave: string;
  label: string;
  grupo: string;
  /** ¿Un operador sin configuración la puede ejecutar? (= comportamiento previo) */
  operador: boolean;
}

export const ACCIONES_DEF = [
  // Se pueden quitar a un operador
  { clave: 'solicitud.despachar', label: 'Confirmar despachos', grupo: 'Solicitudes', operador: true },
  { clave: 'solicitud.interna', label: 'Marcar o desmarcar una solicitud como Interna', grupo: 'Solicitudes', operador: true },
  { clave: 'despacho.editar', label: 'Editar un despacho', grupo: 'Despachos', operador: true },
  { clave: 'cumplido.guardar', label: 'Guardar cumplidos', grupo: 'Cumplido', operador: true },
  // Críticas: por defecto solo el administrador
  { clave: 'despacho.enviar', label: 'Enviar un despacho al RNDC', grupo: 'Despachos', operador: false },
  { clave: 'despacho.consultar_qr', label: 'Consultar el QR del manifiesto', grupo: 'Despachos', operador: false },
  { clave: 'despacho.anular', label: 'Anular un despacho', grupo: 'Despachos', operador: false },
  { clave: 'cola.procesar', label: 'Procesar la cola de envíos', grupo: 'Cola de envíos', operador: false },
  { clave: 'cola.cancelar', label: 'Cancelar envíos de la cola', grupo: 'Cola de envíos', operador: false },
  { clave: 'cola.anular', label: 'Anular documentos desde la cola', grupo: 'Cola de envíos', operador: false },
  { clave: 'tercero.registrar_rndc', label: 'Registrar terceros en el RNDC', grupo: 'Terceros', operador: false },
  { clave: 'vehiculo.registrar_rndc', label: 'Registrar vehículos en el RNDC', grupo: 'Vehículos', operador: false },
  { clave: 'empresa.editar', label: 'Editar los datos de la empresa y del RNDC', grupo: 'Empresa', operador: false },
  { clave: 'impuestos.gestionar', label: 'Ver y configurar impuestos (ICA)', grupo: 'Menús', operador: false },
  { clave: 'actividad.ver', label: 'Ver la actividad (auditoría)', grupo: 'Menús', operador: false },
] as const satisfies readonly AccionDef[];

export type Accion = (typeof ACCIONES_DEF)[number]['clave'];
export const ACCIONES = ACCIONES_DEF.map((a) => a.clave) as [Accion, ...Accion[]];

/** Acciones de un operador sin configuración (comportamiento anterior). */
export const ACCIONES_POR_DEFECTO: Accion[] = ACCIONES_DEF.filter((a) => a.operador).map((a) => a.clave);

interface ConPermisos {
  rol: 'admin' | 'operador';
  acciones?: readonly string[] | null;
}

/** ¿Puede este usuario ejecutar la acción? (única fuente de la regla; la usan servidor y pruebas) */
export function tieneAccion(u: ConPermisos, accion: Accion): boolean {
  if (u.rol === 'admin') return true;
  const lista = u.acciones ?? ACCIONES_POR_DEFECTO;
  return lista.includes(accion);
}

/** Deja solo claves conocidas y sin repetir (una clave vieja o inventada nunca da permiso). */
export function normalizarAcciones(lista: readonly string[] | null | undefined): Accion[] | null {
  if (lista === null || lista === undefined) return null;
  const validas = new Set<string>(ACCIONES);
  return [...new Set(lista)].filter((a): a is Accion => validas.has(a));
}
