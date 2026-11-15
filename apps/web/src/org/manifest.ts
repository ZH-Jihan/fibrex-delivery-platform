/**
 * Menu entries of the organisation screens (company, branches).
 * Depends on: shell/manifest.ts, lucide-react. Used by: shell/nav.ts.
 */
import { Building2, MapPin } from 'lucide-react';
import type { WebModuleManifest } from '../shell/manifest';

export const orgManifest: WebModuleManifest = {
  key: 'platform',
  nav: [
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
  ],
};
