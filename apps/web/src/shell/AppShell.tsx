/**
 * AppShell: collapsible sidebar (grouped menu filtered by permission), top bar (language,
 * theme, company switcher, user menu) and the impersonation banner, around the page
 * content. The menu comes from a manifest (`nav.ts`) filtered by the shared `can()`.
 * The company switcher lists GET /me/companies and, on change, asks the API for a new
 * session in that company (a session never changes company; DECISIONS IAM 7c).
 * Impersonation: the access token carries an `imp` claim while an administrator acts as
 * someone else; it is read here only to SHOW the banner, never to decide access.
 * Depends on: auth, i18n, theme, nav. Used by: App.tsx.
 */
import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { api, getAccessToken } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { LANGUAGES, isLanguage, useI18n } from '../i18n';
import { useTheme } from '../theme/theme';
import { Button } from '../ui/components';
import { useToast } from '../ui/toast';
import { NAV } from './nav';
import type { NavGroup } from './nav';

interface CompanyChoice {
  id: string;
  name: string;
  isDefault: boolean;
  current: boolean;
}

/** True when the access token has the `imp` claim. Display only. */
function isImpersonating(token: string | null): boolean {
  if (token === null) return false;
  try {
    const payload = token.split('.')[1];
    if (payload === undefined) return false;
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return 'imp' in (JSON.parse(json) as Record<string, unknown>);
  } catch {
    return false;
  }
}

export function AppShell({ nav = NAV }: { nav?: readonly NavGroup[] }) {
  const { t, language, setLanguage } = useI18n();
  const { theme, setTheme } = useTheme();
  const auth = useAuth();
  const toast = useToast();
  const [collapsed, setCollapsed] = useState(false);
  const [companies, setCompanies] = useState<CompanyChoice[]>([]);

  const companyId = auth.grant?.companyId ?? null;
  useEffect(() => {
    let cancelled = false;
    api<{ items: CompanyChoice[] }>('/me/companies')
      .then((r) => {
        if (!cancelled) setCompanies(r.items);
      })
      .catch(() => {
        if (!cancelled) setCompanies([]);
      });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  // Keep only the entries the user may open, and drop groups left empty.
  const visible = nav
    .map((g) => ({ ...g, items: g.items.filter((i) => auth.can(i.permission)) }))
    .filter((g) => g.items.length > 0);

  const impersonating = isImpersonating(getAccessToken());

  return (
    <div className={collapsed ? 'shell collapsed' : 'shell'}>
      <nav className="sidebar" aria-label={t('shell.menu')}>
        <div className="brand">
          <img className="brand-logo" src="/fibrex-logo.jpeg" alt="" />
          <span>{t('app.name')}</span>
        </div>
        <NavLink className="nav-link" to="/" end>
          <span>{t('shell.home')}</span>
        </NavLink>
        {visible.map((group) => (
          <div key={group.label}>
            <div className="nav-group">{t(group.label)}</div>
            {group.items.map((item) => (
              <NavLink key={item.to} className="nav-link" to={item.to}>
                <span>{t(item.label)}</span>
              </NavLink>
            ))}
          </div>
        ))}
        <Button
          variant="link"
          aria-label={collapsed ? t('shell.expand') : t('shell.collapse')}
          onClick={() => {
            setCollapsed(!collapsed);
          }}
        >
          {collapsed ? '»' : '«'}
        </Button>
      </nav>
      <div className="main">
        {impersonating ? (
          <div className="banner" role="status">
            {t('shell.impersonating', { name: auth.grant?.user.displayName ?? '' })}
          </div>
        ) : null}
        <header className="topbar">
          <span className="spacer" />
          {companies.length > 1 ? (
            <select
              aria-label={t('shell.company')}
              value={companyId ?? ''}
              onChange={(e) => {
                auth.switchCompany(e.target.value).catch(() => {
                  toast.show(t('error.unknown'), 'error');
                });
              }}
            >
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          ) : null}
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
          <span aria-label={t('shell.userMenu')}>{auth.grant?.user.displayName}</span>
          <Button onClick={() => void auth.logout()}>{t('auth.signOut')}</Button>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
