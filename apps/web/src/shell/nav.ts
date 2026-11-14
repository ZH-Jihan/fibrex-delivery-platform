/**
 * Navigation manifest: which menu entries exist and which permission shows each one.
 * Purpose: the sidebar is built from this list filtered by `can()`, so a user only sees
 * screens they may open (the API still refuses anything else). Each later module adds its
 * own entries here (or, from Phase 2, from its module manifest). Entries whose screens
 * arrive in commit 12 are listed there, not here, so no link ever leads to a dead page.
 * Depends on: i18n keys. Used by: shell/AppShell.tsx.
 */
import type { MessageKey } from '../i18n/en';

export interface NavItem {
  /** Route path. */
  to: string;
  label: MessageKey;
  /** Permission key needed to see the entry. */
  permission: string;
}
export interface NavGroup {
  label: MessageKey;
  items: readonly NavItem[];
}

export const NAV: readonly NavGroup[] = [];
