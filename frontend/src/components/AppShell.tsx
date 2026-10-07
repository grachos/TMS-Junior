/**
 * Konekto - Authenticated app shell: top bar + responsive sidebar nav.
 *
 * Mirrors the PHP navigation (src/vista.php): Inicio, Solicitudes, Despachos,
 * Cola, Cumplido, and the Maestros group (Terceros, Vehículos, Productos,
 * Empresa).
 */

import { useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  FileText,
  Truck,
  Send,
  CheckCircle2,
  Users,
  Package,
  Building2,
  FileBarChart2,
  UsersRound,
  LogOut,
  Menu,
  X,
  Bell,
  BellOff,
  Sun,
  Moon,
  type LucideIcon,
} from 'lucide-react';
import { useAuthStore, type Pagina } from '../store/auth';
import { api } from '../lib/api';
import { useTheme } from '../lib/theme';
import { logoutWithSplash, useSplash } from '../lib/splash';
import { ChatWidget } from './ChatWidget';
import { KonektoMark, KonektoWordmark } from './Logo';
import { IdleTimeout } from './IdleTimeout';
import { soportePush, suscripcionActual, activarPush, desactivarPush } from '../lib/push';

/** How often to re-poll the nav badge counts (ms). */
const BADGE_POLL_MS = 20_000;

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Page permission required to see this item; omitted = always visible (e.g. Inicio). */
  pagina?: Pagina;
  /** Only shown to rol='admin', regardless of paginas. */
  adminOnly?: boolean;
}

/** Polls a `{ pendientes }` count endpoint every BADGE_POLL_MS. */
function usePendientes(endpoint: string): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const r = await api<{ pendientes?: number }>(endpoint);
        if (!cancelled) setCount(r.pendientes ?? 0);
      } catch {
        // Ignore transient failures (e.g. session expiring) — the next poll retries.
      }
    }
    void poll();
    const timer = setInterval(poll, BADGE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [endpoint]);
  return count;
}

const NAV: { section?: string; items: NavItem[] }[] = [
  {
    items: [
      { to: '/', label: 'Inicio', icon: LayoutDashboard },
      { to: '/solicitudes', label: 'Solicitudes', icon: FileText, pagina: 'solicitudes' },
      { to: '/despachos', label: 'Despachos', icon: Truck, pagina: 'despachos' },
      { to: '/cola', label: 'Cola de envíos', icon: Send, pagina: 'cola' },
      { to: '/cumplido', label: 'Cumplido', icon: CheckCircle2, pagina: 'cumplido' },
      { to: '/informe', label: 'Informe', icon: FileBarChart2, pagina: 'informe' },
    ],
  },
  {
    section: 'Maestros',
    items: [
      { to: '/terceros', label: 'Terceros', icon: Users, pagina: 'terceros' },
      { to: '/vehiculos', label: 'Vehículos', icon: Truck, pagina: 'vehiculos' },
      { to: '/productos', label: 'Productos', icon: Package, pagina: 'productos' },
      { to: '/empresa', label: 'Empresa', icon: Building2, pagina: 'empresa' },
      { to: '/usuarios', label: 'Usuarios', icon: UsersRound, adminOnly: true },
    ],
  },
];

/** Header sun/moon: switch between the light and dark theme. */
function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const dark = theme === 'dark';
  return (
    <button className="btn-ghost" onClick={toggle} title={dark ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro'} aria-label="Cambiar tema">
      {dark ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}

/** Header bell: subscribe/unsubscribe this browser from push notifications. */
function NotificationToggle() {
  const [suscrito, setSuscrito] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const soportado = soportePush() === 'ready';

  useEffect(() => {
    if (!soportado) return;
    void suscripcionActual().then((s) => setSuscrito(s != null));
  }, [soportado]);

  if (!soportado) return null;

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      if (suscrito) {
        await desactivarPush();
        setSuscrito(false);
      } else {
        await activarPush();
        setSuscrito(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo actualizar la suscripción.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative">
      <button
        className="btn-ghost"
        onClick={toggle}
        disabled={busy || suscrito === null}
        title={suscrito ? 'Desactivar notificaciones' : 'Activar notificaciones'}
      >
        {suscrito ? <Bell size={18} /> : <BellOff size={18} />}
      </button>
      {error && (
        <p className="absolute right-0 top-full z-10 mt-1 w-56 rounded-md bg-red-50 p-2 text-xs text-red-700 shadow">
          {error}
        </p>
      )}
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const { user, canAccess, isAdmin } = useAuthStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [colaPendientes, setColaPendientes] = useState(0);

  // The dashboard hides the splash when its data is in; any other landing page does it here.
  useEffect(() => {
    if (location.pathname !== '/') useSplash.getState().hide();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visibleNav = NAV.map((group) => ({
    ...group,
    items: group.items.filter((item) => {
      if (item.adminOnly) return isAdmin();
      if (item.pagina) return canAccess(item.pagina);
      return true;
    }),
  })).filter((group) => group.items.length > 0);

  // Poll the queue's pending/error count for the "Cola de envíos" nav badge.
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const r = await api<{ pendiente?: number; enviando?: number; error?: number }>('/cola/resumen', {
          query: { proceso: 'todos' },
        });
        if (!cancelled) setColaPendientes((r.pendiente ?? 0) + (r.enviando ?? 0) + (r.error ?? 0));
      } catch {
        // Ignore transient failures (e.g. session expiring) — the next poll retries.
      }
    }
    void poll();
    const timer = setInterval(poll, BADGE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // Poll pending/not-yet-migrated counts for the other nav badges.
  const despachosPendientes = usePendientes('/despachos/resumen');
  const cumplidoPendientes = usePendientes('/cumplido/resumen');
  const tercerosPendientes = usePendientes('/terceros/resumen');
  const vehiculosPendientes = usePendientes('/vehiculos/resumen');
  const pendientesPorRuta: Record<string, number> = {
    '/despachos': despachosPendientes,
    '/cumplido': cumplidoPendientes,
    '/terceros': tercerosPendientes,
    '/vehiculos': vehiculosPendientes,
  };

  const doLogout = () => {
    logoutWithSplash(() => navigate('/login', { replace: true }));
  };

  return (
    <div className="flex min-h-full flex-col">
      {/* Brand header: logo + name + lema on every page, user actions on the right. */}
      <header className="flex items-center justify-between gap-3 border-b border-slate-200 bg-surface px-4 py-3 md:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <button className="md:hidden" onClick={() => setOpen(true)} aria-label="Abrir menú">
            <Menu size={22} />
          </button>
          <KonektoMark size={44} tone="auto" className="shrink-0" />
          <div className="min-w-0 leading-tight">
            <p className="text-xl text-brand-navy dark:text-white">
              <KonektoWordmark />
            </p>
            <p className="text-xs text-slate-500 sm:truncate sm:text-sm">Despacho &amp; RNDC Light</p>
          </div>
        </div>
        <div className="flex items-center gap-2 sm:gap-4">
          <div className="hidden text-right sm:block">
            <p className="text-sm font-medium text-slate-700">{user?.nombre}</p>
            <p className="text-xs uppercase tracking-wide text-celeste-600">{user?.rol}</p>
          </div>
          <ThemeToggle />
          <NotificationToggle />
          <button className="btn-ghost" onClick={doLogout}>
            <LogOut size={16} /> <span className="hidden sm:inline">Salir</span>
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-30 w-64 transform bg-brand-navy text-white transition-transform md:static md:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex justify-end px-4 pt-4 md:hidden">
          <button onClick={() => setOpen(false)} aria-label="Cerrar menú">
            <X size={20} />
          </button>
        </div>
        <nav className="mt-2 space-y-6 px-3 pb-6 md:mt-5">
          {visibleNav.map((group, gi) => (
            <div key={gi}>
              {group.section && (
                <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wider text-white/50">
                  {group.section}
                </p>
              )}
              <ul className="space-y-1">
                {group.items.map((item) => (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      end={item.to === '/'}
                      onClick={() => setOpen(false)}
                      className={({ isActive }) =>
                        `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                          isActive ? 'bg-brand-cyan font-medium text-brand-navy' : 'text-white/80 hover:bg-white/10 hover:text-white'
                        }`
                      }
                    >
                      <item.icon size={18} />
                      <span className="flex-1">{item.label}</span>
                      {item.to === '/cola' && colaPendientes > 0 && (
                        <span className="flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-none text-white">
                          {colaPendientes > 99 ? '99+' : colaPendientes}
                        </span>
                      )}
                      {(pendientesPorRuta[item.to] ?? 0) > 0 && (
                        <span className="flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-none text-white">
                          {(pendientesPorRuta[item.to] ?? 0) > 99 ? '99+' : pendientesPorRuta[item.to]}
                        </span>
                      )}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </aside>

      {/* Backdrop (mobile) */}
      {open && <div className="fixed inset-0 z-20 bg-black/30 md:hidden" onClick={() => setOpen(false)} />}

      {/* Main */}
      <main className="min-w-0 flex-1 overflow-auto p-4 md:p-6">{children}</main>
      </div>

      <ChatWidget />
      <IdleTimeout />
    </div>
  );
}
