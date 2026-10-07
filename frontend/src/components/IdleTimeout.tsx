/**
 * Konekto - Inactivity timeout. After IDLE_LIMIT_MS without activity the session
 * is closed; during the last WARNING_MS a dialog asks whether to stay signed in.
 *
 * - Idleness is computed from wall-clock timestamps (never a counter), so
 *   background-tab timer throttling can't desynchronize it.
 * - The last-activity timestamp is shared through localStorage, so activity in
 *   one tab keeps the others alive (and dismisses their dialogs). An in-memory
 *   copy keeps a tab working when storage is blocked (private mode).
 *
 * PITFALL (shipped once in another project): the timer effect below must run
 * exactly once ([] deps). If it depends on the dialog state, opening the dialog
 * re-runs it, and resetting the clock at its start means the session never
 * closes. Anything that changes between renders is read through refs.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Clock } from 'lucide-react';
import { api } from '../lib/api';
import { logoutWithSplash } from '../lib/splash';

const IDLE_LIMIT_MS = 10 * 60 * 1000;
const WARNING_MS = 60 * 1000;
const LAST_ACTIVITY_KEY = 'konekto-lastActivityAt';
const ACTIVITY_EVENTS = ['mousedown', 'keydown', 'scroll', 'touchstart', 'mousemove'] as const;
/** mousemove fires constantly; write the shared timestamp at most this often. */
const WRITE_THROTTLE_MS = 5000;

/** UI strings, in one place to ease translation. */
const TEXT = {
  title: '¿Sigues ahí?',
  closesIn: (seconds: number) => (
    <>
      Tu sesión se cerrará en <strong>{seconds} s</strong> por inactividad.
    </>
  ),
  stay: 'Mantener la sesión',
  signOut: 'Cerrar sesión',
};

let memoryLastActivity = Date.now();

function readLastActivity(): number {
  try {
    return Number(localStorage.getItem(LAST_ACTIVITY_KEY)) || memoryLastActivity;
  } catch {
    return memoryLastActivity;
  }
}

function writeLastActivity(at: number): void {
  memoryLastActivity = at;
  try {
    localStorage.setItem(LAST_ACTIVITY_KEY, String(at));
  } catch {
    // Storage unavailable: the in-memory copy keeps this tab working.
  }
}

export function IdleTimeout() {
  const navigate = useNavigate();
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const warningOpen = useRef(false);
  const lastWrite = useRef(0);
  const expireRef = useRef<(byInactivity: boolean) => void>(() => {});

  // Keep the latest navigate reachable without re-running the timer effect.
  useEffect(() => {
    expireRef.current = (byInactivity: boolean) => {
      logoutWithSplash(() => navigate(byInactivity ? '/login?expired=1' : '/login', { replace: true }), byInactivity);
    };
  });

  // Runs ONCE. See the PITFALL note at the top of the file.
  useEffect(() => {
    writeLastActivity(Date.now());

    function onActivity() {
      const now = Date.now();
      // Ignored while the dialog is open (the user must answer it) and throttled.
      if (warningOpen.current || now - lastWrite.current < WRITE_THROTTLE_MS) return;
      lastWrite.current = now;
      writeLastActivity(now);
    }
    ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));

    const timer = setInterval(() => {
      const idle = Date.now() - readLastActivity();
      if (idle >= IDLE_LIMIT_MS) {
        clearInterval(timer);
        expireRef.current(true);
      } else if (idle >= IDLE_LIMIT_MS - WARNING_MS) {
        warningOpen.current = true;
        setSecondsLeft(Math.ceil((IDLE_LIMIT_MS - idle) / 1000));
      } else {
        warningOpen.current = false; // also closes the dialog if another tab was active
        setSecondsLeft(null);
      }
    }, 1000);

    return () => {
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, onActivity));
      clearInterval(timer);
    };
  }, []);

  function stayLoggedIn() {
    writeLastActivity(Date.now());
    warningOpen.current = false;
    setSecondsLeft(null);
    void api('/auth/me').catch(() => {}); // one cheap authenticated call; a 401 logs out as usual
  }

  if (secondsLeft === null) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-brand-ink/60 px-4"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="idle-title"
    >
      <div className="card w-full max-w-sm shadow-xl">
        <div className="mb-3 flex items-center gap-2 text-celeste-700">
          <Clock className="h-5 w-5" aria-hidden="true" />
          <h2 id="idle-title" className="text-base font-semibold text-slate-800">
            {TEXT.title}
          </h2>
        </div>
        <p className="mb-5 text-sm text-slate-600">{TEXT.closesIn(secondsLeft)}</p>
        <div className="flex gap-2">
          <button type="button" autoFocus onClick={stayLoggedIn} className="btn-primary flex-1">
            {TEXT.stay}
          </button>
          <button type="button" onClick={() => expireRef.current(false)} className="btn-ghost">
            {TEXT.signOut}
          </button>
        </div>
      </div>
    </div>
  );
}
