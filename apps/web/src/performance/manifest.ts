/**
 * Menu entries of the performance module (phase 4 row 4.4: Sync sources and Google
 * connection). Mirrors the API manifest in apps/api/src/modules/performance/index.ts (same
 * permission keys). Row 4.5a adds Sync runs; 4.5b the Unmatched riders queue; 4.6a the three performance
 * reports (permission `performance.report.view`).
 * Depends on: shell/manifest.ts, lucide-react. Used by: shell/nav.ts.
 */
import {
  BarChart3,
  CalendarRange,
  History,
  PlugZap,
  RefreshCw,
  Trophy,
  UserRoundSearch,
} from 'lucide-react';
import type { WebModuleManifest } from '../shell/manifest';

export const performanceManifest: WebModuleManifest = {
  key: 'performance',
  nav: [
    {
      label: 'nav.performance.group',
      items: [
        {
          to: '/performance/reports/daily',
          label: 'nav.perfDaily',
          permission: 'performance.report.view',
          icon: BarChart3,
        },
        {
          to: '/performance/reports/cycle',
          label: 'nav.perfCycle',
          permission: 'performance.report.view',
          icon: CalendarRange,
        },
        {
          to: '/performance/reports/top-bottom',
          label: 'nav.perfTopBottom',
          permission: 'performance.report.view',
          icon: Trophy,
        },
        {
          to: '/performance/sync-sources',
          label: 'nav.syncSources',
          permission: 'performance.sync_source.read',
          icon: RefreshCw,
        },
        {
          to: '/performance/sync-runs',
          label: 'nav.syncRuns',
          permission: 'performance.sync_run.read',
          icon: History,
        },
        {
          to: '/performance/unmatched',
          label: 'nav.unmatched',
          permission: 'performance.unmatched.read',
          icon: UserRoundSearch,
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
