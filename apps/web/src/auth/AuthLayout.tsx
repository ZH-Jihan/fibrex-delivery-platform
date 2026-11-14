/**
 * AuthLayout: the centred card around every sign-in screen, with the language and theme
 * switches so a user can change them before signing in. Used by: auth screens.
 */
import type { ReactNode } from 'react';
import { LANGUAGES, isLanguage, useI18n } from '../i18n';
import { useTheme } from '../theme/theme';

export function AuthLayout({ title, children }: { title: string; children: ReactNode }) {
  const { t, language, setLanguage } = useI18n();
  const { theme, setTheme } = useTheme();
  return (
    <main className="auth-page">
      <div className="auth-card">
        <div className="auth-tools">
          <select
            aria-label={t('shell.language')}
            value={language}
            onChange={(e) => {
              if (isLanguage(e.target.value)) setLanguage(e.target.value);
            }}
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
          <select
            aria-label={t('shell.theme')}
            value={theme}
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'light' || v === 'dark' || v === 'system') setTheme(v);
            }}
          >
            <option value="system">{t('shell.theme.system')}</option>
            <option value="light">{t('shell.theme.light')}</option>
            <option value="dark">{t('shell.theme.dark')}</option>
          </select>
        </div>
        <div className="card">
          <h1>{title}</h1>
          {children}
        </div>
      </div>
    </main>
  );
}
