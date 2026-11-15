import { useEffect, type ReactNode } from 'react';
import { useSplash } from '../lib/splash';
import { KonektoMark, KonektoWordmark } from '../components/Logo';

/** Marco de las pantallas públicas de acceso (recuperar / restablecer contraseña), con la misma imagen del login. */
export function AccesoLayout({ children }: { children: ReactNode }) {
  // El splash inicial se oculta aquí (como en el resto de las páginas): estas pantallas no pasan por el login.
  useEffect(() => {
    useSplash.getState().hide();
  }, []);
  return (
    <div className="flex min-h-full items-center justify-center overflow-hidden bg-brand-navy p-4 dark:bg-brand-ink">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-white">
          <div className="mb-3">
            <KonektoMark size={64} tone="dark" />
          </div>
          <h1 className="text-3xl">
            <KonektoWordmark />
          </h1>
        </div>
        {children}
      </div>
    </div>
  );
}
