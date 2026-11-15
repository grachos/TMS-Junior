/**
 * Konekto - Asistente flotante. Tres pestañas:
 *   - Reportar un problema  → SIEMPRE disponible (no depende del asistente de IA).
 *   - Mis reportes          → estado real de cada reporte, con la explicación en 5 partes.
 *   - Consultar datos       → el chat de datos de siempre (OpenRouter + consulta de solo lectura); solo aparece si el
 *                             backend informa que está habilitado. Su comportamiento no cambió.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Bot, LifeBuoy, ListChecks, Loader2, MessageCircle, Send, X } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { EVENTO_REPORTAR, type DetalleReportar } from '../lib/reportarEvento';
import { MisReportes, contarNovedades } from './soporte/MisReportes';
import { ReportarProblema } from './soporte/ReportarProblema';
import type { VistaReporte } from './soporte/ExplicacionReporte';

interface Turno {
  role: 'user' | 'assistant';
  content: string;
}

type Pestana = 'reportar' | 'mis' | 'consulta';

/** El chat de datos original (sin cambios de comportamiento). */
function ConsultaDatos() {
  const [mensajes, setMensajes] = useState<Turno[]>([]);
  const [texto, setTexto] = useState('');
  const [cargando, setCargando] = useState(false);
  const finRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    finRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [mensajes, cargando]);

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    const pregunta = texto.trim();
    if (!pregunta || cargando) return;
    const historial = mensajes.slice(-8);
    setMensajes((m) => [...m, { role: 'user', content: pregunta }]);
    setTexto('');
    setCargando(true);
    try {
      const r = await api<{ respuesta: string }>('/chat', { method: 'POST', body: { pregunta, historial } });
      setMensajes((m) => [...m, { role: 'assistant', content: r.respuesta }]);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'No se pudo obtener respuesta.';
      setMensajes((m) => [...m, { role: 'assistant', content: `⚠️ ${msg}` }]);
    } finally {
      setCargando(false);
    }
  }

  return (
    <>
      <div className="flex-1 space-y-3 overflow-y-auto bg-slate-50 p-3">
        {mensajes.length === 0 && (
          <div className="mt-6 text-center text-sm text-slate-400">
            Pregúntame sobre tus datos.
            <div className="mt-2 space-y-1 text-xs">
              <p>"¿Cuántos manifiestos he creado?"</p>
              <p>"¿Qué falta por cumplir?"</p>
              <p>"¿Cuántos envíos con error hay en la cola?"</p>
            </div>
          </div>
        )}
        {mensajes.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${
                m.role === 'user' ? 'bg-celeste-600 text-white dark:text-brand-navy' : 'border border-slate-200 bg-surface text-slate-700'
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}
        {cargando && (
          <div className="flex justify-start">
            <div className="rounded-2xl border border-slate-200 bg-surface px-3 py-2 text-slate-400">
              <Loader2 size={16} className="animate-spin" />
            </div>
          </div>
        )}
        <div ref={finRef} />
      </div>
      <form onSubmit={enviar} className="flex items-center gap-2 border-t border-slate-200 p-2">
        <input className="field-input flex-1" placeholder="Escribe tu pregunta…" value={texto} onChange={(e) => setTexto(e.target.value)} disabled={cargando} />
        <button type="submit" className="btn-primary px-3 py-2" disabled={cargando || texto.trim() === ''} aria-label="Enviar">
          <Send size={16} />
        </button>
      </form>
    </>
  );
}

export function ChatWidget() {
  const location = useLocation();
  const [chatHabilitado, setChatHabilitado] = useState(false);
  const [abierto, setAbierto] = useState(false);
  const [pestana, setPestana] = useState<Pestana>('reportar');
  const [inicial, setInicial] = useState('');
  const [reportes, setReportes] = useState<VistaReporte[]>([]);
  const [cargandoRep, setCargandoRep] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ habilitado: boolean }>('/chat/estado');
        setChatHabilitado(r.habilitado);
      } catch {
        setChatHabilitado(false);
      }
    })();
  }, []);

  const recargar = useCallback(async () => {
    setCargandoRep(true);
    try {
      setReportes(await api<VistaReporte[]>('/reportes'));
    } catch {
      /* sin conexión o sin sesión: se queda lo que había */
    } finally {
      setCargandoRep(false);
    }
  }, []);

  // Carga inicial y cada 3 minutos (para la marca de novedades del botón).
  useEffect(() => {
    void recargar();
    const t = setInterval(() => void recargar(), 180_000);
    return () => clearInterval(t);
  }, [recargar]);

  // "Reportar el problema" desde la pantalla de error.
  useEffect(() => {
    const abrir = (ev: Event) => {
      const d = (ev as CustomEvent<DetalleReportar>).detail;
      setInicial(d?.texto ?? '');
      setPestana('reportar');
      setAbierto(true);
    };
    window.addEventListener(EVENTO_REPORTAR, abrir);
    return () => window.removeEventListener(EVENTO_REPORTAR, abrir);
  }, []);

  const novedades = contarNovedades(reportes);

  const tabs: { id: Pestana; label: string; icon: typeof LifeBuoy }[] = [
    { id: 'reportar', label: 'Reportar', icon: LifeBuoy },
    { id: 'mis', label: 'Mis reportes', icon: ListChecks },
    ...(chatHabilitado ? [{ id: 'consulta' as const, label: 'Consultar datos', icon: Bot }] : []),
  ];

  return (
    <>
      {!abierto && (
        <button
          onClick={() => setAbierto(true)}
          className="fixed bottom-5 right-5 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-celeste-600 text-white shadow-lg transition hover:bg-celeste-700 dark:text-brand-navy"
          aria-label="Abrir ayuda y reportes"
        >
          <MessageCircle size={24} />
          {novedades > 0 && (
            <span className="absolute -right-1 -top-1 flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-emerald-500 px-1 text-[11px] font-bold text-white">{novedades}</span>
          )}
        </button>
      )}

      {abierto && (
        <div className="fixed bottom-5 right-5 z-40 flex h-[32rem] w-[22rem] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-surface shadow-2xl">
          <header className="flex items-center justify-between bg-celeste-700 px-4 py-3 text-white dark:text-brand-navy">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <LifeBuoy size={18} /> Ayuda
            </div>
            <button onClick={() => setAbierto(false)} aria-label="Cerrar">
              <X size={18} />
            </button>
          </header>
          <nav className="flex border-b border-slate-200 text-xs" role="tablist">
            {tabs.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={pestana === t.id}
                onClick={() => setPestana(t.id)}
                className={`flex flex-1 items-center justify-center gap-1 px-2 py-2 font-medium ${pestana === t.id ? 'border-b-2 border-celeste-600 text-celeste-700' : 'text-slate-500 hover:text-slate-700'}`}
              >
                <t.icon size={13} /> {t.label}
                {t.id === 'mis' && novedades > 0 && <span className="ml-0.5 rounded-full bg-emerald-500 px-1.5 text-[10px] text-white">{novedades}</span>}
              </button>
            ))}
          </nav>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            {pestana === 'reportar' && (
              <ReportarProblema key={inicial} pantalla={location.pathname} inicial={inicial} alRegistrar={() => void recargar()} />
            )}
            {pestana === 'mis' && <MisReportes reportes={reportes} cargando={cargandoRep} recargar={() => void recargar()} />}
            {pestana === 'consulta' && chatHabilitado && <ConsultaDatos />}
          </div>
        </div>
      )}
    </>
  );
}
