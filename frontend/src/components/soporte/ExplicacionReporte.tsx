import type { ReactNode } from 'react';
import { fechaCorta } from '../../lib/fechaDb';

export interface VistaReporte {
  id: number;
  creado: string;
  pantalla: string | null;
  texto: string;
  estado: { codigo: string; etiqueta: string };
  explicacion: { hecho: string | null; posibleCausa: string | null; causaConfirmada: string | null; accionTemporal: string | null; estadoCorreccion: string | null };
  mensajes: { texto: string; fecha: string }[];
  actualizado: string;
}

function Bloque({ titulo, texto, vacio }: { titulo: string; texto: string | null; vacio: string }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{titulo}</p>
      <p className={`mt-0.5 whitespace-pre-wrap text-sm ${texto ? 'text-slate-700' : 'italic text-slate-400'}`}>{texto ?? vacio}</p>
    </div>
  );
}

/**
 * Las 5 cosas que se distinguen SIEMPRE en una respuesta de soporte: hecho observado, posible causa, causa confirmada (solo si hay
 * evidencia), acción temporal y estado real de la corrección. Lo que nadie ha completado se muestra como "todavía no hay
 * información": no se inventa ni se promete nada.
 */
export function ExplicacionReporte({ v, extra }: { v: VistaReporte; extra?: ReactNode }) {
  const e = v.explicacion;
  return (
    <div className="space-y-3">
      <span className="inline-block rounded-full bg-celeste-100 px-2.5 py-0.5 text-xs font-semibold text-celeste-800 dark:bg-celeste-500/20 dark:text-celeste-300">{v.estado.etiqueta}</span>
      <Bloque titulo="Lo que observamos" texto={e.hecho} vacio="Todavía no hay información." />
      <Bloque titulo="Posible causa" texto={e.posibleCausa} vacio="Todavía no hay información." />
      <Bloque titulo="Causa confirmada" texto={e.causaConfirmada} vacio="Aún no está confirmada." />
      <Bloque
        titulo="Qué puedes hacer mientras tanto"
        texto={e.accionTemporal}
        vacio="Todavía no tenemos una recomendación. Antes de repetir la operación, revisa en la pantalla si quedó registrada."
      />
      <Bloque titulo="Estado de la corrección" texto={e.estadoCorreccion} vacio={`${v.estado.etiqueta}. No hay más detalles todavía.`} />
      {v.mensajes.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Novedades del equipo</p>
          <ul className="mt-1 space-y-1.5">
            {v.mensajes.map((m, i) => (
              <li key={i} className="rounded-lg border border-slate-200 bg-surface px-2.5 py-1.5 text-sm text-slate-700">
                {m.texto}
                <span className="ml-2 text-xs text-slate-400">{fechaCorta(m.fecha)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {extra}
    </div>
  );
}
