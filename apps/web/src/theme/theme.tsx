/**
 * Theme choice: light, dark or follow the system. Sets data-theme on <html> (the CSS
 * tokens in styles.css react to it); "system" removes the attribute. The choice is a
 * per-browser convenience kept in localStorage, read and written inside try/catch.
 * Depends on: react. Used by: shell/TopBar.tsx, auth screens.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

export type ThemeChoice = 'light' | 'dark' | 'system';
const STORAGE_KEY = 'fibrex.theme';

function initial(): ThemeChoice {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
  } catch {
    // Storage blocked: use the system setting.
  }
  return 'system';
}

interface ThemeApi {
  theme: ThemeChoice;
  setTheme: (theme: ThemeChoice) => void;
}
const Context = createContext<ThemeApi | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeChoice>(initial);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
  }, [theme]);

  const setTheme = useCallback((next: ThemeChoice) => {
    setThemeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Not saved; applies to this visit only.
    }
  }, []);

  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useTheme(): ThemeApi {
  const ctx = useContext(Context);
  if (ctx === null) throw new Error('useTheme needs a ThemeProvider');
  return ctx;
}
