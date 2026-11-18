/**
 * Menu entries of the ledger screens (phase 2 rows 2.16a and 2.17b): chart of accounts,
 * journals, manual journals, simulate, cash and bank, statements, reconciliation, match
 * rules. Each entry needs the matching `gl.*` read permission.
 * Depends on: shell/manifest.ts, lucide-react. Used by: shell/nav.ts.
 */
import {
  BookOpen,
  FilePenLine,
  FileSpreadsheet,
  FlaskConical,
  GitCompareArrows,
  Landmark,
  NotebookText,
  Wand2,
} from 'lucide-react';
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
        {
          to: '/ledger/simulate',
          label: 'nav.simulate',
          permission: 'gl.posting_rule.read',
          icon: FlaskConical,
        },
        {
          to: '/ledger/cash-bank',
          label: 'nav.cashBank',
          permission: 'gl.cash_location.read',
          icon: Landmark,
        },
        {
          to: '/ledger/statements',
          label: 'nav.statements',
          permission: 'gl.bank_statement.read',
          icon: FileSpreadsheet,
        },
        {
          to: '/ledger/reconciliation',
          label: 'nav.reconciliation',
          permission: 'gl.reconciliation.read',
          icon: GitCompareArrows,
        },
        {
          to: '/ledger/match-rules',
          label: 'nav.matchRules',
          permission: 'gl.bank_match_rule.read',
          icon: Wand2,
        },
      ],
    },
  ],
};
