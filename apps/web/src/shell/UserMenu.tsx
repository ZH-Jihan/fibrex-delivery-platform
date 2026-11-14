/**
 * UserMenu: the avatar button in the top bar and its dropdown. Everywhere it offers
 * "My account" and "Sign out"; on a phone it also holds the language and theme choices,
 * which the desktop top bar shows as their own controls (so the small top bar keeps only
 * the bell and this menu, as the design asks).
 * Depends on: auth, i18n, theme, ui/Menu. Used by: shell/AppShell.tsx.
 */
import { Languages, LogOut, Monitor, Moon, Sun, UserRound } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { LANGUAGES, useI18n } from '../i18n';
import { useTheme } from '../theme/theme';
import type { ThemeChoice } from '../theme/theme';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '../ui/Menu';

/** Up to two initials from a display name, for the avatar. */
export function initialsOf(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter((p) => p !== '');
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase() || '?';
}

const THEMES: readonly {
  value: ThemeChoice;
  icon: typeof Sun;
  label: 'shell.theme.system' | 'shell.theme.light' | 'shell.theme.dark';
}[] = [
  { value: 'system', icon: Monitor, label: 'shell.theme.system' },
  { value: 'light', icon: Sun, label: 'shell.theme.light' },
  { value: 'dark', icon: Moon, label: 'shell.theme.dark' },
];

export function UserMenu({ compact }: { compact: boolean }) {
  const { t, language, setLanguage } = useI18n();
  const { theme, setTheme } = useTheme();
  const auth = useAuth();
  const navigate = useNavigate();
  const name = auth.grant?.user.displayName ?? '';
  const username = auth.grant?.user.username ?? '';

  return (
    <Menu
      className="user-menu"
      trigger={(props) => (
        <button
          type="button"
          className="btn btn-ghost avatar-btn"
          aria-label={t('shell.userMenu')}
          {...props}
        >
          <span className="avatar" aria-hidden>
            {initialsOf(name)}
          </span>
        </button>
      )}
    >
      <div className="menu-head">
        <strong>{name}</strong>
        {username}
      </div>
      <MenuSeparator />
      <MenuItem
        icon={UserRound}
        onClick={() => {
          void navigate('/me');
        }}
      >
        {t('me.title')}
      </MenuItem>
      {compact ? (
        <>
          <MenuSeparator />
          <MenuLabel>{t('shell.language')}</MenuLabel>
          {LANGUAGES.map((l) => (
            <MenuItem
              key={l.code}
              icon={Languages}
              checked={language === l.code}
              data-keep-open
              onClick={() => {
                setLanguage(l.code);
              }}
            >
              {l.label}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuLabel>{t('shell.theme')}</MenuLabel>
          {THEMES.map((th) => (
            <MenuItem
              key={th.value}
              icon={th.icon}
              checked={theme === th.value}
              data-keep-open
              onClick={() => {
                setTheme(th.value);
              }}
            >
              {t(th.label)}
            </MenuItem>
          ))}
        </>
      ) : null}
      <MenuSeparator />
      <MenuItem icon={LogOut} onClick={() => void auth.logout()}>
        {t('auth.signOut')}
      </MenuItem>
    </Menu>
  );
}
