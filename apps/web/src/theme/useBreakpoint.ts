/**
 * useBreakpoint: which of the three layouts the viewport gets. The thresholds match the
 * media queries in styles.css, so the CSS and the React tree always agree on what is shown:
 *   mobile  (below 768 px)   no sidebar; top bar, slide-in drawer, bottom tab bar; table rows as cards
 *   tablet  (768–1279 px)    icon rail that expands on hover or toggle
 *   desktop (1280 px and up) full sidebar, collapsible
 * Without matchMedia (jsdom, server) it reports "desktop".
 * Depends on: react. Used by: shell/AppShell.tsx, ui/DataTable.tsx.
 */
import { useSyncExternalStore } from 'react';

export type Breakpoint = 'mobile' | 'tablet' | 'desktop';

export const MOBILE_MAX_PX = 767;
export const TABLET_MAX_PX = 1279;
const MOBILE_QUERY = `(max-width: ${String(MOBILE_MAX_PX)}px)`;
const TABLET_QUERY = `(max-width: ${String(TABLET_MAX_PX)}px)`;

function hasMatchMedia(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}

export function readBreakpoint(): Breakpoint {
  if (!hasMatchMedia()) return 'desktop';
  if (window.matchMedia(MOBILE_QUERY).matches) return 'mobile';
  if (window.matchMedia(TABLET_QUERY).matches) return 'tablet';
  return 'desktop';
}

function subscribe(onChange: () => void): () => void {
  if (!hasMatchMedia()) return () => undefined;
  const lists = [window.matchMedia(MOBILE_QUERY), window.matchMedia(TABLET_QUERY)];
  for (const list of lists) list.addEventListener('change', onChange);
  return () => {
    for (const list of lists) list.removeEventListener('change', onChange);
  };
}

export function useBreakpoint(): Breakpoint {
  return useSyncExternalStore(subscribe, readBreakpoint, () => 'desktop');
}
