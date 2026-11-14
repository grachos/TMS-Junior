/**
 * Light TMS - Guard so a form or action button sends its request only once
 * while a previous send is still in flight.
 *
 * The forms already disable their button with React state (`saving`), but that
 * only takes effect after React re-renders: two submits fired in the same tick
 * (a fast double tap, a double requestSubmit) both got through and sent two
 * requests (seen in the E2E test of the dispatch form). A ref changes
 * synchronously, so the second one is ignored immediately. The server is the
 * real guarantee (locks + 409); this just avoids the needless second request
 * and the confusing error it produces.
 *
 * Usage, keeping each form's own `saving` state for the UI:
 *   const envio = useEnvioUnico();
 *   async function onSubmit(e) {
 *     e.preventDefault();            // always first, even when blocked
 *     ...validation...
 *     if (!envio.tomar()) return;    // a send is already in flight
 *     setSaving(true);
 *     try { ... } finally { setSaving(false); envio.soltar(); }
 *   }
 */

import { useMemo, useRef } from 'react';

export interface EnvioUnico {
  /**
   * Takes the guard; returns false if a send is already in flight. Pass a key
   * (e.g. a row id) to guard each row separately: processing row 1 must not
   * silently block a click on row 2.
   */
  tomar: (clave?: string | number) => boolean;
  /** Releases the guard (call in `finally`, with the same key). */
  soltar: (clave?: string | number) => void;
}

export function useEnvioUnico(): EnvioUnico {
  const enCurso = useRef(new Set<string>());
  return useMemo(
    () => ({
      tomar: (clave = '') => {
        const k = String(clave);
        if (enCurso.current.has(k)) return false;
        enCurso.current.add(k);
        return true;
      },
      soltar: (clave = '') => {
        enCurso.current.delete(String(clave));
      },
    }),
    [],
  );
}
