/**
 * Menu entries of the party module (People). Mirrors the API manifest in
 * apps/api/src/modules/party/index.ts (same path and permission key).
 * Depends on: shell/manifest.ts, lucide-react. Used by: shell/nav.ts.
 */
import { Contact, IdCard } from 'lucide-react';
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
      ],
    },
  ],
};
