/**
 * Light TMS - Auth store (Zustand, persisted).
 *
 * Holds the JWT and the current staff user. Persisted to localStorage so a
 * refresh keeps the session. `logout` clears it (also called on any 401).
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Rol = 'admin' | 'operador';

/** Assignable page/module keys — mirrors backend auth.repo.ts's PAGINAS. */
export type Pagina =
  | 'solicitudes' | 'despachos' | 'cola' | 'cumplido' | 'informe'
  | 'terceros' | 'vehiculos' | 'productos' | 'empresa';

/** Acciones críticas (mirror de backend permisos.ts; el servidor decide, esto solo muestra u oculta botones). */
export type Accion = string;

export interface StaffUser {
  id: number;
  email: string;
  nombre: string;
  rol: Rol;
  /** Allowed pages for rol='operador'; null = all (backward compatible). Ignored for 'admin'. */
  paginas: Pagina[] | null;
  /** Acciones guardadas para el operador (null = valores por defecto). Solo la usa la pantalla de Usuarios. */
  acciones?: Accion[] | null;
  /** Acciones que puede ejecutar hoy, ya resueltas por el servidor. */
  permisos?: Accion[];
  /** El servidor la marca en la cuenta del propietario: no se edita desde Usuarios. */
  protegido?: boolean;
  activo: 0 | 1;
  created_at: string;
}

/** Capacidades calculadas por el SERVIDOR. Solo para mostrar u ocultar la interfaz: el servidor vuelve a decidir en cada petición. */
export interface Capabilities {
  supportOwner: boolean;
}

interface AuthState {
  token: string | null;
  user: StaffUser | null;
  capabilities: Capabilities | null;
  /** True when the last logout was caused by inactivity (not persisted). */
  expired: boolean;
  setSession: (token: string, user: StaffUser, capabilities?: Capabilities | null) => void;
  setUser: (user: StaffUser, capabilities?: Capabilities | null) => void;
  logout: (byInactivity?: boolean) => void;
  isAdmin: () => boolean;
  canAccess: (pagina: Pagina) => boolean;
  /** ¿Puede ejecutar esta acción crítica? */
  can: (accion: Accion) => boolean;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      token: null,
      user: null,
      capabilities: null,
      expired: false,
      setSession: (token, user, capabilities = null) => set({ token, user, capabilities, expired: false }),
      setUser: (user, capabilities) => set(capabilities === undefined ? { user } : { user, capabilities }),
      logout: (byInactivity = false) => set({ token: null, user: null, capabilities: null, expired: byInactivity }),
      isAdmin: () => get().user?.rol === 'admin',
      can: (accion) => {
        const u = get().user;
        if (!u) return false;
        if (u.rol === 'admin') return true;
        return (u.permisos ?? []).includes(accion);
      },
      canAccess: (pagina) => {
        const u = get().user;
        if (!u) return false;
        if (u.rol === 'admin') return true;
        return u.paginas === null || u.paginas.includes(pagina);
      },
    }),
    { name: 'tms-auth', partialize: (s) => ({ token: s.token, user: s.user, capabilities: s.capabilities }) },
  ),
);

/**
 * `can` es una función estable: seleccionarla NO vuelve a dibujar el componente
 * cuando cambia el usuario (por ejemplo cuando /auth/me trae los permisos
 * nuevos justo después de abrir la pantalla). Este hook se suscribe al usuario
 * para que los botones se muestren u oculten en cuanto llegan los permisos.
 */
export function useCan(): (accion: Accion) => boolean {
  useAuthStore((s) => s.user);
  return useAuthStore.getState().can;
}
