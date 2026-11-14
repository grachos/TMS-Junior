/**
 * Light TMS - Notice shown in a tab that was opened before a release.
 * Checks /version.json now and then (and when the tab becomes visible again) and,
 * if the server has a different build, offers a reload. Never reloads on its own.
 */

import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { hayVersionNueva, leerVersionDelServidor } from '../lib/versionCheck';

const CADA_MS = 5 * 60 * 1000;

export function NuevaVersion() {
  const [hayNueva, setHayNueva] = useState(false);

  useEffect(() => {
    let vivo = true;
    const revisar = () => {
      void hayVersionNueva(__BUILD_ID__, leerVersionDelServidor).then((nueva) => {
        if (vivo && nueva) setHayNueva(true);
      });
    };
    const alVolver = () => {
      if (document.visibilityState === 'visible') revisar();
    };
    const primera = setTimeout(revisar, 30_000);
    const intervalo = setInterval(revisar, CADA_MS);
    document.addEventListener('visibilitychange', alVolver);
    window.addEventListener('focus', revisar);
    return () => {
      vivo = false;
      clearTimeout(primera);
      clearInterval(intervalo);
      document.removeEventListener('visibilitychange', alVolver);
      window.removeEventListener('focus', revisar);
    };
  }, []);

  if (!hayNueva) return null;
  return (
    <div
      role="status"
      className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-lg bg-celeste-700 px-4 py-3 text-sm text-white shadow-lg"
    >
      <span>Hay una versión nueva de Konekto.</span>
      <button className="flex items-center gap-1 rounded bg-white/20 px-2 py-1 font-medium hover:bg-white/30" onClick={() => window.location.reload()}>
        <RefreshCw size={14} /> Actualizar
      </button>
    </div>
  );
}
