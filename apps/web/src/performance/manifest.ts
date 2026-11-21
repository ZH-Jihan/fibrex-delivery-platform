/**
 * Menu entries of the performance module (phase 4 row 4.4: Sync sources and Google
 * connection). Mirrors the API manifest in apps/api/src/modules/performance/index.ts (same
 * permission keys). Row 4.5 adds platforms, runs and the unmatched queue.
 * Depends on: shell/manifest.ts, lucide-react. Used by: shell/nav.ts.
 */
import { PlugZap, RefreshCw } from 'lucide-react';
import type { WebModuleManifest } from '../shell/manifest';

export const performanceManifest: WebModuleManifest = {
  key: 'performance',
  nav: [
    {
      label: 'nav.performance.group',
      items: [
        {
          to: '/performance/sync-sources',
          label: 'nav.syncSources',
          permission: 'performance.sync_source.read',
          icon: RefreshCw,
        },
        {
          to: '/settings/google-connection',
          label: 'nav.googleConnection',
          permission: 'performance.google_connection.manage',
          icon: PlugZap,
        },
      ],
    },
  ],
};
