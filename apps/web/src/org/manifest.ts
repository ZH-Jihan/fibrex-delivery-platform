/**
 * Menu entries of the organisation screens (company, branches, numbering sequences).
 * Depends on: shell/manifest.ts, lucide-react. Used by: shell/nav.ts.
 */
import {
  ArrowLeftRight,
  Blocks,
  Boxes,
  Building2,
  FileText,
  GitBranch,
  Hash,
  Inbox,
  ListTree,
  MapPin,
  Sigma,
  Table2,
  Workflow,
} from 'lucide-react';
import type { WebModuleManifest } from '../shell/manifest';

export const orgManifest: WebModuleManifest = {
  key: 'platform',
  nav: [
    {
      // The inbox lists only tasks given to the user, so the menu entry needs no permission.
      label: 'nav.work',
      items: [{ to: '/tasks', label: 'nav.inbox', permission: '', icon: Inbox }],
    },
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
          to: '/organisation/templates',
          label: 'nav.templates',
          permission: 'platform.template.read',
          icon: FileText,
        },
        {
          to: '/organisation/formulas',
          label: 'nav.formulas',
          permission: 'platform.formula.read',
          icon: Sigma,
        },
        {
          to: '/organisation/rate-tables',
          label: 'nav.rates',
          permission: 'platform.rate_table.read',
          icon: Table2,
        },
        {
          to: '/organisation/state-machines',
          label: 'nav.states',
          permission: 'platform.state_machine.read',
          icon: Workflow,
        },
        {
          to: '/organisation/workflows',
          label: 'nav.workflows',
          permission: 'platform.workflow_definition.read',
          icon: GitBranch,
        },
        {
          to: '/data',
          label: 'nav.data',
          permission: 'integration.import_job.create',
          icon: ArrowLeftRight,
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
