/**
 * Konekto - Login intro. When the login form appears (first load, or after signing
 * out) the big splash logo shrinks into the logo block of the form instead of just
 * fading away.
 *
 * The splash and the login page share the same background, so the splash is simply
 * removed in the same frame and the real login elements take over: each one starts
 * at the size and position of its splash counterpart (FLIP) and animates to its own.
 */

import { useSplash } from './splash';

/** Minimum time the big logo stays on screen, counted from the start of the page load. */
const HOLD_MS = 1300;
/** Pause kept even when the page took longer than HOLD_MS to load. */
const MIN_HOLD_MS = 450;
const SHRINK_MS = 1000;
const FORM_DELAY_MS = 450;

export interface LoginIntroTargets {
  mark: HTMLElement | null;
  name: HTMLElement | null;
  tag: HTMLElement | null;
  card: HTMLElement | null;
}

function flipFrom(from: Element | null, to: HTMLElement | null): string | null {
  if (!from || !to) return null;
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  if (!a.width || !b.width) return null;
  const dx = a.left + a.width / 2 - (b.left + b.width / 2);
  const dy = a.top + a.height / 2 - (b.top + b.height / 2);
  return `translate(${dx}px, ${dy}px) scale(${a.width / b.width})`;
}

/** Call once, from a layout effect, when the login page mounts. */
export function playLoginIntro(t: LoginIntroTargets): void {
  const splash = document.getElementById('splash');
  if (!splash || splash.hidden || !useSplash.getState().visible) return;

  const pairs: [Element | null, HTMLElement | null][] = [
    [splash.querySelector('svg'), t.mark],
    [splash.querySelector('.splash-name'), t.name],
    [splash.querySelector('.splash-tag'), t.tag],
  ];
  // Measure everything before touching anything.
  const starts = pairs.map(([from, to]) => flipFrom(from, to));

  // Hand over in this very frame: the splash goes away, the login elements are
  // already sitting where the splash logo was.
  splash.hidden = true;
  useSplash.getState().dismiss();

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const delay = Math.max(MIN_HOLD_MS, HOLD_MS - performance.now());
  pairs.forEach(([, to], i) => {
    const start = starts[i];
    if (!to || !start) return;
    to.animate([{ transform: start }, { transform: 'none' }], {
      duration: SHRINK_MS,
      delay,
      easing: 'cubic-bezier(0.22, 0.7, 0.3, 1)',
      fill: 'backwards',
    });
  });
  t.card?.animate(
    [
      { opacity: 0, transform: 'translateY(12px)' },
      { opacity: 1, transform: 'none' },
    ],
    { duration: 600, delay: delay + FORM_DELAY_MS, easing: 'ease-out', fill: 'backwards' },
  );
}
