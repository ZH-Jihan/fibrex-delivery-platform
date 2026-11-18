/**
 * Ledger reports on the report engine (phase 2 row 2.16b; PLAN 5.11):
 * `ledger.trial_balance`, `ledger.general_ledger`, `ledger.party_statement`.
 *
 * All three read posted journal lines only, in base currency, through the `db` the engine
 * hands them. They need `gl.journal.read` (the same permission as the journals screen).
 *
 * Depends on: ./ledger-queries.ts, kernel/module-registry/manifest.ts, kernel/http/errors.
 * Used by: ./index.ts (the gl manifest's `reports`).
 */
import type { ReportFilterSpec } from '@fibrex/shared';
import { BadRequestError } from '../../kernel/http/errors.js';
import type { ReportDef } from '../../kernel/module-registry/manifest.js';
import { balancesByAccount, statement, type StatementFilter } from './ledger-queries.js';

const statementColumns: ReportDef['columns'] = [
  { key: 'entryDate', label: 'Date', type: 'date' },
  { key: 'journalNumber', label: 'Journal', type: 'text' },
  { key: 'accountCode', label: 'Account', type: 'text' },
  { key: 'description', label: 'Description', type: 'text' },
  { key: 'memo', label: 'Memo', type: 'text' },
  { key: 'debit', label: 'Debit', type: 'money' },
  { key: 'credit', label: 'Credit', type: 'money' },
  { key: 'runningBalance', label: 'Balance', type: 'money' },
];
const dateFilters: ReportFilterSpec[] = [
  { key: 'from', label: 'From date', type: 'date' },
  { key: 'to', label: 'To date', type: 'date' },
];

export const trialBalanceReport: ReportDef = {
  key: 'ledger.trial_balance',
  label: 'Trial balance',
  description: 'Debit, credit and balance of every account with postings, as of a date.',
  permission: 'gl.journal.read',
  columns: [
    { key: 'accountCode', label: 'Account', type: 'text', sortable: true },
    { key: 'accountName', label: 'Name', type: 'text' },
    { key: 'baseDebit', label: 'Debit', type: 'money' },
    { key: 'baseCredit', label: 'Credit', type: 'money', sortable: false },
    { key: 'balance', label: 'Balance', type: 'money', sortable: true },
  ],
  filters: [{ key: 'asOf', label: 'As of', type: 'date' }],
  async run(db, input) {
    const all = await balancesByAccount(db, { asOf: input.filters.asOf });
    // Sorting is done here because the rows are sums, not table rows. Both sortable columns
    // are compared in a fixed way; ties fall back to the account code.
    const direction = input.sort?.direction === 'desc' ? -1 : 1;
    if (input.sort?.key === 'balance') {
      all.sort(
        (a, b) =>
          direction * (Number(a.balance) - Number(b.balance)) ||
          a.accountCode.localeCompare(b.accountCode),
      );
    } else if (direction === -1) {
      all.reverse();
    }
    const start = (input.page - 1) * input.pageSize;
    // Spread into plain objects: the engine's rows are `Record<string, ReportCell>`.
    return {
      rows: all.slice(start, start + input.pageSize).map((r) => ({ ...r })),
      total: all.length,
    };
  },
};

function statementFilter(
  filters: Record<string, string>,
  extra: Partial<StatementFilter>,
): StatementFilter {
  return {
    from: filters.from,
    to: filters.to,
    ...extra,
  };
}

export const generalLedgerReport: ReportDef = {
  key: 'ledger.general_ledger',
  label: 'General ledger',
  description: 'Every posted line of one account in date order, with a running balance.',
  permission: 'gl.journal.read',
  columns: statementColumns,
  filters: [{ key: 'accountId', label: 'Account id', type: 'text' }, ...dateFilters],
  async run(db, input) {
    const accountId = input.filters.accountId;
    if (accountId === undefined) {
      throw new BadRequestError('account_required', 'Choose an account for the general ledger.');
    }
    const result = await statement(
      db,
      statementFilter(input.filters, { accountId }),
      input.page,
      input.pageSize,
    );
    return { rows: result.rows.map((r) => ({ ...r })), total: result.total };
  },
};

export const partyStatementReport: ReportDef = {
  key: 'ledger.party_statement',
  label: 'Party statement',
  description: 'Every posted line for one person or organisation, with a running balance.',
  permission: 'gl.journal.read',
  columns: statementColumns,
  filters: [
    { key: 'partyId', label: 'Party id', type: 'text' },
    { key: 'accountId', label: 'Account id', type: 'text' },
    ...dateFilters,
  ],
  async run(db, input) {
    const partyId = input.filters.partyId;
    if (partyId === undefined) {
      throw new BadRequestError('party_required', 'Choose a party for the statement.');
    }
    const result = await statement(
      db,
      statementFilter(input.filters, {
        partyId,
        accountId: input.filters.accountId,
      }),
      input.page,
      input.pageSize,
    );
    return { rows: result.rows.map((r) => ({ ...r })), total: result.total };
  },
};

export const GL_REPORTS: readonly ReportDef[] = [
  trialBalanceReport,
  generalLedgerReport,
  partyStatementReport,
];
