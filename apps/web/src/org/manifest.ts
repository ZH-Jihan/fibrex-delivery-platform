/**
 * Menu entries of the organisation screens (company, branches, numbering sequences).
 * Depends on: shell/manifest.ts, lucide-react. Used by: shell/nav.ts.
 */
import { Blocks, Boxes, Building2, Hash, ListTree, MapPin } from 'lucide-react';
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
        {
          to: '/organisation/numbering',
          label: 'nav.numbering',
          permission: 'platform.number_sequence.read',
          icon: Hash,
        },
        {
          to: '/organisation/lookups',
          label: 'nav.lookups',
          permission: 'platform.lookup_type.read',
          icon: ListTree,
        },
        {
          to: '/records',
          label: 'nav.records',
          permission: 'platform.entity_definition.read',
          icon: Boxes,
        },
        {
          to: '/organisation/record-types',
          label: 'nav.recordTypes',
          permission: 'platform.entity_definition.read',
          icon: Blocks,
        },
      ],
    },
  ],
};
