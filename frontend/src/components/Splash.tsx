/**
 * Konekto - Drives the static #splash element from index.html: fades it out when
 * the splash store says hidden, brings it back when shown again (after login).
 */

import { useEffect } from 'react';
import { useSplash } from '../lib/splash';

/** Never leave the splash up if some page forgets (or fails) to call hide(). */
const SAFETY_MS = 8000;

export function SplashController() {
  const visible = useSplash((s) => s.visible);

  useEffect(() => {
    const el = document.getElementById('splash');
    if (!el) return;
    if (visible) {
      el.hidden = false;
      // Force a style flush so the opacity transition starts from the faded state
      // (a transition never runs out of display:none on its own).
      void el.offsetWidth;
      el.classList.remove('splash-hide');
      const safety = setTimeout(() => useSplash.getState().hide(0), SAFETY_MS);
      return () => clearTimeout(safety);
    }
    el.classList.add('splash-hide');
    const done = setTimeout(() => {
      el.hidden = true;
    }, 650);
    return () => clearTimeout(done);
  }, [visible]);

  return null;
}
