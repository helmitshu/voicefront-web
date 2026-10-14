'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * Signed-in app theming. Three token sets (globals.css, scoped to `.theme-root`)
 * selected by the `data-theme` attribute on <html>:
 *
 * - `pearl`    — the app's current look, sharpened (deep teal shell, warm cream)
 * - `midnight` — dark futuristic (deep ink, teal-cyan accent); the default
 * - `deepteal` — the shell's deep teal carried across the whole product
 *
 * The root layout carries an inline script that reads the saved choice and
 * sets the attribute before first paint, so there is never a flash of the
 * wrong theme. This provider mirrors that attribute into React state and
 * persists changes to localStorage. The choice is per user, per device.
 */
export type AppTheme = 'pearl' | 'midnight' | 'deepteal';

export const THEME_STORAGE_KEY = 'vf-theme';
export const DEFAULT_THEME: AppTheme = 'midnight';

export const THEMES: { key: AppTheme; label: string; blurb: string; swatches: [string, string, string] }[] = [
  {
    key: 'midnight',
    label: 'Midnight',
    blurb: 'Dark and futuristic, teal on deep ink',
    swatches: ['#060C11', '#0B161F', '#2DD4BF'],
  },
  {
    key: 'pearl',
    label: 'Pearl',
    blurb: 'The classic look, warm cream and deep teal',
    swatches: ['#F4F1E9', '#FFFFFF', '#0C7A66'],
  },
  {
    key: 'deepteal',
    label: 'Deep Teal',
    blurb: 'Deep teal carried across the whole product',
    swatches: ['#07231D', '#0C2E27', '#2ED3A6'],
  },
];

/** Canvas (page background) color per theme — mirrors --vf-paper in globals.css. */
export const THEME_CANVAS: Record<AppTheme, string> = {
  pearl: '#F4F1E9',
  midnight: '#060C11',
  deepteal: '#07231D',
};

export function isAppTheme(value: unknown): value is AppTheme {
  return value === 'pearl' || value === 'midnight' || value === 'deepteal';
}

/* The pre-paint init script itself lives in src/app/layout.tsx (a server
   component) and mirrors THEME_STORAGE_KEY + DEFAULT_THEME above. */function readDocumentTheme(): AppTheme {
  if (typeof document === 'undefined') return DEFAULT_THEME;
  const attr = document.documentElement.dataset.theme;
  return isAppTheme(attr) ? attr : DEFAULT_THEME;
}

const ThemeContext = createContext<{ theme: AppTheme; setTheme: (theme: AppTheme) => void }>({
  theme: DEFAULT_THEME,
  setTheme: () => undefined,
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  // The init script has already applied the theme to <html> before paint;
  // initial state just mirrors it (no re-application, no flash).
  const [theme, setThemeState] = useState<AppTheme>(readDocumentTheme);

  const setTheme = useCallback((next: AppTheme) => {
    setThemeState(next);
    document.documentElement.dataset.theme = next;
    document.documentElement.style.backgroundColor = THEME_CANVAS[next];
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Private mode / storage disabled: the choice still applies this session.
    }
  }, []);

  // If the attribute was somehow absent (script blocked), apply the default.
  useEffect(() => {
    if (!isAppTheme(document.documentElement.dataset.theme)) {
      document.documentElement.dataset.theme = theme;
    }
  }, [theme]);

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
