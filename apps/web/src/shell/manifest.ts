/**
 * Web module manifest (SPEC 2.13, the browser half of the API's module registry).
 * Purpose: each feature folder (admin, audit, org, people, later every Phase 2+ module)
 * declares its menu entries once; `buildNav` merges them into the groups the shell shows.
 * The API's `GET /modules` carries the same paths and permission keys; the web keeps the
 * icons and translations because those cannot travel as data.
 * Depends on: i18n keys, lucide-react types. Used by: shell/nav.ts, every feature manifest.
 */
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

export interface WebModuleManifest {
  /** Same key as the API manifest (`party`), or the kernel area (`iam`, `audit`). */
  key: string;
  /** Menu groups; groups with the same label from different manifests are merged. */
  nav: readonly NavGroup[];
}

/**
 * One menu from many manifests: groups keep the order of first appearance, and a group
 * declared by two manifests (Administration from `iam` and `audit`) lists the first
 * manifest's items first.
 */
export function buildNav(manifests: readonly WebModuleManifest[]): NavGroup[] {
  const groups = new Map<MessageKey, NavItem[]>();
  for (const manifest of manifests) {
    for (const group of manifest.nav) {
      const items = groups.get(group.label) ?? [];
      items.push(...group.items);
      groups.set(group.label, items);
    }
  }
  return [...groups.entries()].map(([label, items]) => ({ label, items }));
}
