/**
 * Light TMS - Activity viewer (admin only): who did what and when, from the
 * audit trail (GET /api/auditoria). Answers questions like "who annulled this
 * manifiesto?" or "who changed this user's role?".
 */

import { Fragment, useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, History, Loader2, Search } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { Alert } from '../../components/Alert';
import type { StaffUser } from '../../store/auth';

interface Registro {
  id: number;
  created_at: string;
  usuario_id: number | null;
  usuario_email: string | null;
  ip: string | null;
  accion: string;
  entidad: string;
  entidad_id: string | null;
  descripcion: string;
  detalle: string | null;
}

interface Respuesta {
  items: Registro[];
  total: number;
  acciones: string[];
}

/** Readable labels for the recorded actions. */
const ETIQUETAS: Record<string, string> = {
  'despacho.confirmar': 'Despacho confirmado',
  'despacho.editar': 'Despacho editado',
  'anulacion.despacho': 'Anulación de despacho',
  'anulacion.documento': 'Anulación de documento',
  'cola.cancelar': 'Envío cancelado',
  'cola.procesar': 'Envío procesado',
  'cumplido.guardar': 'Cumplido guardado',
  'solicitud.crear': 'Solicitud creada',
  'solicitud.actualizar': 'Solicitud editada',
  'usuario.crear': 'Usuario creado',
  'usuario.actualizar': 'Usuario editado',
  'empresa.actualizar': 'Datos de empresa',
  'impuesto.ica.guardar': 'ICA configurado',
  'impuesto.ica.eliminar': 'ICA quitado',
};
const etiqueta = (a: string) => ETIQUETAS[a] ?? a;

const POR_PAGINA = 50;
const FILTROS_VACIOS = { usuario: '', accion: '', desde: '', hasta: '', q: '' };

function detalleLegible(detalle: string | null): string {
  if (!detalle) return '';
  try {
    return JSON.stringify(JSON.parse(detalle), null, 2);
  } catch {
    return detalle;
  }
}

export default function ActividadPage() {
  const [filtros, setFiltros] = useState(FILTROS_VACIOS);
  const [aplicados, setAplicados] = useState(FILTROS_VACIOS);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Respuesta>({ items: [], total: 0, acciones: [] });
  const [usuarios, setUsuarios] = useState<StaffUser[]>([]);
  const [abierto, setAbierto] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api<Respuesta>('/auditoria', { query: { ...aplicados, page, pageSize: POR_PAGINA } }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'No se pudo cargar la actividad.');
    } finally {
      setLoading(false);
    }
  }, [aplicados, page]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api<StaffUser[]>('/usuarios').then(setUsuarios).catch(() => setUsuarios([]));
  }, []);

  function buscar(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    setAplicados(filtros);
  }

  function limpiar() {
    setFiltros(FILTROS_VACIOS);
    setPage(1);
    setAplicados(FILTROS_VACIOS);
  }

  const paginas = Math.max(1, Math.ceil(data.total / POR_PAGINA));
  const set = (k: keyof typeof FILTROS_VACIOS) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setFiltros((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-800">
          <History size={22} className="text-celeste-600" /> Actividad
        </h1>
        <span className="text-sm text-slate-500">{data.total.toLocaleString('es-CO')} registro(s)</span>
      </div>

      {error && <Alert kind="err" message={error} onClose={() => setError(null)} />}

      <form onSubmit={buscar} className="card mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <div>
          <label className="field-label">Usuario</label>
          <select className="field-input" value={filtros.usuario} onChange={set('usuario')}>
            <option value="">Todos</option>
            {usuarios.map((u) => (
              <option key={u.id} value={u.id}>{u.nombre} ({u.email})</option>
            ))}
          </select>
        </div>
        <div>
          <label className="field-label">Acción</label>
          <select className="field-input" value={filtros.accion} onChange={set('accion')}>
            <option value="">Todas</option>
            {data.acciones.map((a) => (
              <option key={a} value={a}>{etiqueta(a)}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="field-label">Desde</label>
          <input type="date" className="field-input" value={filtros.desde} onChange={set('desde')} />
        </div>
        <div>
          <label className="field-label">Hasta</label>
          <input type="date" className="field-input" value={filtros.hasta} onChange={set('hasta')} />
        </div>
        <div>
          <label className="field-label">Texto o número</label>
          <input className="field-input" placeholder="MAN-00012, correo…" value={filtros.q} onChange={set('q')} />
        </div>
        <div className="flex items-end gap-2">
          <button type="submit" className="btn-primary"><Search size={16} /> Buscar</button>
          <button type="button" className="btn-ghost" onClick={limpiar}>Limpiar</button>
        </div>
      </form>

      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="w-8 px-2 py-3" />
              <th className="px-4 py-3">Fecha</th>
              <th className="px-4 py-3">Usuario</th>
              <th className="px-4 py-3">Acción</th>
              <th className="px-4 py-3">Descripción</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                  <Loader2 size={18} className="mx-auto animate-spin" />
                </td>
              </tr>
            )}
            {!loading && data.items.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-400">Sin actividad para estos filtros.</td>
              </tr>
            )}
            {!loading &&
              data.items.map((r) => (
                <Fragment key={r.id}>
                  <tr
                    className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                    onClick={() => setAbierto(abierto === r.id ? null : r.id)}
                  >
                    <td className="px-2 py-3 text-slate-400">
                      {r.detalle ? (abierto === r.id ? <ChevronDown size={15} /> : <ChevronRight size={15} />) : null}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-slate-600">{r.created_at}</td>
                    <td className="px-4 py-3 text-slate-700">{r.usuario_email ?? 'sistema'}</td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">{etiqueta(r.accion)}</span>
                    </td>
                    <td className="px-4 py-3 text-slate-800">{r.descripcion}</td>
                  </tr>
                  {abierto === r.id && r.detalle && (
                    <tr className="border-b border-slate-100 bg-slate-50">
                      <td />
                      <td colSpan={4} className="px-4 py-3">
                        <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs text-slate-700">{detalleLegible(r.detalle)}</pre>
                        {r.ip && <p className="mt-2 text-xs text-slate-400">IP: {r.ip}</p>}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
          </tbody>
        </table>
      </div>

      {paginas > 1 && (
        <div className="mt-3 flex items-center justify-end gap-2 text-sm">
          <button className="btn-ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Anterior</button>
          <span className="text-slate-500">Página {page} de {paginas}</span>
          <button className="btn-ghost" disabled={page >= paginas} onClick={() => setPage((p) => p + 1)}>Siguiente</button>
        </div>
      )}
    </div>
  );
}
