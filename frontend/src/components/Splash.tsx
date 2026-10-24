/**
 * Konekto - Drives the static #splash element from index.html: fades it out when
 * the splash store says hidden, brings it back when shown again (after login or
 * on sign-out), and runs its "Cargando" progress bar.
 */

import { useLayoutEffect, useRef } from 'react';
import { useSplash } from '../lib/splash';

/** Never leave the splash up if some page forgets (or fails) to call hide(). */
const SAFETY_MS = 8000;
/** Time for the bar to visibly reach 100% before the fade-out starts. */
const FINISH_MS = 350;

export function SplashController() {
  const visible = useSplash((s) => s.visible);
  const firstRun = useRef(true);

  // A layout effect: it runs before the browser paints the render that triggered it, so
  // a page swapped in the same tick never shows up ahead of the splash.
  useLayoutEffect(() => {
    const el = document.getElementById('splash');
    if (!el) return;
    const fill = el.querySelector<HTMLElement>('.splash-fill');

    if (visible) {
      const { instant, mode } = useSplash.getState();
      if (instant) el.classList.add('splash-instant');
      el.classList.toggle('splash-login', mode === 'login');
      // The very first showing is the static markup already animating since the
      // first paint; only later showings restart the bar.
      const initial = firstRun.current;
      firstRun.current = false;
      el.hidden = false;
      if (!initial) {
        el.classList.remove('splash-run');
        if (fill) {
          fill.style.animation = '';
          fill.style.width = '';
        }
        el.style.setProperty('--splash-ms', `${useSplash.getState().minMs}ms`);
      }
      // Force a style flush so the opacity transition starts from the faded state
      // (a transition never runs out of display:none on its own) and the bar restarts.
      void el.offsetWidth;
      el.classList.remove('splash-hide');
      el.classList.add('splash-run');
      // Back to the normal fade for the hide that follows.
      const settle = instant ? requestAnimationFrame(() => el.classList.remove('splash-instant')) : 0;
      const safety = setTimeout(() => useSplash.getState().hide(0), SAFETY_MS);
      return () => {
        cancelAnimationFrame(settle);
        clearTimeout(safety);
      };
    }

    // Finish the bar from wherever it is, then fade the splash out.
    if (fill) {
      fill.style.width = getComputedStyle(fill).width;
      fill.style.animation = 'none';
      void fill.offsetWidth;
      fill.style.width = '100%';
    }
    const fade = setTimeout(() => el.classList.add('splash-hide'), FINISH_MS);
    const done = setTimeout(() => {
      el.hidden = true;
    }, FINISH_MS + 650);
    return () => {
      clearTimeout(fade);
      clearTimeout(done);
    };
  }, [visible]);

  return null;
}
