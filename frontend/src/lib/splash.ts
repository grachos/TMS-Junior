/**
 * Konekto - Splash state. The splash itself is static markup in index.html (so it
 * paints before any JS loads); this store only decides when it is visible.
 *
 * It starts visible. Pages call hide() once they are ready (Login on mount, the
 * dashboard once its data settles); Login calls show() after a successful sign-in
 * so the splash covers the transition to the dashboard. hide() waits so the logo
 * is on screen for at least MIN_VISIBLE_MS instead of flashing.
 */

import { create } from 'zustand';

const MIN_VISIBLE_MS = 900;

let shownAt = Date.now();
let timer: ReturnType<typeof setTimeout> | null = null;

interface SplashState {
  visible: boolean;
  show: () => void;
  hide: (minMs?: number) => void;
}

export const useSplash = create<SplashState>((set) => ({
  visible: true,
  show: () => {
    if (timer) clearTimeout(timer);
    shownAt = Date.now();
    set({ visible: true });
  },
  hide: (minMs = MIN_VISIBLE_MS) => {
    if (timer) clearTimeout(timer);
    const wait = Math.max(0, minMs - (Date.now() - shownAt));
    timer = setTimeout(() => set({ visible: false }), wait);
  },
}));
