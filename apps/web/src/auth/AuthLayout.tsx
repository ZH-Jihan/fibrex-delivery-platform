/**
 * AuthLayout: the centred card around every sign-in screen, with the language and theme
 * switches so a user can change them before signing in. Used by: auth screens.
 */
import { Monitor, Moon, Sun } from 'lucide-react';
import type { ReactNode } from 'react';
import { LANGUAGES, isLanguage, useI18n } from '../i18n';
import { useTheme } from '../theme/theme';
import { Button } from '../ui/components';

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
          <div className="segmented" role="group" aria-label={t('shell.theme')}>
            {(
              [
                ['system', Monitor, t('shell.theme.system')],
                ['light', Sun, t('shell.theme.light')],
                ['dark', Moon, t('shell.theme.dark')],
              ] as const
            ).map(([value, Icon, label]) => (
              <Button
                key={value}
                iconOnly
                icon={Icon}
                aria-label={label}
                aria-pressed={theme === value}
                onClick={() => {
                  setTheme(value);
                }}
              />
            ))}
          </div>
        </div>
        <img className="auth-logo" src="/fibrex-logo.jpeg" alt={t('app.name')} />
        <div className="card">
          <h1>{title}</h1>
          {children}
        </div>
      </div>
    </main>
  );
}
