/**
 * Light TMS - Staff user create/edit. Admin-only. Assigns rol (admin/operador)
 * and, for operador, exactly which pages/modules the account can use.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Save, ArrowLeft, Loader2, UsersRound } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { Alert } from '../../components/Alert';
import { useAuthStore } from '../../store/auth';
import type { StaffUser, Rol, Pagina } from '../../store/auth';
import { useEnvioUnico } from '../../lib/useEnvioUnico';

interface PaginaOpt {
  pagina: Pagina;
  label: string;
}

interface AccionOpt {
  clave: string;
  label: string;
  grupo: string;
}

interface FormState {
  nombre: string;
  email: string;
  rol: Rol;
  paginas: Pagina[];
  acciones: string[];
  todasLasPaginas: boolean;
  activo: boolean;
  password: string;
}

const EMPTY: FormState = {
  nombre: '',
  email: '',
  rol: 'operador',
  paginas: [],
  acciones: [],
  todasLasPaginas: true,
  activo: true,
  password: '',
};

export default function UsuarioForm() {
  const { id } = useParams();
  const editar = Boolean(id);
  const navigate = useNavigate();
  const currentUserId = useAuthStore((s) => s.user?.id);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [opciones, setOpciones] = useState<PaginaOpt[]>([]);
  const [catalogo, setCatalogo] = useState<AccionOpt[]>([]);
  const [porDefecto, setPorDefecto] = useState<string[]>([]);
  const [accionesCargadas, setAccionesCargadas] = useState(false);
  const [loading, setLoading] = useState(editar);
  const [saving, setSaving] = useState(false);
  // Synchronous guard: ignores a second submit fired before React re-renders.
  const envio = useEnvioUnico();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<PaginaOpt[]>('/usuarios/paginas').then(setOpciones).catch(() => setOpciones([]));
  }, []);

  useEffect(() => {
    void api<{ acciones: AccionOpt[]; porDefecto: string[] }>('/usuarios/acciones')
      .then((r) => {
        setCatalogo(r.acciones);
        setPorDefecto(r.porDefecto);
        // Usuario nuevo: arranca con lo que un operador ya podía hacer.
        if (!editar) setForm((f) => ({ ...f, acciones: r.porDefecto }));
      })
      .catch(() => setCatalogo([]))
      .finally(() => setAccionesCargadas(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!editar || !accionesCargadas) return;
    void (async () => {
      try {
        const u = await api<StaffUser>(`/usuarios/${id}`);
        setForm({
          nombre: u.nombre,
          email: u.email,
          rol: u.rol,
          paginas: u.paginas ?? [],
          acciones: u.acciones ?? porDefecto,
          todasLasPaginas: u.paginas === null,
          activo: Boolean(u.activo),
          password: '',
        });
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'No se pudo cargar el usuario.');
      } finally {
        setLoading(false);
      }
    })();
  }, [editar, id, accionesCargadas]);

  function upd<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function togglePagina(p: Pagina) {
    setForm((f) => ({
      ...f,
      paginas: f.paginas.includes(p) ? f.paginas.filter((x) => x !== p) : [...f.paginas, p],
    }));
  }

  function toggleAccion(clave: string) {
    setForm((f) => ({
      ...f,
      acciones: f.acciones.includes(clave) ? f.acciones.filter((x) => x !== clave) : [...f.acciones, clave],
    }));
  }

  const gruposAcciones = catalogo.reduce<Record<string, AccionOpt[]>>((acc, a) => {
    (acc[a.grupo] ??= []).push(a);
    return acc;
  }, {});

  const esUnoMismo = editar && currentUserId === Number(id);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!editar && form.password.trim().length < 8) {
      setError('La contraseña debe tener al menos 8 caracteres.');
      return;
    }
    if (!envio.tomar()) return;
    setSaving(true);
    try {
      const paginas = form.rol === 'admin' || form.todasLasPaginas ? null : form.paginas;
      // Igual a los valores por defecto = null (así un cambio futuro de los valores por defecto aplica).
      const iguales = form.acciones.length === porDefecto.length && form.acciones.every((a) => porDefecto.includes(a));
      const acciones = form.rol === 'admin' || iguales ? null : form.acciones;
      if (editar) {
        const body: Record<string, unknown> = {
          nombre: form.nombre,
          email: form.email,
          rol: form.rol,
          paginas,
          acciones,
          activo: form.activo,
        };
        if (form.password.trim()) body.password = form.password;
        await api(`/usuarios/${id}`, { method: 'PUT', body });
        navigate('/usuarios?ok=' + encodeURIComponent('Usuario actualizado.'));
      } else {
        await api('/usuarios', {
          method: 'POST',
          body: { nombre: form.nombre, email: form.email, rol: form.rol, paginas, acciones, password: form.password },
        });
        navigate('/usuarios?ok=' + encodeURIComponent('Usuario creado.'));
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo guardar el usuario.');
    } finally {
      setSaving(false);
      envio.soltar();
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-16 text-slate-400">
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <button onClick={() => navigate('/usuarios')} className="mb-3 flex items-center gap-1 text-sm text-celeste-700">
        <ArrowLeft size={16} /> Usuarios
      </button>
      <h1 className="mb-4 flex items-center gap-2 text-xl font-semibold text-slate-800">
        <UsersRound size={20} className="text-celeste-600" /> {editar ? 'Editar' : 'Nuevo'} usuario
      </h1>

      {error && <Alert kind="err" message={error} onClose={() => setError(null)} />}

      <form onSubmit={onSubmit} className="space-y-5">
        <fieldset className="card">
          <legend className="px-1 text-sm font-semibold text-celeste-700">Datos de la cuenta</legend>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <div>
              <label className="field-label">Nombre *</label>
              <input className="field-input" required value={form.nombre} onChange={(e) => upd('nombre', e.target.value)} />
            </div>
            <div>
              <label className="field-label">Correo *</label>
              <input type="email" className="field-input" required value={form.email} onChange={(e) => upd('email', e.target.value)} />
            </div>
            <div>
              <label className="field-label">{editar ? 'Nueva contraseña (opcional)' : 'Contraseña *'}</label>
              <input
                type="password"
                className="field-input"
                required={!editar}
                minLength={8}
                placeholder={editar ? 'Dejar en blanco para no cambiarla' : ''}
                value={form.password}
                onChange={(e) => upd('password', e.target.value)}
              />
            </div>
            <div>
              <label className="field-label">Rol</label>
              <select className="field-input" value={form.rol} onChange={(e) => upd('rol', e.target.value as Rol)}>
                <option value="operador">Operador</option>
                <option value="admin">Administrador</option>
              </select>
            </div>
          </div>
          {editar && (
            <label className="mt-4 flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={form.activo}
                disabled={esUnoMismo}
                onChange={(e) => upd('activo', e.target.checked)}
              />
              Cuenta activa
              {esUnoMismo && <span className="text-xs text-slate-400">(no puedes desactivar tu propia cuenta)</span>}
            </label>
          )}
        </fieldset>

        {form.rol === 'operador' && (
          <fieldset className="card">
            <legend className="px-1 text-sm font-semibold text-celeste-700">Páginas permitidas</legend>
            <label className="mt-3 flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={form.todasLasPaginas} onChange={(e) => upd('todasLasPaginas', e.target.checked)} />
              Acceso a todas las páginas
            </label>
            {!form.todasLasPaginas && (
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {opciones.map((o) => (
                  <label key={o.pagina} className="flex items-center gap-2 text-sm text-slate-600">
                    <input type="checkbox" checked={form.paginas.includes(o.pagina)} onChange={() => togglePagina(o.pagina)} />
                    {o.label}
                  </label>
                ))}
              </div>
            )}
          </fieldset>
        )}

        {form.rol === 'admin' && (
          <p className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
            Un <strong>administrador</strong> tiene acceso a todas las páginas y puede ejecutar todas las acciones; no se le configuran permisos.
            Para elegir qué menús y botones puede usar una persona, cambia su rol a <strong>Operador</strong> o crea un usuario operador.
          </p>
        )}

        {form.rol === 'operador' && catalogo.length > 0 && (
          <fieldset className="card">
            <legend className="px-1 text-sm font-semibold text-celeste-700">Acciones críticas permitidas</legend>
            <p className="mt-1 text-xs text-slate-500">
              Marca lo que este usuario puede hacer con los botones de cada pantalla. Lo que no marques no podrá ejecutarlo (el servidor lo rechaza aunque
              conozca la dirección). Las marcadas por defecto son lo que un operador ya podía hacer.
            </p>
            {Object.entries(gruposAcciones).map(([grupo, items]) => (
              <div key={grupo} className="mt-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{grupo}</p>
                <div className="mt-1 grid gap-2 sm:grid-cols-2">
                  {items.map((a) => (
                    <label key={a.clave} className="flex items-center gap-2 text-sm text-slate-600">
                      <input type="checkbox" checked={form.acciones.includes(a.clave)} onChange={() => toggleAccion(a.clave)} />
                      {a.label}
                    </label>
                  ))}
                </div>
              </div>
            ))}
            <button type="button" className="btn-ghost mt-3 text-xs" onClick={() => upd('acciones', porDefecto)}>
              Restablecer valores por defecto
            </button>
          </fieldset>
        )}

        <div className="flex items-center gap-3">
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            {editar ? 'Actualizar' : 'Guardar'} usuario
          </button>
          <button type="button" className="btn-ghost" onClick={() => navigate('/usuarios')}>
            Cancelar
          </button>
        </div>
      </form>
    </div>
  );
}
