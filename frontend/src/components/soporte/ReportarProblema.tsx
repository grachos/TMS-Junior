import { useEffect, useState, type FormEvent } from 'react';
import { Loader2, Send } from 'lucide-react';
import { api, ApiError, ultimoRequestIdFallido } from '../../lib/api';
import { useEnvioUnico } from '../../lib/useEnvioUnico';
import { ExplicacionReporte, type VistaReporte } from './ExplicacionReporte';

/**
 * Reportar un problema: NO depende del asistente de IA (funciona aunque OpenRouter esté caído o apagado). Se adjunta la pantalla
 * actual y, si hubo un error del servidor hace poco, su código de correlación para que el equipo lo encuentre.
 */
export function ReportarProblema({ pantalla, inicial, alRegistrar }: { pantalla: string; inicial: string; alRegistrar: () => void }) {
  const [texto, setTexto] = useState(inicial);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [registrado, setRegistrado] = useState<VistaReporte | null>(null);
  const envio = useEnvioUnico();
  const conCodigo = ultimoRequestIdFallido() !== null;
  const [conocido, setConocido] = useState<VistaReporte | null>(null);

  // Si el último error de ESTE usuario ya es un incidente conocido, se le muestra lo que se sabe (misma explicación en 5 partes).
  useEffect(() => {
    const rid = ultimoRequestIdFallido();
    if (!rid) return;
    let vivo = true;
    void api<{ conocido: boolean; estado?: VistaReporte['estado']; explicacion?: VistaReporte['explicacion'] }>(`/reportes/error/${encodeURIComponent(rid)}`)
      .then((r) => { if (vivo && r.conocido && r.estado && r.explicacion) setConocido({ id: 0, creado: '', pantalla: null, texto: '', estado: r.estado, explicacion: r.explicacion, mensajes: [], actualizado: '' }); })
      .catch(() => { /* sin conexión: no se muestra nada extra */ });
    return () => { vivo = false; };
  }, []);

  async function enviar(e: FormEvent) {
    e.preventDefault();
    if (texto.trim().length < 5 || !envio.tomar()) return;
    setEnviando(true);
    setError(null);
    try {
      const requestId = ultimoRequestIdFallido() ?? undefined;
      const v = await api<VistaReporte>('/reportes', { method: 'POST', body: { texto: texto.trim(), pantalla, ...(requestId ? { requestId } : {}) } });
      setRegistrado(v);
      setTexto('');
      alRegistrar();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo enviar el reporte. Inténtalo de nuevo.');
    } finally {
      setEnviando(false);
      envio.soltar();
    }
  }

  if (registrado) {
    return (
      <div className="space-y-3 p-3">
        <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-emerald-200">
          Recibimos tu reporte <strong>#{registrado.id}</strong>. Esto es lo que sabemos hasta ahora:
        </p>
        <ExplicacionReporte v={registrado} />
        <button className="btn-ghost w-full justify-center" onClick={() => setRegistrado(null)}>
          Enviar otro reporte
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={enviar} className="flex h-full flex-col gap-2 overflow-y-auto p-3">
      {conocido && (
        <div className="space-y-2 rounded-lg bg-slate-50 p-3 ring-1 ring-slate-200">
          <p className="text-sm font-medium text-slate-700">Este error ya lo tenemos registrado. Esto es lo que sabemos:</p>
          <ExplicacionReporte v={conocido} />
        </div>
      )}
      <p className="text-sm text-slate-600">Cuéntanos qué pasó. No incluyas contraseñas.</p>
      <p className="text-xs text-slate-400">
        Pantalla: <span className="font-mono">{pantalla}</span>
        {conCodigo && ' · se incluirá el código técnico del último error'}
      </p>
      <textarea
        className="field-input min-h-[7rem] flex-1 resize-none"
        placeholder="Por ejemplo: «Al guardar la solicitud me salió un error»"
        maxLength={1000}
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        disabled={enviando}
      />
      <div className="flex items-center justify-between text-xs text-slate-400">
        <span>{texto.length}/1000</span>
      </div>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200">{error}</p>}
      <button type="submit" className="btn-primary justify-center" disabled={enviando || texto.trim().length < 5}>
        {enviando ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />} Enviar reporte
      </button>
    </form>
  );
}
