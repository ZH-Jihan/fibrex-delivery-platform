/**
 * Menu entries of the audit screens (audit log, recycle bin), shown in Administration.
 * Depends on: shell/manifest.ts, lucide-react. Used by: shell/nav.ts.
 */
import { ScrollText, Trash2 } from 'lucide-react';
import type { WebModuleManifest } from '../shell/manifest';

export const auditManifest: WebModuleManifest = {
  key: 'audit',
  nav: [
    {
      label: 'nav.admin',
      items: [
        { to: '/audit', label: 'nav.audit', permission: 'audit.log.read', icon: ScrollText },
        { to: '/recycle-bin', label: 'nav.bin', permission: 'recycle_bin.view', icon: Trash2 },
      ],
    },
  ],
};
