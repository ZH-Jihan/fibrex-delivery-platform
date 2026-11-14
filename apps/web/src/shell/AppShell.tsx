/**
 * AppShell: the responsive frame around every page.
 *   desktop (1280 px and up)  full sidebar with icon + label, collapsible (remembered per browser)
 *   tablet  (768–1279 px)     icon rail with tooltips; expands on hover (CSS) or stays open with the toggle
 *   mobile  (below 768 px)    top bar with logo and hamburger; the menu is a slide-in drawer
 *                             (native <dialog>: focus trapped, Escape closes; closed on every
 *                             route change) plus a bottom tab bar with the four most used screens
 * Top bar: Ctrl+K search, notification bell, company switcher (desktop), language and theme
 * (desktop; inside the avatar menu on mobile), avatar menu with My account and Sign out.
 * The company switcher lists GET /me/companies and, on change, asks the API for a new
 * session in that company (a session never changes company; DECISIONS IAM 7c).
 * Impersonation: the access token carries an `imp` claim while an administrator acts as
 * someone else; it is read here only to SHOW the banner, never to decide access.
 * Depends on: auth, i18n, theme, nav, Sidebar, BottomTabs, UserMenu, ui/Modal. Used by: App.tsx.
 */
import { useEffect, useState } from 'react';
import { Menu as MenuIcon, Monitor, Moon, Sun, UserRoundCog } from 'lucide-react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { api, getAccessToken } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { LANGUAGES, isLanguage, useI18n } from '../i18n';
import { useTheme } from '../theme/theme';
import { useBreakpoint } from '../theme/useBreakpoint';
import { Button, Select } from '../ui/components';
import { Modal } from '../ui/Modal';
import { useToast } from '../ui/toast';
import { BottomTabs } from './BottomTabs';
import { CommandPalette } from './CommandPalette';
import { NotificationBell } from './NotificationBell';
import { NAV, filterNav, mobileTabs } from './nav';
import type { NavGroup } from './nav';
import { Sidebar } from './Sidebar';
import { UserMenu } from './UserMenu';

interface CompanyChoice {
  id: string;
  name: string;
  isDefault: boolean;
  current: boolean;
}

const COLLAPSE_KEY = 'fibrex.sidebar';

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

function savedCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === 'collapsed';
  } catch {
    return false;
  }
}

export function AppShell({ nav = NAV }: { nav?: readonly NavGroup[] }) {
  const { t, language, setLanguage } = useI18n();
  const { theme, setTheme } = useTheme();
  const auth = useAuth();
  const toast = useToast();
  const bp = useBreakpoint();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(savedCollapsed);
  const [railPinned, setRailPinned] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
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

  // The drawer never outlives the page it was opened on.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSE_KEY, next ? 'collapsed' : 'open');
    } catch {
      // Not remembered; applies to this visit only.
    }
  };

  // Keep only the entries the user may open, and drop groups left empty.
  const visible = filterNav(nav, auth.can);
  const impersonating = isImpersonating(getAccessToken());
  const mobile = bp === 'mobile';

  const companySwitcher =
    companies.length > 1 ? (
      <Select
        label={t('shell.company')}
        value={companyId ?? ''}
        options={companies.map((c) => ({ value: c.id, label: c.name }))}
        onChange={(e) => {
          auth.switchCompany(e.target.value).catch(() => {
            toast.show(t('error.unknown'), 'error');
          });
        }}
      />
    ) : null;

  const sidebarMode =
    bp === 'desktop' ? (collapsed ? 'collapsed' : 'full') : railPinned ? 'full' : 'rail';

  return (
    <div
      className="shell"
      data-bp={bp}
      data-collapsed={bp === 'desktop' && collapsed}
      data-rail-open={bp === 'tablet' && railPinned}
    >
      {mobile ? null : (
        <Sidebar
          groups={visible}
          mode={sidebarMode}
          onToggle={
            bp === 'desktop'
              ? toggleCollapsed
              : () => {
                  setRailPinned(!railPinned);
                }
          }
        />
      )}
      <div className="main">
        {impersonating ? (
          <div className="banner" role="status">
            <UserRoundCog aria-hidden />
            {t('shell.impersonating', { name: auth.grant?.user.displayName ?? '' })}
          </div>
        ) : null}
        <header className="topbar">
          {mobile ? (
            <>
              <Button
                variant="ghost"
                iconOnly
                icon={MenuIcon}
                aria-label={t('shell.openMenu')}
                aria-expanded={drawerOpen}
                onClick={() => {
                  setDrawerOpen(true);
                }}
              />
              <NavLink className="brand topbar-brand" to="/" aria-label={t('app.name')}>
                <img className="brand-logo" src="/fibrex-logo.jpeg" alt="" />
                <span className="brand-name">{t('app.name')}</span>
              </NavLink>
            </>
          ) : null}
          <CommandPalette entries={visible.flatMap((g) => g.items)} compact={mobile} />
          <span className="spacer" />
          {!mobile && companies.length > 1 ? (
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
          {mobile ? null : (
            <>
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
            </>
          )}
          <NotificationBell />
          <UserMenu compact={mobile} />
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
      {mobile ? (
        <>
          <Modal
            variant="drawer"
            open={drawerOpen}
            onClose={() => {
              setDrawerOpen(false);
            }}
            aria-label={t('shell.menu')}
          >
            <Sidebar
              groups={visible}
              mode="drawer"
              onClose={() => {
                setDrawerOpen(false);
              }}
              footer={companySwitcher}
            />
          </Modal>
          <BottomTabs tabs={mobileTabs(visible)} />
        </>
      ) : null}
    </div>
  );
}
