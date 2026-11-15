import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, RefreshCw, Search, Send } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { Alert } from '../../components/Alert';
import { useEnvioUnico } from '../../lib/useEnvioUnico';

/** Consola de incidentes (solo propietario). Cada llamada la valida el servidor: aquí solo se presenta. */

const ESTADOS: [string, string][] = [
  ['nuevo', 'Nuevo'], ['en_diagnostico', 'En diagnóstico'], ['causa_identificada', 'Causa identificada'], ['corrigiendo', 'Corrigiendo'],
  ['corregido', 'Corregido (sin desplegar)'], ['desplegado', 'Desplegado (sin verificar)'], ['verificado', 'Verificado'], ['escalado', 'Escalado'], ['cerrado', 'Cerrado'],
];
const TIPOS = ['codigo', 'datos', 'permisos', 'migracion', 'configuracion', 'rndc', 'proveedor_ia', 'infraestructura', 'otro'];
const SEVERIDADES = ['baja', 'media', 'alta', 'critica'];
const COLOR_SEV: Record<string, string> = { baja: 'bg-slate-100 text-slate-600', media: 'bg-amber-100 text-amber-800', alta: 'bg-orange-100 text-orange-800', critica: 'bg-red-100 text-red-700' };

interface Fila {
  id: number; sitio: string; tipo: string; origen: string; severidad: string; estado: string; corregible: number; titulo: string; operacion: string | null;
  version_despliegue: string | null; ocurrencias: number; primera_vez: string; ultima_vez: string; reportes: number; usuarios_reportaron: number;
}
interface Detalle {
  incidente: Fila & { codigo: string | null; issue_numero: number | null; issue_url: string | null; exp_hecho: string | null; exp_posible_causa: string | null; exp_causa_confirmada: string | null; exp_accion_temporal: string | null; exp_estado_correccion: string | null };
  eventos: { id: number; tipo: string; detalle: string | null; created_at: string }[];
  evidencias: { id: number; tipo: string; contenido: string; request_id: string | null; version_despliegue: string | null; created_at: string }[];
  reportes: { id: number; usuario_nombre: string | null; usuario_email: string | null; texto: string; pantalla: string | null; request_id: string | null; created_at: string }[];
  mensajes: { id: number; reporte_id: number | null; visibilidad: string; autor: string; texto: string; created_at: string }[];
  diagnosticos?: Diagnostico[];
  explicacionesIa?: { id: number; modelo: string; texto: string; created_at: string }[];
  iaDisponible?: boolean;
  githubDisponible?: boolean;
  elegibilidadAgente?: { elegible: boolean; motivo: string } | null;
}

interface Diagnostico {
  id: number; categoria: string; confianza: 'confirmada' | 'probable' | 'insuficiente'; corregible_con_codigo: number | null; resumen: string;
  posible_causa: string | null; causa_confirmada: string | null; accion_temporal: string | null; siguiente_paso: string | null;
  hechos: { texto: string; fuente: string; observadoEn?: string }[]; referencias: { tipo?: string; valor?: string }[]; version_reglas: string; aplicado_en: string | null; created_at: string;
}
const COLOR_CONF: Record<string, string> = { confirmada: 'bg-emerald-100 text-emerald-800', probable: 'bg-amber-100 text-amber-800', insuficiente: 'bg-slate-100 text-slate-600' };

const fecha = (v: string) => new Date(String(v).replace(' ', 'T')).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });

export function IncidentesPanel() {
  const [items, setItems] = useState<Fila[]>([]);
  const [filtros, setFiltros] = useState({ estado: '', tipo: '', q: '' });
  const [cargando, setCargando] = useState(true);
  const [sel, setSel] = useState<number | null>(null);
  const [flash, setFlash] = useState<{ kind: 'ok' | 'err'; message: string } | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const r = await api<{ items: Fila[] }>('/soporte/incidentes', { query: filtros });
      setItems(r.items);
    } catch (e) {
      setFlash({ kind: 'err', message: e instanceof ApiError ? e.message : 'No se pudieron cargar los incidentes.' });
    } finally {
      setCargando(false);
    }
  }, [filtros]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  return (
    <div>
      {flash && <Alert kind={flash.kind} message={flash.message} onClose={() => setFlash(null)} />}
      <form className="card mb-3 flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); void cargar(); }}>
        <div>
          <label className="field-label">Estado</label>
          <select className="field-input" value={filtros.estado} onChange={(e) => setFiltros((f) => ({ ...f, estado: e.target.value }))}>
            <option value="">Todos</option>
            {ESTADOS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div>
          <label className="field-label">Tipo</label>
          <select className="field-input" value={filtros.tipo} onChange={(e) => setFiltros((f) => ({ ...f, tipo: e.target.value }))}>
            <option value="">Todos</option>
            {TIPOS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="min-w-[10rem] flex-1">
          <label className="field-label">Buscar</label>
          <input className="field-input" placeholder="título u operación" value={filtros.q} onChange={(e) => setFiltros((f) => ({ ...f, q: e.target.value }))} />
        </div>
        <button type="submit" className="btn-ghost"><Search size={16} /> Buscar</button>
        <button type="button" className="btn-ghost" onClick={() => void cargar()} aria-label="Actualizar"><RefreshCw size={16} /></button>
      </form>

      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-3 py-2">Sev.</th><th className="px-3 py-2">Tipo</th><th className="px-3 py-2">Incidente</th>
              <th className="px-3 py-2 text-right">Veces</th><th className="px-3 py-2 text-right">Reportes</th><th className="px-3 py-2">Estado</th><th className="px-3 py-2">Última vez</th>
            </tr>
          </thead>
          <tbody>
            {cargando && <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400"><Loader2 size={18} className="mx-auto animate-spin" /></td></tr>}
            {!cargando && items.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400">Sin incidentes para estos filtros.</td></tr>}
            {!cargando && items.map((i) => (
              <tr key={i.id} onClick={() => setSel(sel === i.id ? null : i.id)} className={`cursor-pointer border-b border-slate-100 hover:bg-slate-50 ${sel === i.id ? 'bg-celeste-50 dark:bg-celeste-500/10' : ''}`}>
                <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${COLOR_SEV[i.severidad] ?? COLOR_SEV.media}`}>{i.severidad}</span></td>
                <td className="px-3 py-2 text-xs text-slate-600">{i.tipo}{!i.corregible && <span title="No se corrige con cambios de código"> ·⚙</span>}</td>
                <td className="px-3 py-2"><p className="line-clamp-1 font-medium text-slate-800">{i.titulo}</p><p className="text-xs text-slate-400">#{i.id} · {i.sitio} · {i.origen}</p></td>
                <td className="px-3 py-2 text-right font-mono">{i.ocurrencias}</td>
                <td className="px-3 py-2 text-right font-mono">{i.reportes}</td>
                <td className="px-3 py-2 text-xs">{ESTADOS.find(([v]) => v === i.estado)?.[1] ?? i.estado}</td>
                <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-500">{fecha(i.ultima_vez)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {sel !== null && <DetalleIncidente id={sel} alCambiar={() => void cargar()} />}
    </div>
  );
}

function DetalleIncidente({ id, alCambiar }: { id: number; alCambiar: () => void }) {
  const [d, setD] = useState<Detalle | null>(null);
  const [flash, setFlash] = useState<{ kind: 'ok' | 'err'; message: string } | null>(null);
  const [f, setF] = useState({ estado: '', severidad: '', tipo: '', corregible: true, notificar: false, hecho: '', posibleCausa: '', causaConfirmada: '', accionTemporal: '', estadoCorreccion: '' });
  const [msg, setMsg] = useState({ visibilidad: 'interno', texto: '', reporteId: '' });
  const [verEvidencia, setVerEvidencia] = useState(false);
  const envio = useEnvioUnico();

  const cargar = useCallback(async () => {
    try {
      const r = await api<Detalle>(`/soporte/incidentes/${id}`);
      setD(r);
      const i = r.incidente;
      setF({ estado: i.estado, severidad: i.severidad, tipo: i.tipo, corregible: Boolean(i.corregible), notificar: false, hecho: i.exp_hecho ?? '', posibleCausa: i.exp_posible_causa ?? '', causaConfirmada: i.exp_causa_confirmada ?? '', accionTemporal: i.exp_accion_temporal ?? '', estadoCorreccion: i.exp_estado_correccion ?? '' });
    } catch (e) {
      setFlash({ kind: 'err', message: e instanceof ApiError ? e.message : 'No se pudo cargar el incidente.' });
    }
  }, [id]);

  useEffect(() => { setD(null); void cargar(); }, [cargar]);

  async function guardar() {
    if (!d || !envio.tomar('guardar')) return;
    try {
      const r = await api<{ ok: boolean; estado: string; avisados: number }>(`/soporte/incidentes/${id}`, {
        method: 'PATCH',
        body: {
          estado: f.estado, severidad: f.severidad, tipo: f.tipo, corregible: f.corregible, notificar: f.notificar,
          explicacion: { hecho: f.hecho || null, posibleCausa: f.posibleCausa || null, causaConfirmada: f.causaConfirmada || null, accionTemporal: f.accionTemporal || null, estadoCorreccion: f.estadoCorreccion || null },
        },
      });
      setFlash({ kind: 'ok', message: r.avisados > 0 ? `Guardado. Se avisó a ${r.avisados} usuario(s) que reportaron este incidente.` : 'Guardado.' });
      await cargar();
      alCambiar();
    } catch (e) {
      setFlash({ kind: 'err', message: e instanceof ApiError ? e.message : 'No se pudo guardar.' });
    } finally {
      envio.soltar('guardar');
    }
  }

  async function diagnosticar() {
    if (!envio.tomar('diag')) return;
    try {
      await api(`/soporte/incidentes/${id}/diagnosticar`, { method: 'POST', body: {} });
      await cargar();
      alCambiar();
    } catch (e) {
      setFlash({ kind: 'err', message: e instanceof ApiError ? e.message : 'No se pudo diagnosticar.' });
    } finally {
      envio.soltar('diag');
    }
  }

  async function explicarIa() {
    if (!envio.tomar('ia')) return;
    try {
      await api(`/soporte/incidentes/${id}/explicar-ia`, { method: 'POST', body: {} });
      await cargar();
    } catch (e) {
      setFlash({ kind: 'err', message: e instanceof ApiError ? e.message : 'No se pudo generar el borrador.' });
    } finally {
      envio.soltar('ia');
    }
  }

  async function crearIssue() {
    if (!envio.tomar('issue')) return;
    try {
      const r = await api<{ numero: number; url: string }>(`/soporte/incidentes/${id}/issue`, { method: 'POST', body: {} });
      setFlash({ kind: 'ok', message: `Issue ${r.numero} creado en GitHub. Para que el agente proponga la corrección, ponle la etiqueta "agente-corregir" en GitHub.` });
      await cargar();
    } catch (e) {
      setFlash({ kind: 'err', message: e instanceof ApiError ? e.message : 'No se pudo crear el issue.' });
    } finally {
      envio.soltar('issue');
    }
  }

  async function usarBorrador(did: number, sobrescribir: boolean) {
    if (!envio.tomar('borrador')) return;
    try {
      const r = await api<{ ok: boolean; campos: string[] }>(`/soporte/incidentes/${id}/diagnosticos/${did}/aplicar`, { method: 'POST', body: { sobrescribir } });
      setFlash({ kind: 'ok', message: r.campos.length ? `Explicación pública actualizada (${r.campos.length} campo/s). No se avisó a nadie.` : 'No había campos vacíos que llenar.' });
      await cargar();
    } catch (e) {
      setFlash({ kind: 'err', message: e instanceof ApiError ? e.message : 'No se pudo aplicar.' });
    } finally {
      envio.soltar('borrador');
    }
  }

  async function enviarMensaje() {
    if (!msg.texto.trim() || !envio.tomar('mensaje')) return;
    try {
      const r = await api<{ ok: boolean; destinatarios: number }>(`/soporte/incidentes/${id}/mensajes`, {
        method: 'POST', body: { visibilidad: msg.visibilidad, texto: msg.texto.trim(), ...(msg.reporteId ? { reporteId: Number(msg.reporteId) } : {}) },
      });
      setFlash({ kind: 'ok', message: msg.visibilidad === 'publico' ? `Mensaje público enviado a ${r.destinatarios} reporte(s).` : 'Nota interna guardada.' });
      setMsg((m) => ({ ...m, texto: '' }));
      await cargar();
    } catch (e) {
      setFlash({ kind: 'err', message: e instanceof ApiError ? e.message : 'No se pudo enviar.' });
    } finally {
      envio.soltar('mensaje');
    }
  }

  if (!d) return <div className="card mt-3 flex justify-center py-8 text-slate-400"><Loader2 className="animate-spin" /></div>;
  const i = d.incidente;
  const campo = 'field-input';

  return (
    <div className="card mt-3 space-y-5">
      {flash && <Alert kind={flash.kind} message={flash.message} onClose={() => setFlash(null)} />}
      <div>
        <h2 className="text-base font-semibold text-slate-800">#{i.id} · {i.titulo}</h2>
        <p className="mt-1 text-xs text-slate-500">
          {i.operacion} · sitio <strong>{i.sitio}</strong> · versión <span className="font-mono">{(i.version_despliegue ?? '—').slice(0, 12)}</span> · {i.ocurrencias} vez/veces · primera {fecha(i.primera_vez)} · última {fecha(i.ultima_vez)}
        </p>
        {!i.corregible && (
          <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" /> Este tipo ({i.tipo}) no se corrige con cambios de código: migración pendiente, configuración, infraestructura, RNDC o proveedor de IA.
          </p>
        )}
      </div>

      <section>
        <h3 className="mb-2 text-sm font-semibold text-celeste-700">Estado y clasificación</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          <div><label className="field-label">Estado</label><select className={campo} value={f.estado} onChange={(e) => setF({ ...f, estado: e.target.value })}>{ESTADOS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
          <div><label className="field-label">Severidad</label><select className={campo} value={f.severidad} onChange={(e) => setF({ ...f, severidad: e.target.value })}>{SEVERIDADES.map((s) => <option key={s}>{s}</option>)}</select></div>
          <div><label className="field-label">Tipo</label><select className={campo} value={f.tipo} onChange={(e) => setF({ ...f, tipo: e.target.value })}>{TIPOS.map((t) => <option key={t}>{t}</option>)}</select></div>
        </div>
        <label className="mt-2 flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={f.corregible} onChange={(e) => setF({ ...f, corregible: e.target.checked })} /> Corregible con cambios de código</label>
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-celeste-700">Diagnóstico</h3>
          <button className="btn-ghost" onClick={() => void diagnosticar()}>Diagnosticar ahora</button>
        </div>
        {(d.diagnosticos ?? []).length === 0 && <p className="text-sm text-slate-400">Todavía no hay diagnóstico.</p>}
        <ul className="space-y-3">
          {(d.diagnosticos ?? []).map((g, n) => (
            <li key={g.id} className="rounded-lg border border-slate-200 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className={`rounded-full px-2 py-0.5 font-semibold ${COLOR_CONF[g.confianza] ?? ''}`}>{g.confianza}</span>
                <span className="text-slate-500">{g.categoria} · reglas v{g.version_reglas} · {fecha(g.created_at)}{n === 0 ? ' · más reciente' : ''}{g.aplicado_en ? ' · usado como explicación' : ''}</span>
              </div>
              <p className="mt-2 text-slate-800">{g.resumen}</p>
              {g.causa_confirmada && <p className="mt-1 text-slate-700"><strong>Causa confirmada:</strong> {g.causa_confirmada}</p>}
              {g.posible_causa && <p className="mt-1 text-slate-700"><strong>Posible causa:</strong> {g.posible_causa}</p>}
              {g.accion_temporal && <p className="mt-1 text-slate-700"><strong>Acción temporal:</strong> {g.accion_temporal}</p>}
              {g.siguiente_paso && <p className="mt-1 text-slate-700"><strong>Siguiente paso:</strong> {g.siguiente_paso}</p>}
              <p className="mt-1 text-xs text-slate-500">Corregible con cambios de código: {g.corregible_con_codigo === null ? 'sin determinar' : g.corregible_con_codigo ? 'sí' : 'no'}</p>
              {g.hechos.length > 0 && (
                <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-slate-600">
                  {g.hechos.map((h, k) => <li key={k}>{h.texto} <span className="text-slate-400">({h.fuente}{h.observadoEn ? ` · ${fecha(h.observadoEn)}` : ''})</span></li>)}
                </ul>
              )}
              {n === 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <button className="btn-ghost" onClick={() => void usarBorrador(g.id, false)}>Usar como explicación pública</button>
                  <button className="btn-ghost" onClick={() => { if (window.confirm('Esto reemplaza lo que ya escribiste en la explicación pública. ¿Continuar?')) void usarBorrador(g.id, true); }}>Usar y sobrescribir</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      {(d.githubDisponible || i.issue_url) && (
        <section>
          <h3 className="mb-1 text-sm font-semibold text-celeste-700">Corrección con el agente (GitHub)</h3>
          {i.issue_url && i.issue_url.startsWith('https://') ? (
            <p className="text-sm text-slate-700">Issue creado: <a className="font-medium text-celeste-700 underline" href={i.issue_url} target="_blank" rel="noreferrer noopener">#{i.issue_numero}</a>. El agente solo actúa cuando le pones la etiqueta <span className="font-mono">agente-corregir</span> en GitHub y solo abre un PR: nunca integra solo.</p>
          ) : (
            <>
              <p className={`mb-2 text-sm ${d.elegibilidadAgente?.elegible ? 'text-slate-700' : 'text-amber-700'}`}>{d.elegibilidadAgente?.motivo ?? ''}</p>
              <button className="btn-ghost" disabled={!d.elegibilidadAgente?.elegible} onClick={() => void crearIssue()}>Crear issue en GitHub</button>
            </>
          )}
        </section>
      )}

      {d.iaDisponible && (
        <section>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-celeste-700">Borrador con IA (solo para ti)</h3>
            <button className="btn-ghost" disabled={(d.diagnosticos ?? []).length === 0} onClick={() => void explicarIa()}>Explicar con IA</button>
          </div>
          <p className="mb-2 text-xs text-slate-400">Redactado por un modelo a partir del diagnóstico y de evidencia sanitizada. Es una hipótesis: no cambia la confianza, el estado ni la explicación pública, y no se envía a nadie.</p>
          {(d.explicacionesIa ?? []).slice(0, 1).map((x) => (
            <div key={x.id} className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-3 text-sm text-slate-700">
              <p className="whitespace-pre-wrap">{x.texto}</p>
              <p className="mt-1 text-xs text-slate-400">{x.modelo} · {fecha(x.created_at)}</p>
            </div>
          ))}
        </section>
      )}

      <section>
        <h3 className="mb-1 text-sm font-semibold text-celeste-700">Explicación pública (la ven quienes reportaron)</h3>
        <p className="mb-2 text-xs text-slate-400">Lo que dejes vacío se muestra como "todavía no hay información". Llena "causa confirmada" solo si hay evidencia.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {([['hecho', 'Lo que observamos'], ['posibleCausa', 'Posible causa'], ['causaConfirmada', 'Causa confirmada'], ['accionTemporal', 'Acción temporal'], ['estadoCorreccion', 'Estado de la corrección']] as const).map(([k, l]) => (
            <div key={k} className={k === 'estadoCorreccion' ? 'sm:col-span-2' : ''}>
              <label className="field-label">{l}</label>
              <textarea className={campo} rows={2} maxLength={1000} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={f.notificar} onChange={(e) => setF({ ...f, notificar: e.target.checked })} /> Avisar a quienes reportaron si cambia el estado</label>
          <button className="btn-primary" onClick={() => void guardar()}>Guardar</button>
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold text-celeste-700">Reportes de usuarios ({d.reportes.length})</h3>
        {d.reportes.length === 0 && <p className="text-sm text-slate-400">Nadie ha reportado este incidente; se detectó automáticamente.</p>}
        <ul className="space-y-2">
          {d.reportes.map((r) => (
            <li key={r.id} className="rounded-lg border border-slate-200 p-2.5 text-sm">
              <p className="text-xs text-slate-500">#{r.id} · {r.usuario_nombre} ({r.usuario_email}) · {fecha(r.created_at)}{r.pantalla ? ` · ${r.pantalla}` : ''}{r.request_id ? ` · ${r.request_id}` : ''}</p>
              <p className="mt-1 whitespace-pre-wrap text-slate-700">{r.texto}</p>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold text-celeste-700">Mensajes</h3>
        <ul className="mb-3 space-y-1.5">
          {d.mensajes.map((m) => (
            <li key={m.id} className="text-sm">
              <span className={`mr-2 rounded-full px-2 py-0.5 text-xs font-medium ${m.visibilidad === 'publico' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}>{m.visibilidad === 'publico' ? `público → reporte #${m.reporte_id}` : 'interno'}</span>
              {m.texto} <span className="text-xs text-slate-400">{fecha(m.created_at)}</span>
            </li>
          ))}
          {d.mensajes.length === 0 && <li className="text-sm text-slate-400">Sin mensajes.</li>}
        </ul>
        <div className="grid gap-2 sm:grid-cols-[auto_1fr_auto]">
          <select className={campo} value={msg.visibilidad} onChange={(e) => setMsg({ ...msg, visibilidad: e.target.value, reporteId: '' })}>
            <option value="interno">Nota interna (solo tú)</option>
            <option value="publico">Mensaje público (lo ve el usuario)</option>
          </select>
          <textarea className={campo} rows={2} maxLength={1000} placeholder={msg.visibilidad === 'publico' ? 'Mensaje para quien reportó…' : 'Nota técnica privada…'} value={msg.texto} onChange={(e) => setMsg({ ...msg, texto: e.target.value })} />
          <button className="btn-primary self-start" onClick={() => void enviarMensaje()}><Send size={16} /> Enviar</button>
          {msg.visibilidad === 'publico' && d.reportes.length > 0 && (
            <select className={`${campo} sm:col-span-3`} value={msg.reporteId} onChange={(e) => setMsg({ ...msg, reporteId: e.target.value })}>
              <option value="">A todos los reportes de este incidente</option>
              {d.reportes.map((r) => <option key={r.id} value={r.id}>Solo al reporte #{r.id} ({r.usuario_nombre})</option>)}
            </select>
          )}
        </div>
      </section>

      <section>
        <button className="flex items-center gap-1 text-sm font-semibold text-celeste-700" onClick={() => setVerEvidencia((v) => !v)}>
          {verEvidencia ? <ChevronDown size={16} /> : <ChevronRight size={16} />} Evidencia técnica sanitizada ({d.evidencias.length})
        </button>
        {verEvidencia && (
          <ul className="mt-2 space-y-2">
            {d.evidencias.map((e) => (
              <li key={e.id}>
                <p className="text-xs text-slate-400">{e.tipo} · {fecha(e.created_at)}{e.version_despliegue ? ` · v ${e.version_despliegue.slice(0, 12)}` : ''}{e.request_id ? ` · ${e.request_id}` : ''}</p>
                <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-100 p-2 text-xs text-slate-700">{(() => { try { return JSON.stringify(JSON.parse(e.contenido), null, 2); } catch { return e.contenido; } })()}</pre>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold text-celeste-700">Historial</h3>
        <ul className="space-y-1 text-xs text-slate-500">
          {d.eventos.map((e) => <li key={e.id}>{fecha(e.created_at)} · <strong>{e.tipo}</strong>{e.detalle ? ` — ${e.detalle}` : ''}</li>)}
        </ul>
      </section>
    </div>
  );
}
