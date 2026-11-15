import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Loader2, RefreshCw } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { ExplicacionReporte, type VistaReporte } from './ExplicacionReporte';

const CLAVE_VISTOS = 'konekto-reportes-vistos';

/** Comodidad por navegador (qué novedades ya viste): nunca es fuente de verdad, y si el almacenamiento falla todo sigue funcionando. */
export function leerVistos(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(CLAVE_VISTOS) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}
export function marcarVisto(id: number, actualizado: string): void {
  try {
    localStorage.setItem(CLAVE_VISTOS, JSON.stringify({ ...leerVistos(), [id]: actualizado }));
  } catch {
    /* sin almacenamiento */
  }
}
export function contarNovedades(reportes: VistaReporte[]): number {
  const vistos = leerVistos();
  return reportes.filter((r) => vistos[r.id] !== r.actualizado && r.estado.codigo !== 'nuevo').length;
}

export function MisReportes({ reportes, cargando, recargar }: { reportes: VistaReporte[]; cargando: boolean; recargar: () => void }) {
  const [abierto, setAbierto] = useState<VistaReporte | null>(null);
  const [error, setError] = useState<string | null>(null);

  const abrir = useCallback(async (r: VistaReporte) => {
    setError(null);
    try {
      const completo = await api<VistaReporte>(`/reportes/${r.id}`);
      marcarVisto(r.id, completo.actualizado);
      setAbierto(completo);
      recargar();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'No se pudo abrir el reporte.');
    }
  }, [recargar]);

  // Se refresca solo mientras está abierto (el estado cambia cuando el equipo avanza).
  useEffect(() => {
    const t = setInterval(recargar, 60_000);
    return () => clearInterval(t);
  }, [recargar]);

  if (abierto) {
    return (
      <div className="space-y-3 p-3">
        <button className="flex items-center gap-1 text-sm text-celeste-700" onClick={() => setAbierto(null)}>
          <ArrowLeft size={14} /> Mis reportes
        </button>
        <div>
          <p className="text-sm font-semibold text-slate-800">Reporte #{abierto.id}</p>
          <p className="mt-1 whitespace-pre-wrap rounded-lg bg-slate-100 px-2.5 py-1.5 text-sm text-slate-600">{abierto.texto}</p>
        </div>
        <ExplicacionReporte v={abierto} />
      </div>
    );
  }

  return (
    <div className="p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs text-slate-400">Solo ves tus propios reportes.</p>
        <button className="text-slate-400 hover:text-slate-600" onClick={recargar} aria-label="Actualizar">
          {cargando ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        </button>
      </div>
      {error && <p className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {reportes.length === 0 && !cargando && <p className="mt-8 text-center text-sm text-slate-400">Todavía no has reportado nada.</p>}
      <ul className="space-y-2">
        {reportes.map((r) => {
          const nuevo = leerVistos()[r.id] !== r.actualizado && r.estado.codigo !== 'nuevo';
          return (
            <li key={r.id}>
              <button onClick={() => void abrir(r)} className="w-full rounded-lg border border-slate-200 bg-surface p-2.5 text-left hover:border-celeste-400">
                <div className="flex items-center justify-between gap-2">
                  <span className="rounded-full bg-celeste-100 px-2 py-0.5 text-xs font-semibold text-celeste-800 dark:bg-celeste-500/20 dark:text-celeste-300">{r.estado.etiqueta}</span>
                  {nuevo && <span className="rounded-full bg-emerald-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">Novedad</span>}
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-slate-700">{r.texto}</p>
                <p className="mt-1 text-xs text-slate-400">
                  #{r.id} · {new Date(r.creado.replace(' ', 'T')).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' })}
                  {r.pantalla ? ` · ${r.pantalla}` : ''}
                </p>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
