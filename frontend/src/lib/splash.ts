/**
 * Konekto - Splash state. The splash itself is static markup in index.html (so it
 * paints before any JS loads); this store only decides when it is visible.
 *
 * It starts visible. The dashboard calls hide() once its data settles; Login calls
 * show() after a successful sign-in so the splash covers the transition to the
 * dashboard. hide() waits so the logo is on screen for a minimum time instead of
 * flashing: ENTRY_MIN_MS when entering the platform (first load with a session and
 * after signing in). The progress bar in the splash runs for that same duration.
 * Without a session (first load, or after signing out) there is no bar: the login
 * page takes over the big logo and shrinks it into place (loginIntro.ts).
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
  /** The current showing covers the page at once instead of fading in. */
  instant: boolean;
  /** 'entry' shows the progress bar; 'login' is just the big logo (the login page takes it over). */
  mode: 'entry' | 'login';
  show: (minMs?: number, instant?: boolean, mode?: 'entry' | 'login') => void;
  hide: (minMs?: number) => void;
  /** Hides at once, no minimum time (the login intro takes over the logo). */
  dismiss: () => void;
}

export const useSplash = create<SplashState>((set) => ({
  visible: true,
  minMs: ENTRY_MIN_MS,
  instant: false,
  // index.html already picked the mode (no saved session -> 'login') before any JS ran.
  mode:
    typeof document !== 'undefined' && document.getElementById('splash')?.classList.contains('splash-login')
      ? 'login'
      : 'entry',
  // instant: for when the page underneath is about to change in the same tick (after
  // sign-in), so it must never be seen before the splash.
  show: (minMs = ENTRY_MIN_MS, instant = false, mode = 'entry') => {
    if (timer) clearTimeout(timer);
    shownAt = Date.now();
    minVisible = minMs;
    set({ visible: true, minMs, instant, mode });
  },
  dismiss: () => {
    if (timer) clearTimeout(timer);
    set({ visible: false });
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
 * happens out of sight. The splash is the big logo alone ('login' mode, no progress
 * bar): the login page then shrinks it into place (see loginIntro.ts).
 * Also used for expired sessions (401), where several requests may fail at once.
 */
export function logoutWithSplash(after?: () => void, byInactivity = false): void {
  if (closing) return;
  closing = true;
  useSplash.getState().show(EXIT_MIN_MS, false, 'login');
  setTimeout(() => {
    // Navigate first: once the session is cleared, ProtectedRoute redirects to a
    // bare /login, which would overwrite a target like /login?expired=1.
    after?.();
    useAuthStore.getState().logout(byInactivity);
    closing = false;
  }, COVER_MS);
}
