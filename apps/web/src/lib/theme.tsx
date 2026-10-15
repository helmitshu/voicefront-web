'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AuthApi } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

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
 * wrong theme. This provider mirrors that attribute into React state.
 *
 * Persistence is two-layered: localStorage is the instant-paint cache on
 * this device, and the account is the source of truth. On sign-in the
 * provider reconciles — a theme or calm choice saved to the account wins
 * and is written down into the device cache. Every change made in a picker
 * applies instantly, updates the cache, and is saved to the account in the
 * background (failures are silent; the device cache still holds the choice).
 *
 * Calm mode rides alongside: `data-calm="true"` on <html> stills the logo
 * and waveform animations (globals.css), persisted the same two ways under
 * its own storage key.
 */
export type AppTheme = 'pearl' | 'midnight' | 'deepteal';

export const THEME_STORAGE_KEY = 'vf-theme';
export const CALM_STORAGE_KEY = 'vf-calm';
export const DEFAULT_THEME: AppTheme = 'midnight';

export const THEMES: { key: AppTheme; label: string; blurb: string; swatches: [string, string, string] }[] = [
  {
    key: 'pearl',
    label: 'Pearl',
    blurb: 'The classic look, warm cream and deep teal',
    swatches: ['#F4F1E9', '#FFFFFF', '#0C7A66'],
  },
  {
    key: 'midnight',
    label: 'Midnight',
    blurb: 'Dark and futuristic, teal on deep ink',
    swatches: ['#060C11', '#0B161F', '#2DD4BF'],
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
   component) and mirrors THEME_STORAGE_KEY, CALM_STORAGE_KEY, and
   DEFAULT_THEME above. */
function readDocumentTheme(): AppTheme {
  if (typeof document === 'undefined') return DEFAULT_THEME;
  const attr = document.documentElement.dataset.theme;
  return isAppTheme(attr) ? attr : DEFAULT_THEME;
}

function readDocumentCalm(): boolean {
  if (typeof document === 'undefined') return false;
  return document.documentElement.dataset.calm === 'true';
}

function storeLocal(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private mode / storage disabled: the choice still applies this session.
  }
}

interface ThemeContextValue {
  theme: AppTheme;
  setTheme: (theme: AppTheme) => void;
  calm: boolean;
  setCalm: (calm: boolean) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: DEFAULT_THEME,
  setTheme: () => undefined,
  calm: false,
  setCalm: () => undefined,
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  // The init script has already applied the saved choices to <html> before
  // paint; initial state just mirrors it (no re-application, no flash).
  const [theme, setThemeState] = useState<AppTheme>(readDocumentTheme);
  const [calm, setCalmState] = useState<boolean>(readDocumentCalm);
  const themeRef = useRef(theme);
  const calmRef = useRef(calm);
  // Latest signed-in user, for the save guard (no save while signed out).
  const meRef = useRef(me);
  meRef.current = me;

  /* Local application only: state, <html> attributes, device cache. Shared
     by user changes and by account reconciliation. */
  const applyThemeLocal = useCallback((next: AppTheme) => {
    themeRef.current = next;
    setThemeState(next);
    document.documentElement.dataset.theme = next;
    document.documentElement.style.backgroundColor = THEME_CANVAS[next];
    storeLocal(THEME_STORAGE_KEY, next);
  }, []);

  const applyCalmLocal = useCallback((next: boolean) => {
    calmRef.current = next;
    setCalmState(next);
    if (next) {
      document.documentElement.dataset.calm = 'true';
    } else {
      delete document.documentElement.dataset.calm;
    }
    storeLocal(CALM_STORAGE_KEY, next ? '1' : '0');
  }, []);

  /* Background save to the account. Fire and forget: a failed save never
     surfaces, the device cache already holds the choice. Skipped entirely
     while signed out, so it can never fire an unauthenticated request. */
  const savePreferences = useCallback((input: { theme?: AppTheme; calmMode?: boolean }) => {
    if (!meRef.current) return;
    AuthApi.updatePreferences(input).catch(() => undefined);
  }, []);

  const setTheme = useCallback(
    (next: AppTheme) => {
      applyThemeLocal(next);
      savePreferences({ theme: next });
    },
    [applyThemeLocal, savePreferences],
  );

  const setCalm = useCallback(
    (next: boolean) => {
      applyCalmLocal(next);
      savePreferences({ calmMode: next });
    },
    [applyCalmLocal, savePreferences],
  );

  // If the attribute was somehow absent (script blocked), apply the default.
  useEffect(() => {
    if (!isAppTheme(document.documentElement.dataset.theme)) {
      document.documentElement.dataset.theme = theme;
    }
  }, [theme]);

  /* Account reconciliation, once per sign-in: choices saved to the account
     win over this device's cache and are written down into it. A null from
     the account means "never chosen", and the device choice stands. */
  const reconciledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!me || reconciledFor.current === me.user.id) return;
    reconciledFor.current = me.user.id;
    if (isAppTheme(me.user.theme) && me.user.theme !== themeRef.current) {
      applyThemeLocal(me.user.theme);
    }
    if (me.user.calmMode !== null && me.user.calmMode !== calmRef.current) {
      applyCalmLocal(me.user.calmMode);
    }
  }, [me, applyThemeLocal, applyCalmLocal]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, calm, setCalm }}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
