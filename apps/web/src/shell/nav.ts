/**
 * Navigation: the menu the sidebar, the mobile drawer, the bottom tab bar, the Ctrl+K
 * palette and the Home tiles are built from, filtered by `can()` so a user only sees
 * screens they may open (the API still refuses anything else).
 *
 * Since Phase 2 the entries come from the feature manifests listed in `WEB_MODULES`
 * (SPEC 2.13): a new module adds its `manifest.ts` and one line here, nothing else.
 * Depends on: shell/manifest.ts and the feature manifests. Used by: shell/*.
 */
import { House } from 'lucide-react';
import { adminManifest } from '../admin/manifest';
import { auditManifest } from '../audit/manifest';
import { orgManifest } from '../org/manifest';
import { peopleManifest } from '../people/manifest';
import { reportsManifest } from '../reports/manifest';
import { buildNav, type NavGroup, type NavItem, type WebModuleManifest } from './manifest';

export type { NavGroup, NavItem } from './manifest';

/** The Home entry, shown to everyone above the groups. */
export const HOME: NavItem = { to: '/', label: 'shell.home', permission: '', icon: House };

/** Every feature manifest, in menu order. */
export const WEB_MODULES: readonly WebModuleManifest[] = [
  adminManifest,
  auditManifest,
  orgManifest,
  peopleManifest,
  reportsManifest,
];

export const NAV: readonly NavGroup[] = buildNav(WEB_MODULES);

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
  return (
    nav
      // An empty permission means "every signed-in user" (the task inbox).
      .map((g) => ({
        ...g,
        items: g.items.filter((i) => i.permission === '' || can(i.permission)),
      }))
      .filter((g) => g.items.length > 0)
  );
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
