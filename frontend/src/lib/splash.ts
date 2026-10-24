/**
 * Konekto - Splash state. The splash itself is static markup in index.html (so it
 * paints before any JS loads); this store only decides when it is visible.
 *
 * It starts visible. Pages call hide() once they are ready (Login on mount, the
 * dashboard once its data settles); Login calls show() after a successful sign-in
 * so the splash covers the transition to the dashboard. hide() waits so the logo
 * is on screen for a minimum time instead of flashing: ENTRY_MIN_MS when entering
 * the platform (first load and after signing in), EXIT_MIN_MS when signing out.
 * The progress bar in the splash runs for that same duration.
 */

import { create } from 'zustand';
import { useAuthStore } from '../store/auth';

/** Minimum time on screen when entering the platform (first load / after sign-in). */
export const ENTRY_MIN_MS = 2500;
/** Shorter when leaving: the user just asked to sign out. */
const EXIT_MIN_MS = 1200;

// Counted from the start of the page load, so the progress bar (which starts on the
// first paint) and the minimum time line up even when the JS takes a while to arrive.
let shownAt = typeof performance !== 'undefined' && performance.timeOrigin ? performance.timeOrigin : Date.now();
let minVisible = ENTRY_MIN_MS;
let timer: ReturnType<typeof setTimeout> | null = null;

interface SplashState {
  visible: boolean;
  /** Minimum time of the current showing (drives the progress bar length). */
  minMs: number;
  show: (minMs?: number) => void;
  hide: (minMs?: number) => void;
}

export const useSplash = create<SplashState>((set) => ({
  visible: true,
  minMs: ENTRY_MIN_MS,
  show: (minMs = ENTRY_MIN_MS) => {
    if (timer) clearTimeout(timer);
    shownAt = Date.now();
    minVisible = minMs;
    set({ visible: true, minMs });
  },
  hide: (minMs = minVisible) => {
    if (timer) clearTimeout(timer);
    const wait = Math.max(0, minMs - (Date.now() - shownAt));
    timer = setTimeout(() => set({ visible: false }), wait);
  },
}));

/** Time for the splash to become opaque before the page underneath changes. */
const COVER_MS = 400;
let closing = false;

/**
 * Ends the session behind the splash: it fades in first, then `after` runs (e.g.
 * navigate to /login) and the session is cleared, so the swap to the login page
 * happens out of sight. Login hides the splash again once its form is ready.
 * Also used for expired sessions (401), where several requests may fail at once.
 */
export function logoutWithSplash(after?: () => void, byInactivity = false): void {
  if (closing) return;
  closing = true;
  useSplash.getState().show(EXIT_MIN_MS);
  setTimeout(() => {
    // Navigate first: once the session is cleared, ProtectedRoute redirects to a
    // bare /login, which would overwrite a target like /login?expired=1.
    after?.();
    useAuthStore.getState().logout(byInactivity);
    closing = false;
  }, COVER_MS);
}
