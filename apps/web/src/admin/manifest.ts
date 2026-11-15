/**
 * Menu entries of the IAM administration screens (users, roles, permission matrix).
 * Depends on: shell/manifest.ts, lucide-react. Used by: shell/nav.ts.
 */
import { LayoutGrid, ShieldCheck, Users } from 'lucide-react';
import type { WebModuleManifest } from '../shell/manifest';

export const adminManifest: WebModuleManifest = {
  key: 'iam',
  nav: [
    {
      label: 'nav.admin',
      items: [
        { to: '/users', label: 'nav.users', permission: 'iam.user.read', icon: Users },
        { to: '/roles', label: 'nav.roles', permission: 'iam.role.read', icon: ShieldCheck },
        {
          to: '/permission-matrix',
          label: 'nav.matrix',
          permission: 'iam.permission_matrix.read',
          icon: LayoutGrid,
        },
      ],
    },
  ],
};
