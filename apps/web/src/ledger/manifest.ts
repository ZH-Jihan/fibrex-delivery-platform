/**
 * Menu entries of the ledger screens (phase 2 row 2.16a): chart of accounts, journals,
 * manual journals. Each entry needs the matching `gl.*` read permission.
 * Depends on: shell/manifest.ts, lucide-react. Used by: shell/nav.ts.
 */
import { BookOpen, FilePenLine, NotebookText } from 'lucide-react';
import type { WebModuleManifest } from '../shell/manifest';

export const ledgerManifest: WebModuleManifest = {
  key: 'gl',
  nav: [
    {
      label: 'nav.ledger',
      items: [
        {
          to: '/ledger/accounts',
          label: 'nav.accounts',
          permission: 'gl.account.read',
          icon: BookOpen,
        },
        {
          to: '/ledger/journals',
          label: 'nav.journals',
          permission: 'gl.journal.read',
          icon: NotebookText,
        },
        {
          to: '/ledger/manual-journals',
          label: 'nav.manualJournals',
          permission: 'gl.manual_journal.read',
          icon: FilePenLine,
        },
      ],
    },
  ],
};
