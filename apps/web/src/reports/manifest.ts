/**
 * Menu entry of the report page (phase 2 row 2.13). The entry needs no permission: the page
 * lists only the reports the API allows, and says so when there are none.
 * Depends on: shell/manifest.ts, lucide-react. Used by: shell/nav.ts.
 */
import { BarChart3 } from 'lucide-react';
import type { WebModuleManifest } from '../shell/manifest';

export const reportsManifest: WebModuleManifest = {
  key: 'platform',
  nav: [
    {
      label: 'nav.reports',
      items: [{ to: '/reports', label: 'nav.reports', permission: '', icon: BarChart3 }],
    },
  ],
};
