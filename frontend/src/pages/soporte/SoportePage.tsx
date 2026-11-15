import { useState, type FormEvent } from 'react';
import { IncidentesPanel } from './IncidentesPanel';
import { LifeBuoy, Loader2, ShieldCheck } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { Alert } from '../../components/Alert';
import { useAuthStore } from '../../store/auth';
import { useEnvioUnico } from '../../lib/useEnvioUnico';

/**
 * Consola de soporte y mantenimiento (privada del propietario de la plataforma).
 * Fase 1: identidad y protección de la cuenta. Las herramientas de incidentes llegan en las siguientes fases.
 */
function CuentaPanel() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const envio = useEnvioUnico();
  const [nombre, setNombre] = useState(user?.nombre ?? '');
  const [email, setEmail] = useState('');
  const [passwordNueva, setPasswordNueva] = useState('');
  const [passwordActual, setPasswordActual] = useState('');
  const [flash, setFlash] = useState<{ kind: 'ok' | 'err'; message: string } | null>(null);
  const [loading, setLoading] = useState(false);

  async function guardar(e: FormEvent) {
    e.preventDefault();
    setFlash(null);
    if (!envio.tomar()) return;
    setLoading(true);
    try {
      const cuerpo: Record<string, string> = { passwordActual };
      if (nombre.trim() && nombre.trim() !== user?.nombre) cuerpo.nombre = nombre.trim();
      if (email.trim()) cuerpo.email = email.trim();
      if (passwordNueva) cuerpo.passwordNueva = passwordNueva;
      const r = await api<{ ok: boolean; cerroSesiones: boolean }>('/soporte/perfil', { method: 'PUT', body: cuerpo });
      setPasswordActual('');
      setPasswordNueva('');
      if (r.cerroSesiones) {
        setFlash({ kind: 'ok', message: 'Listo. Por seguridad se cerraron todas tus sesiones: vuelve a ingresar.' });
        setTimeout(() => logout(), 1800);
      } else {
        setFlash({ kind: 'ok', message: 'Perfil actualizado.' });
      }
    } catch (err) {
      setFlash({ kind: 'err', message: err instanceof ApiError ? err.message : 'No se pudo guardar.' });
    } finally {
      setLoading(false);
      envio.soltar();
    }
  }

  async function cerrarSesiones() {
    if (!passwordActual) return setFlash({ kind: 'err', message: 'Escribe tu contraseña actual para cerrar todas las sesiones.' });
    if (!window.confirm('Se cerrarán TODAS tus sesiones abiertas, incluida esta. ¿Continuar?')) return;
    try {
      await api('/soporte/sesiones/cerrar', { method: 'POST', body: { passwordActual } });
      logout();
    } catch (err) {
      setFlash({ kind: 'err', message: err instanceof ApiError ? err.message : 'No se pudo cerrar las sesiones.' });
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      {flash && <Alert kind={flash.kind} message={flash.message} onClose={() => setFlash(null)} />}

      <div className="card mb-5 flex items-start gap-3">
        <ShieldCheck className="mt-0.5 text-emerald-600" size={20} />
        <div className="text-sm text-slate-600">
          <p className="font-medium text-slate-800">Propietario de la plataforma</p>
          <p className="mt-1">
            Esta consola es solo tuya: ningún otro usuario, aunque sea administrador, puede abrirla. Aquí irán los incidentes, el diagnóstico y las correcciones
            automáticas (fases siguientes).
          </p>
        </div>
      </div>

      <form onSubmit={guardar} className="card space-y-4">
        <h2 className="text-base font-semibold text-slate-800">Mi cuenta</h2>
        <p className="text-sm text-slate-500">Tu cuenta no se modifica desde Usuarios. Los cambios se hacen aquí y piden tu contraseña actual.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="field-label" htmlFor="nombre">Nombre</label>
            <input id="nombre" className="field-input" value={nombre} onChange={(e) => setNombre(e.target.value)} />
          </div>
          <div>
            <label className="field-label" htmlFor="email">Correo nuevo (opcional)</label>
            <input id="email" type="email" className="field-input" placeholder={user?.email} value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="sm:col-span-2">
            <label className="field-label" htmlFor="pnueva">Contraseña nueva (opcional)</label>
            <input id="pnueva" type="password" autoComplete="new-password" minLength={8} className="field-input" value={passwordNueva} onChange={(e) => setPasswordNueva(e.target.value)} />
          </div>
          <div className="sm:col-span-2">
            <label className="field-label" htmlFor="pactual">Contraseña actual *</label>
            <input id="pactual" type="password" autoComplete="current-password" required className="field-input" value={passwordActual} onChange={(e) => setPasswordActual(e.target.value)} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className="btn-primary" disabled={loading}>
            {loading && <Loader2 size={16} className="animate-spin" />} Guardar cambios
          </button>
          <button type="button" className="btn-ghost" onClick={cerrarSesiones}>Cerrar todas mis sesiones</button>
        </div>
        <p className="text-xs text-slate-400">Cambiar el correo o la contraseña cierra todas tus sesiones abiertas.</p>
      </form>
    </div>
  );
}

/** Consola de soporte (privada del propietario): incidentes y mi cuenta. */
export default function SoportePage() {
  const [pestana, setPestana] = useState<'incidentes' | 'cuenta'>('incidentes');
  return (
    <div>
      <h1 className="mb-4 flex items-center gap-2 text-xl font-semibold text-slate-800">
        <LifeBuoy size={22} className="text-celeste-600" /> Soporte
      </h1>
      <div className="mb-4 flex gap-1 border-b border-slate-200" role="tablist">
        {([['incidentes', 'Incidentes'], ['cuenta', 'Mi cuenta']] as const).map(([id, l]) => (
          <button key={id} role="tab" aria-selected={pestana === id} onClick={() => setPestana(id)}
            className={`px-4 py-2 text-sm font-medium ${pestana === id ? 'border-b-2 border-celeste-600 text-celeste-700' : 'text-slate-500 hover:text-slate-700'}`}>
            {l}
          </button>
        ))}
      </div>
      {pestana === 'incidentes' ? <IncidentesPanel /> : <CuentaPanel />}
    </div>
  );
}
