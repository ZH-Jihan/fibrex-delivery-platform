/**
 * BottomTabs: the mobile tab bar with the four most used screens (nav.ts decides which,
 * from the entries the user may open). Fixed to the bottom edge, above the safe area.
 * Depends on: nav, i18n. Used by: shell/AppShell.tsx (mobile only).
 */
import { Hash } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { useI18n } from '../i18n';
import type { NavItem } from './nav';

export function BottomTabs({ tabs }: { tabs: readonly NavItem[] }) {
  const { t } = useI18n();
  if (tabs.length === 0) return null;
  return (
    <nav className="tabbar" aria-label={t('shell.tabs')}>
      {tabs.map((item) => {
        const Icon = item.icon ?? Hash;
        return (
          <NavLink key={item.to} className="tabbar-link" to={item.to} end={item.to === '/'}>
            <Icon aria-hidden />
            <span>{t(item.label)}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}
