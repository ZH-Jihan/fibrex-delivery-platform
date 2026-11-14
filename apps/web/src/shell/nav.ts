/**
 * Navigation manifest: which menu entries exist, which permission shows each one, and
 * which icon it gets. Purpose: the sidebar, the mobile drawer, the bottom tab bar, the
 * Ctrl+K palette and the Home tiles are all built from this list filtered by `can()`, so a
 * user only sees screens they may open (the API still refuses anything else). Each later
 * module adds its own entries here (or, from Phase 2, from its module manifest).
 * Depends on: i18n keys, lucide-react. Used by: shell/*.
 */
import {
  Building2,
  Contact,
  House,
  LayoutGrid,
  MapPin,
  ScrollText,
  ShieldCheck,
  Trash2,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { MessageKey } from '../i18n/en';

export interface NavItem {
  /** Route path. */
  to: string;
  label: MessageKey;
  /** Permission key needed to see the entry. */
  permission: string;
  /** Menu icon; a generic one is used when missing (tests). */
  icon?: LucideIcon;
}
export interface NavGroup {
  label: MessageKey;
  items: readonly NavItem[];
}

/** The Home entry, shown to everyone above the groups. */
export const HOME: NavItem = { to: '/', label: 'shell.home', permission: '', icon: House };

export const NAV: readonly NavGroup[] = [
  {
    label: 'nav.admin',
    items: [
      { to: '/users', label: 'nav.users', permission: 'iam.user.read', icon: Users },
      { to: '/roles', label: 'nav.roles', permission: 'iam.role.read', icon: ShieldCheck },
      {
        to: '/permission-matrix',
        label: 'nav.matrix',
        permission: 'iam.permission_matrix.read',
        icon: LayoutGrid,
      },
      { to: '/audit', label: 'nav.audit', permission: 'audit.log.read', icon: ScrollText },
      { to: '/recycle-bin', label: 'nav.bin', permission: 'recycle_bin.view', icon: Trash2 },
    ],
  },
  {
    label: 'nav.org',
    items: [
      {
        to: '/organisation/company',
        label: 'nav.company',
        permission: 'platform.company.read',
        icon: Building2,
      },
      {
        to: '/organisation/branches',
        label: 'nav.branches',
        permission: 'platform.branch.read',
        icon: MapPin,
      },
    ],
  },
  {
    label: 'nav.people.group',
    items: [{ to: '/people', label: 'nav.people', permission: 'party.party.read', icon: Contact }],
  },
];

/** The four most used screens, in order, for the mobile bottom tab bar. */
export const MOBILE_TAB_PATHS: readonly string[] = [
  '/',
  '/users',
  '/people',
  '/organisation/branches',
];
export const MOBILE_TAB_COUNT = 4;

/** Keeps only the entries `can` allows, and drops groups left empty. Used by the sidebar and Home. */
export function filterNav(
  nav: readonly NavGroup[],
  can: (permission: string) => boolean,
): NavGroup[] {
  return nav
    .map((g) => ({ ...g, items: g.items.filter((i) => can(i.permission)) }))
    .filter((g) => g.items.length > 0);
}

/**
 * The bottom tab bar: the preferred screens the user may open, topped up with the next
 * visible entries so the bar always has up to four tabs.
 */
export function mobileTabs(visible: readonly NavGroup[]): NavItem[] {
  const all = [HOME, ...visible.flatMap((g) => g.items)];
  const preferred = MOBILE_TAB_PATHS.map((p) => all.find((i) => i.to === p)).filter(
    (i): i is NavItem => i !== undefined,
  );
  const rest = all.filter((i) => !preferred.includes(i));
  return [...preferred, ...rest].slice(0, MOBILE_TAB_COUNT);
}
