/**
 * Light TMS - Aviso al dueño de la herramienta (soporte) cuando un error del Ministerio NO está en el diccionario.
 *
 * Se registra como un incidente de tipo `rndc` (no corregible con código: no pasa al agente) agrupado por código, y se avisa al
 * propietario solo la primera vez. El diccionario se actualiza reemplazando docs/diccionario_errores_rndc.tsv (ver SOPORTE.md).
 * Nunca lanza: un fallo al avisar no puede romper la respuesta del chat. El mensaje ya llega sanitizado.
 */
import { registrarOcurrencia } from '../incidentes/incidentes.repo.js';
import { avisarPropietario } from '../incidentes/notificar.js';
import { huella } from '../incidentes/sanitizar.js';
import { sitioId, versionDespliegue } from '../incidentes/version.js';

export type MotivoSinGuia = 'desconocido' | 'variante_nueva';

export async function avisarErrorSinGuia(motivo: MotivoSinGuia, codigo: string, mensajeSanitizado: string): Promise<void> {
  try {
    const sitio = sitioId();
    // Código desconocido: un incidente por código (da igual el texto). Significado nuevo de un código ya conocido: uno por texto.
    const r = await registrarOcurrencia({
      sitio, huella: huella({ sitio, tipo: 'rndc', operacion: 'diccionario', codigo, mensaje: motivo === 'variante_nueva' ? mensajeSanitizado : '' }),
      tipo: 'rndc', origen: 'servidor', severidad: 'baja', corregible: false,
      titulo: `Error del Ministerio ${motivo === 'desconocido' ? 'sin guía' : 'con un significado nuevo'}: ${codigo}`,
      operacion: 'diccionario de errores', codigo, version: versionDespliegue(),
      evidencia: { tipo: 'servidor', contenido: JSON.stringify({ codigo, motivo, mensaje: mensajeSanitizado }), usuarioId: null, requestId: null },
    });
    if (r.nuevo) void avisarPropietario({ title: 'Error del Ministerio sin guía', body: `${codigo}: agrégalo al diccionario`, url: '/soporte', tag: `incidente-${r.id}` });
  } catch {
    /* el aviso es secundario */
  }
}
