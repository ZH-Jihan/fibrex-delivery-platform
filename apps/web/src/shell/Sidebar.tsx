/**
 * Sidebar: brand, the grouped menu (already filtered by permission) and a collapse/pin
 * toggle. The same markup serves three places: the desktop sidebar (full or collapsed), the
 * tablet icon rail (expands on hover or when pinned) and the mobile drawer. Labels are
 * hidden by CSS (`--labels`) rather than removed, so a hover can reveal them without a
 * re-render; while they are hidden every link carries a tooltip (`data-tip`, and `title`
 * for the native one).
 * Depends on: nav, i18n, ui/components. Used by: shell/AppShell.tsx.
 */
import { ChevronsLeft, ChevronsRight, Hash, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useI18n } from '../i18n';
import { Button } from '../ui/components';
import { HOME } from './nav';
import type { NavGroup, NavItem } from './nav';

export type SidebarMode = 'full' | 'collapsed' | 'rail' | 'drawer';

interface Props {
  groups: readonly NavGroup[];
  mode: SidebarMode;
  /** Collapse (desktop) or pin (tablet) toggle; absent in the drawer. */
  onToggle?: () => void;
  /** Close button for the drawer. */
  onClose?: () => void;
  /** Extra content at the bottom (company switcher in the drawer). */
  footer?: ReactNode;
}

export function Sidebar({ groups, mode, onToggle, onClose, footer }: Props) {
  const { t } = useI18n();
  const labelsHidden = mode === 'collapsed' || mode === 'rail';

  const link = (item: NavItem, end = false) => {
    const Icon = item.icon ?? Hash;
    const label = t(item.label);
    return (
      <NavLink
        key={item.to}
        className="nav-link"
        to={item.to}
        end={end}
        {...(labelsHidden ? { 'data-tip': label, title: label } : {})}
      >
        <Icon aria-hidden />
        <span>{label}</span>
      </NavLink>
    );
  };

  return (
    <nav className="sidebar" aria-label={t('shell.menu')} data-mode={mode}>
      <div className="sidebar-inner">
        <div className="sidebar-top">
          <NavLink className="brand" to="/" aria-label={t('app.name')}>
            <img className="brand-logo" src="/fibrex-logo.jpeg" alt="" />
            <span className="brand-name">{t('app.name')}</span>
          </NavLink>
          {onToggle ? (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              className="sidebar-toggle"
              icon={mode === 'full' ? ChevronsLeft : ChevronsRight}
              aria-label={
                mode === 'rail'
                  ? t('shell.pinMenu')
                  : mode === 'collapsed'
                    ? t('shell.expand')
                    : t('shell.collapse')
              }
              aria-pressed={mode !== 'full' ? undefined : true}
              onClick={onToggle}
            />
          ) : null}
          {onClose ? (
            <Button
              variant="ghost"
              iconOnly
              icon={X}
              aria-label={t('shell.closeMenu')}
              onClick={onClose}
            />
          ) : null}
        </div>
        <div className="sidebar-nav">
          {link(HOME, true)}
          {groups.map((group) => (
            <div key={group.label}>
              <div className="nav-group">{t(group.label)}</div>
              <div className="nav-group-sep" />
              {group.items.map((item) => link(item))}
            </div>
          ))}
        </div>
        {footer ? <div className="sidebar-bottom">{footer}</div> : null}
      </div>
    </nav>
  );
}
