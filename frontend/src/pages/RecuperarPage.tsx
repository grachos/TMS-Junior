import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Loader2, Mail } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useTurnstile } from '../lib/useTurnstile';
import { AccesoLayout } from './AccesoLayout';

/** "Olvidé mi contraseña": pide el correo y, si corresponde a una cuenta activa, recibe un enlace de un solo uso. */
export default function RecuperarPage() {
  const [email, setEmail] = useState('');
  const [enviado, setEnviado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const captcha = useTurnstile('forgot_password');

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (loading) return;
    setError(null);
    setLoading(true);
    try {
      await api('/auth/forgot-password', { method: 'POST', anonymous: true, body: { email, ...captcha.payload } });
      setEnviado(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo enviar la solicitud.');
    } finally {
      captcha.reset(); // el reto es de un solo uso
      setLoading(false);
    }
  }

  return (
    <AccesoLayout>
      <div className="card space-y-4">
        {enviado ? (
          <>
            <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-emerald-200">
              Si ese correo corresponde a una cuenta activa, te enviamos un enlace para restablecer la contraseña. Vale 30 minutos y solo se puede usar una vez.
              Revisa también la carpeta de spam.
            </p>
            <Link to="/login" className="btn-ghost w-full justify-center">
              <ArrowLeft size={16} /> Volver a ingresar
            </Link>
          </>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <h2 className="text-base font-semibold text-slate-800">Recuperar contraseña</h2>
              <p className="mt-1 text-sm text-slate-500">Escribe el correo de tu cuenta y te enviaremos un enlace para elegir una contraseña nueva.</p>
            </div>
            <div>
              <label className="field-label" htmlFor="email">Correo</label>
              <input id="email" type="email" autoComplete="username" className="field-input" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </div>
            {captcha.widget}
            {captcha.message && !error && (
              <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">{captcha.message}</p>
            )}
            {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200">{error}</p>}
            <button type="submit" className="btn-primary w-full" disabled={loading || !captcha.canSubmit}>
              {loading ? <Loader2 size={16} className="animate-spin" /> : <Mail size={16} />}
              Enviar enlace
            </button>
            <Link to="/login" className="block text-center text-sm text-celeste-700 hover:underline">Volver a ingresar</Link>
          </form>
        )}
      </div>
    </AccesoLayout>
  );
}
