/**
 * Menu entries of the party module (People). Mirrors the API manifest in
 * apps/api/src/modules/party/index.ts (same path and permission key).
 * Depends on: shell/manifest.ts, lucide-react. Used by: shell/nav.ts.
 */
import { BellRing, Contact, IdCard, ScanLine, TimerReset } from 'lucide-react';
import type { WebModuleManifest } from '../shell/manifest';

export const peopleManifest: WebModuleManifest = {
  key: 'party',
  nav: [
    {
      label: 'nav.people.group',
      items: [
        { to: '/people', label: 'nav.people', permission: 'party.party.read', icon: Contact },
        {
          to: '/employees',
          label: 'nav.employees',
          permission: 'people.employee.read',
          icon: IdCard,
        },
        {
          to: '/documents/expiring',
          label: 'nav.expiring',
          permission: 'people.document.read',
          icon: TimerReset,
        },
        {
          to: '/documents/bulk',
          label: 'nav.bulkUpload',
          permission: 'people.bulk_upload.read',
          icon: ScanLine,
        },
        {
          to: '/documents/expiry-settings',
          label: 'nav.expirySettings',
          permission: 'people.expiry_settings.read',
          icon: BellRing,
        },
      ],
    },
  ],
};
