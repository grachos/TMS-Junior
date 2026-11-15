import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { AlertTriangle, Home, LifeBuoy, RotateCcw } from 'lucide-react';
import { telemetria } from '../lib/telemetriaApp';
import { abrirReporte } from '../lib/reportarEvento';

interface Props {
  children: ReactNode;
  /** 'pagina': dentro del marco de la aplicación (menú y asistente siguen vivos). 'global': último recurso. */
  variante?: 'pagina' | 'global';
}

/**
 * Atrapa errores de renderizado de React. Registra el fallo en la telemetría (sin ciclos: ver lib/telemetria.ts) y muestra
 * una pantalla de error con salida: reintentar, reportar el problema o volver al inicio. No promete nada sobre los datos.
 */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    void telemetria.reportar({ tipo: 'react', mensaje: error.message || 'Error de renderizado', pila: `${error.stack ?? ''}\n${info.componentStack ?? ''}` });
  }

  reintentar = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.variante === 'global') {
      return (
        <div className="flex min-h-full items-center justify-center p-6">
          <div className="max-w-sm text-center">
            <AlertTriangle className="mx-auto mb-3 text-amber-500" size={32} />
            <h1 className="text-lg font-semibold text-slate-800">Algo salió mal</h1>
            <p className="mt-2 text-sm text-slate-500">La aplicación tuvo un problema inesperado. Recarga la página; si sigue igual, avisa al equipo de soporte.</p>
            <button className="btn-primary mt-4" onClick={() => window.location.reload()}>
              <RotateCcw size={16} /> Recargar
            </button>
          </div>
        </div>
      );
    }
    return (
      <div role="alert" className="mx-auto mt-10 max-w-md rounded-xl border border-amber-200 bg-amber-50 p-5 text-center dark:border-amber-500/30 dark:bg-amber-500/10">
        <AlertTriangle className="mx-auto mb-2 text-amber-500" size={28} />
        <h2 className="text-base font-semibold text-slate-800">Esta pantalla tuvo un problema</h2>
        <p className="mt-2 text-sm text-slate-600">
          Ya quedó registrado para el equipo técnico. Si estabas guardando algo, <strong>revisa en la lista si quedó registrado antes de repetirlo</strong>.
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <button className="btn-ghost" onClick={this.reintentar}>
            <RotateCcw size={16} /> Reintentar
          </button>
          <button className="btn-primary" onClick={() => abrirReporte({ texto: 'Se me mostró el aviso "Esta pantalla tuvo un problema". ' })}>
            <LifeBuoy size={16} /> Reportar el problema
          </button>
          <a className="btn-ghost" href="/">
            <Home size={16} /> Inicio
          </a>
        </div>
      </div>
    );
  }
}

/** Se reinicia al cambiar de ruta: salir de una pantalla rota por el menú la "cura". Debe ir DENTRO de <BrowserRouter>. */
export function RutaErrorBoundary({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return (
    <ErrorBoundary key={pathname} variante="pagina">
      {children}
    </ErrorBoundary>
  );
}
