import { CheckCircle2, AlertTriangle, LifeBuoy, X } from 'lucide-react';
import { abrirReporte, reporteDisponible } from '../lib/reportarEvento';

interface AlertProps {
  kind: 'ok' | 'err';
  message: string;
  onClose?: () => void;
}

/** Flash message, mirroring the PHP ?ok=/?err= alerts. */
export function Alert({ kind, message, onClose }: AlertProps) {
  const ok = kind === 'ok';
  return (
    <div
      className={`mb-4 flex items-start gap-2 rounded-lg px-3 py-2 text-sm ring-1 ${
        ok ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : 'bg-red-50 text-red-700 ring-red-200'
      }`}
    >
      {ok ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
      <span className="flex-1">{message}</span>
      {!ok && reporteDisponible() && (
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold underline underline-offset-2"
          onClick={() => abrirReporte({ texto: `Me apareció este mensaje: «${message.slice(0, 300)}». ` })}
        >
          <LifeBuoy size={14} /> Reportar este error
        </button>
      )}
      {onClose && (
        <button onClick={onClose} aria-label="Cerrar">
          <X size={16} />
        </button>
      )}
    </div>
  );
}
