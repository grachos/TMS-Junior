import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Eye, EyeOff, KeyRound, Loader2 } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useTurnstile } from '../lib/useTurnstile';
import { AccesoLayout } from './AccesoLayout';

const MIN = 8;

/** Elegir la contraseña nueva con el enlace del correo (/restablecer?token=...). */
export default function RestablecerPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  // El token se guarda al abrir y se quita de la barra de direcciones (no queda en el historial ni se comparte por error).
  const token = useRef(params.get('token') ?? '');
  const [password, setPassword] = useState('');
  const [confirmar, setConfirmar] = useState('');
  const [ver, setVer] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listo, setListo] = useState(false);
  const [loading, setLoading] = useState(false);
  const captcha = useTurnstile('reset_password');

  useEffect(() => {
    if (token.current) window.history.replaceState(null, '', '/restablecer');
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (loading) return;
    setError(null);
    if (password.length < MIN) return setError(`La contraseña debe tener al menos ${MIN} caracteres.`);
    if (password !== confirmar) return setError('Las contraseñas no coinciden.');
    setLoading(true);
    try {
      await api('/auth/reset-password', { method: 'POST', anonymous: true, body: { token: token.current, password, ...captcha.payload } });
      setListo(true);
      setTimeout(() => navigate('/login', { replace: true }), 2500);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo cambiar la contraseña.');
    } finally {
      captcha.reset();
      setLoading(false);
    }
  }

  if (!token.current) {
    return (
      <AccesoLayout>
        <div className="card space-y-4">
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200">El enlace no es válido o venció. Solicita uno nuevo.</p>
          <Link to="/recuperar" className="btn-primary w-full justify-center">Solicitar un enlace nuevo</Link>
        </div>
      </AccesoLayout>
    );
  }

  return (
    <AccesoLayout>
      <div className="card space-y-4">
        {listo ? (
          <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-emerald-200">
            Listo: tu contraseña cambió. Te llevamos al ingreso…
          </p>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <h2 className="text-base font-semibold text-slate-800">Elige tu contraseña nueva</h2>
            <div>
              <label className="field-label" htmlFor="password">Contraseña nueva</label>
              <div className="relative">
                <input id="password" type={ver ? 'text' : 'password'} autoComplete="new-password" className="field-input pr-10" minLength={MIN}
                  value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
                <button type="button" tabIndex={-1} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  onClick={() => setVer((v) => !v)} aria-label={ver ? 'Ocultar contraseña' : 'Mostrar contraseña'}>
                  {ver ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              <p className="mt-1 text-xs text-slate-400">Mínimo {MIN} caracteres.</p>
            </div>
            <div>
              <label className="field-label" htmlFor="confirmar">Repite la contraseña</label>
              <input id="confirmar" type={ver ? 'text' : 'password'} autoComplete="new-password" className="field-input"
                value={confirmar} onChange={(e) => setConfirmar(e.target.value)} required />
            </div>
            {captcha.widget}
            {captcha.message && !error && (
              <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">{captcha.message}</p>
            )}
            {error && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200">
                {error} {/enlace/i.test(error) && <Link to="/recuperar" className="font-medium underline">Solicitar uno nuevo</Link>}
              </p>
            )}
            <button type="submit" className="btn-primary w-full" disabled={loading || !captcha.canSubmit}>
              {loading ? <Loader2 size={16} className="animate-spin" /> : <KeyRound size={16} />}
              Cambiar contraseña
            </button>
          </form>
        )}
      </div>
    </AccesoLayout>
  );
}
