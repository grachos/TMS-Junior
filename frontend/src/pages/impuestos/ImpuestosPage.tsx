/**
 * Light TMS - Impuestos (admin only): tarifa de ICA (por mil) por municipio de
 * origen del viaje. La solicitud propone esta tarifa al elegir el remitente;
 * cada solicitud conserva la que se guardó, así que cambiar una tarifa aquí no
 * altera solicitudes existentes.
 */

import { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, Pencil, Percent, Plus, Search, Trash2, X } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { Alert } from '../../components/Alert';
import { MunicipioAutocomplete } from '../../components/MunicipioAutocomplete';
import { useEnvioUnico } from '../../lib/useEnvioUnico';

interface Fila {
  codigo_rndc: string;
  municipio: string;
  tarifa_por_mil: number;
  updated_at: string;
}

const POR_PAGINA = 50;

export default function ImpuestosPage() {
  const [items, setItems] = useState<Fila[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [busqueda, setBusqueda] = useState('');
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [flash, setFlash] = useState<{ kind: 'ok' | 'err'; message: string } | null>(null);
  const envio = useEnvioUnico();

  // New tariff
  const [nuevo, setNuevo] = useState<{ codigo: string; label: string }>({ codigo: '', label: '' });
  const [nuevaTarifa, setNuevaTarifa] = useState('');
  // Inline edit
  const [editando, setEditando] = useState<string | null>(null);
  const [tarifaEditada, setTarifaEditada] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ items: Fila[]; total: number }>('/impuestos/ica', { query: { q, page, pageSize: POR_PAGINA } });
      setItems(r.items);
      setTotal(r.total);
    } catch (e) {
      setFlash({ kind: 'err', message: e instanceof ApiError ? e.message : 'No se pudo cargar.' });
    } finally {
      setLoading(false);
    }
  }, [q, page]);

  useEffect(() => {
    void load();
  }, [load]);

  async function guardar(codigo: string, tarifa: string, municipio: string): Promise<boolean> {
    if (!envio.tomar(`ica-${codigo}`)) return false;
    setFlash(null);
    try {
      await api(`/impuestos/ica/${encodeURIComponent(codigo)}`, { method: 'PUT', body: { tarifa_por_mil: tarifa } });
      setFlash({ kind: 'ok', message: `ICA de ${municipio} guardado: ${tarifa} por mil.` });
      await load();
      return true;
    } catch (e) {
      setFlash({ kind: 'err', message: e instanceof ApiError ? e.message : 'No se pudo guardar.' });
      return false;
    } finally {
      envio.soltar(`ica-${codigo}`);
    }
  }

  async function agregar(e: React.FormEvent) {
    e.preventDefault();
    if (!nuevo.codigo) {
      setFlash({ kind: 'err', message: 'Elige el municipio de origen de la lista.' });
      return;
    }
    if (nuevaTarifa.trim() === '') {
      setFlash({ kind: 'err', message: 'Escribe la tarifa por mil.' });
      return;
    }
    if (await guardar(nuevo.codigo, nuevaTarifa, nuevo.label)) {
      setNuevo({ codigo: '', label: '' });
      setNuevaTarifa('');
    }
  }

  async function quitar(f: Fila) {
    if (!window.confirm(`¿Quitar la tarifa de ICA de ${f.municipio}? Las solicitudes ya guardadas no cambian; las nuevas desde ese municipio quedarán en 0 con una advertencia.`)) return;
    if (!envio.tomar(`ica-${f.codigo_rndc}`)) return;
    setFlash(null);
    try {
      await api(`/impuestos/ica/${encodeURIComponent(f.codigo_rndc)}`, { method: 'DELETE' });
      setFlash({ kind: 'ok', message: `Se quitó la tarifa de ICA de ${f.municipio}.` });
      await load();
    } catch (e) {
      setFlash({ kind: 'err', message: e instanceof ApiError ? e.message : 'No se pudo quitar.' });
    } finally {
      envio.soltar(`ica-${f.codigo_rndc}`);
    }
  }

  const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-800">
          <Percent size={22} className="text-celeste-600" /> Impuestos
        </h1>
      </div>

      {flash && <Alert kind={flash.kind} message={flash.message} onClose={() => setFlash(null)} />}

      <fieldset className="card mb-4">
        <legend className="px-1 text-sm font-semibold text-celeste-700">ICA por municipio de origen</legend>
        <p className="mt-1 text-xs text-slate-500">
          El ICA se cobra según la ciudad de origen del viaje. Al elegir el remitente en una solicitud, se propone la tarifa (por mil) de su
          municipio, y los centros poblados (corregimientos) usan la tarifa de su municipio. Se puede ajustar en esa solicitud, que conserva la tarifa con la que se guarda. Un municipio sin tarifa queda en 0 con una advertencia. La tarifa admite hasta 2 decimales.
        </p>
        <form onSubmit={agregar} className="mt-3 grid gap-3 sm:grid-cols-[1fr_180px_auto]">
          <div>
            <label className="field-label">Municipio de origen</label>
            <MunicipioAutocomplete
              initialLabel={nuevo.label}
              onClear={() => setNuevo({ codigo: '', label: '' })}
              onSelect={(codigo, label) => setNuevo({ codigo, label })}
              soloMunicipios
            />
          </div>
          <div>
            <label className="field-label">Tarifa (por mil)</label>
            <input
              type="number"
              step="0.01"
              min="0"
              max="100"
              className="field-input"
              placeholder="p.ej. 9.66"
              value={nuevaTarifa}
              onChange={(e) => setNuevaTarifa(e.target.value)}
            />
          </div>
          <div className="flex items-end">
            <button type="submit" className="btn-primary">
              <Plus size={16} /> Agregar
            </button>
          </div>
        </form>
      </fieldset>

      <form
        className="mb-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setQ(busqueda.trim());
        }}
      >
        <input className="field-input max-w-sm" placeholder="Buscar municipio o código…" value={busqueda} onChange={(e) => setBusqueda(e.target.value)} />
        <button type="submit" className="btn-ghost">
          <Search size={16} /> Buscar
        </button>
        <span className="ml-auto self-center text-sm text-slate-500">{total.toLocaleString('es-CO')} municipio(s) configurado(s)</span>
      </form>

      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-4 py-3">Municipio</th>
              <th className="px-4 py-3">Código</th>
              <th className="px-4 py-3">Tarifa (por mil)</th>
              <th className="px-4 py-3">Actualizada</th>
              <th className="px-4 py-3 text-right">Acciones</th>
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
            {!loading && items.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                  {q ? 'Sin resultados.' : 'Aún no hay tarifas configuradas. Agrega la primera arriba.'}
                </td>
              </tr>
            )}
            {!loading &&
              items.map((f) => (
                <tr key={f.codigo_rndc} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium text-slate-800">{f.municipio}</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-500">{f.codigo_rndc}</td>
                  <td className="px-4 py-3">
                    {editando === f.codigo_rndc ? (
                      <input
                        autoFocus
                        type="number"
                        step="0.01"
                        min="0"
                        max="100"
                        className="field-input w-32"
                        value={tarifaEditada}
                        onChange={(e) => setTarifaEditada(e.target.value)}
                      />
                    ) : (
                      <span className="font-mono">{f.tarifa_por_mil}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">{f.updated_at}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      {editando === f.codigo_rndc ? (
                        <>
                          <button
                            className="btn-ghost px-2 py-1"
                            title="Guardar"
                            onClick={async () => {
                              if (await guardar(f.codigo_rndc, tarifaEditada, f.municipio)) setEditando(null);
                            }}
                          >
                            <Check size={15} />
                          </button>
                          <button className="btn-ghost px-2 py-1" title="Cancelar" onClick={() => setEditando(null)}>
                            <X size={15} />
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            className="btn-ghost px-2 py-1"
                            title="Editar"
                            onClick={() => {
                              setEditando(f.codigo_rndc);
                              setTarifaEditada(String(f.tarifa_por_mil));
                            }}
                          >
                            <Pencil size={15} />
                          </button>
                          <button className="btn-ghost px-2 py-1 text-red-600" title="Quitar" onClick={() => void quitar(f)}>
                            <Trash2 size={15} />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {paginas > 1 && (
        <div className="mt-3 flex items-center justify-end gap-2 text-sm">
          <button className="btn-ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Anterior
          </button>
          <span className="text-slate-500">
            Página {page} de {paginas}
          </span>
          <button className="btn-ghost" disabled={page >= paginas} onClick={() => setPage((p) => p + 1)}>
            Siguiente
          </button>
        </div>
      )}
    </div>
  );
}
