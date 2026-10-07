import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { LogIn, Loader2 } from 'lucide-react';
import { KonektoMark, KonektoWordmark } from '../components/Logo';
import { api, ApiError } from '../lib/api';
import { useSplash } from '../lib/splash';
import { useAuthStore, type StaffUser } from '../store/auth';

/** UI strings, in one place to ease translation. */
const TEXT = {
  expired: 'Tu sesión se cerró por inactividad. Inicia sesión de nuevo para continuar.',
};

export default function Login() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const expired = params.get('expired') === '1';
  const setSession = useAuthStore((s) => s.setSession);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // The login form is ready: let the splash fade out.
  useEffect(() => {
    useSplash.getState().hide();
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { token, user } = await api<{ token: string; user: StaffUser }>('/auth/login', {
        method: 'POST',
        anonymous: true,
        body: { email, password },
      });
      useSplash.getState().show(); // covers the dashboard load; Inicio hides it
      setSession(token, user);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo iniciar sesión.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-brand-navy p-4 dark:bg-brand-ink">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-white">
          <KonektoMark size={64} tone="dark" className="mb-3" />
          <h1 className="text-3xl">
            <KonektoWordmark />
          </h1>
          <p className="mt-1 text-xs font-medium uppercase tracking-[0.2em] text-white/60">Despacho &amp; RNDC Light</p>
        </div>
        <form onSubmit={onSubmit} className="card space-y-4">
          {expired && !error && (
            <p role="status" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">
              {TEXT.expired}
            </p>
          )}
          <div>
            <label className="field-label" htmlFor="email">
              Correo
            </label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              className="field-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="field-label" htmlFor="password">
              Contraseña
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              className="field-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {error && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200">{error}</p>
          )}
          <button type="submit" className="btn-primary w-full" disabled={loading}>
            {loading ? <Loader2 size={16} className="animate-spin" /> : <LogIn size={16} />}
            Ingresar
          </button>
        </form>
      </div>
    </div>
  );
}
