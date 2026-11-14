/**
 * Translation layer (no library): language state, `t()` with {name} merge fields and
 * English fallback, and page direction. Urdu is right-to-left; Arabic is not translated at
 * launch, but listing it as `rtl` here is all it needs later (DECISIONS 2026-11-13).
 * The chosen language is a per-browser convenience kept in localStorage (read in try/catch).
 * Depends on: ./en and the other language files. Used by: every screen.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { bn } from './bn';
import { en, type MessageKey, type Messages } from './en';
import { hi } from './hi';
import { ne } from './ne';
import { ur } from './ur';

export type Language = 'en' | 'bn' | 'ur' | 'hi' | 'ne';

export const LANGUAGES: readonly { code: Language; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'bn', label: 'বাংলা' },
  { code: 'ur', label: 'اردو' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'ne', label: 'नेपाली' },
];

const RTL: readonly string[] = ['ur', 'ar'];
const tables: Record<Language, Messages> = { en, bn, ur, hi, ne };
const STORAGE_KEY = 'fibrex.language';

export function isLanguage(value: string | null | undefined): value is Language {
  return LANGUAGES.some((l) => l.code === value);
}
export function directionOf(language: string): 'rtl' | 'ltr' {
  return RTL.includes(language) ? 'rtl' : 'ltr';
}

/** Looks a key up in one language, falls back to English, then fills {merge} fields. */
export function translate(
  language: Language,
  key: MessageKey,
  values?: Record<string, string | number>,
): string {
  const text = tables[language][key] ?? en[key];
  if (values === undefined) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => String(values[name] ?? whole));
}

/**
 * Looks up a key that is built at run time (for example a permission key from the
 * database). Unlike `translate`, an unknown key is not an error: the caller's fallback
 * (the database text) is returned, so a new module shows readable text before anyone
 * translates it.
 */
export function translateOr(language: Language, key: string, fallback: string): string {
  const table: Record<string, string | undefined> = tables[language];
  const english: Record<string, string | undefined> = en;
  return table[key] ?? english[key] ?? fallback;
}

export type TFunction = (key: MessageKey, values?: Record<string, string | number>) => string;

interface I18n {
  language: Language;
  setLanguage: (language: Language) => void;
  t: TFunction;
  /** Translation for a run-time key, or `fallback` when none exists. */
  tOr: (key: string, fallback: string) => string;
}
const Context = createContext<I18n | null>(null);

function initialLanguage(): Language {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLanguage(saved)) return saved;
  } catch {
    // Storage can be blocked (private window); the page works without it.
  }
  return 'en';
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(initialLanguage);

  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = directionOf(language);
  }, [language]);

  const setLanguage = useCallback((next: Language) => {
    setLanguageState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Not saved; the choice still applies to this visit.
    }
  }, []);

  const value = useMemo<I18n>(
    () => ({
      language,
      setLanguage,
      t: (key, values) => translate(language, key, values),
      tOr: (key, fallback) => translateOr(language, key, fallback),
    }),
    [language, setLanguage],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(Context);
  if (ctx === null) throw new Error('useI18n needs an I18nProvider');
  return ctx;
}
