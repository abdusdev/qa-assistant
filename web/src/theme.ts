import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const KEY = 'qa-assistant-theme';

function stored(): Theme | undefined {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : undefined;
  } catch {
    // Private windows and blocked site data: the page works without a remembered choice.
    return undefined;
  }
}

const systemTheme = (): Theme =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';

export const initialTheme = (): Theme => stored() ?? systemTheme();

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

/** The theme in use, a way to change it, and the person's choice remembered in this browser. */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((current) => {
      const next: Theme = current === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem(KEY, next);
      } catch {
        // Not remembered, still applied.
      }
      return next;
    });
  }, []);

  return { theme, toggle };
}
