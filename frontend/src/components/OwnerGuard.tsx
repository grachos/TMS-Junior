import { useEffect, useState, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { api } from '../lib/api';

/**
 * Protege la consola de soporte. La capacidad del store solo decide si se muestra el MENÚ; aquí se valida SIEMPRE contra el
 * servidor (GET /api/soporte/estado, que exige ser el propietario) antes de mostrar nada. Cambiar localStorage, entrar por la
 * URL o alterar el JavaScript no permite ver datos: sin un 200 del servidor, se regresa al inicio y no se renderiza el contenido.
 */
export function OwnerGuard({ children }: { children: ReactNode }) {
  const [estado, setEstado] = useState<'cargando' | 'ok' | 'denegado'>('cargando');

  useEffect(() => {
    let vivo = true;
    api('/soporte/estado').then(
      () => vivo && setEstado('ok'),
      () => vivo && setEstado('denegado'),
    );
    return () => {
      vivo = false;
    };
  }, []);

  if (estado === 'cargando') {
    return (
      <div className="flex justify-center py-16 text-slate-400">
        <Loader2 className="animate-spin" />
      </div>
    );
  }
  if (estado === 'denegado') return <Navigate to="/" replace />;
  return <>{children}</>;
}
