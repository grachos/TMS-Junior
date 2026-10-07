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
import { useAuthStore } from '../store/auth';

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

/** Time for the splash to become opaque before the page underneath changes. */
const COVER_MS = 400;
let closing = false;

/**
 * Ends the session behind the splash: it fades in first, then the session is
 * cleared (and `after` runs, e.g. navigate to /login), so the swap to the login
 * page happens out of sight. Login hides the splash again once its form is ready.
 * Also used for expired sessions (401), where several requests may fail at once.
 */
export function logoutWithSplash(after?: () => void): void {
  if (closing) return;
  closing = true;
  useSplash.getState().show();
  setTimeout(() => {
    useAuthStore.getState().logout();
    after?.();
    closing = false;
  }, COVER_MS);
}
