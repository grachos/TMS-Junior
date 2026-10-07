/**
 * Konekto - Light/dark theme. Stored choice wins; otherwise the OS preference.
 * The initial class is applied by an inline script in index.html (before first
 * paint, to avoid a flash); this module only handles later toggling.
 */

import { useCallback, useEffect, useState } from 'react';

const KEY = 'konekto-theme';
export type Theme = 'light' | 'dark';

function current(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(current);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((t) => {
      const next: Theme = t === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem(KEY, next);
      } catch {
        // Private mode: the toggle still works for this session.
      }
      return next;
    });
  }, []);

  return { theme, toggle };
}
