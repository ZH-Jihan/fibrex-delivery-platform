/**
 * Ledger read queries (phase 2 row 2.16b; PLAN 5.11): balances by account, party and
 * dimensions as of a date, and the statement (running balance) used by the general ledger and
 * party statement reports.
 *
 * Everything reads `gl.journal_line` through the `db` it is handed (the caller's unit of work),
 * so row-level security limits it to the caller's companies. Amounts are base-currency
 * amounts (`base_debit`, `base_credit`); there is no stored balance anywhere (SPEC 2.9): a
 * balance is always the sum of posted lines, debit minus credit.
 *
 * Depends on: kernel/db, generated Prisma client. Used by: ./ledger-router.ts, ./ledger-reports.ts.
 */
import type { Db } from '../../kernel/db/prisma.js';
import { BadRequestError } from '../../kernel/http/errors.js';
import { Prisma } from '../../generated/prisma/client.js';

/** The dimension names a caller may filter by, and the journal-line column each one reads. */
export const DIMENSION_COLUMNS = {
  party: 'partyId',
  employee: 'employeePartyId',
  vehicle: 'vehicleId',
  client_platform: 'clientPlatformId',
  branch: 'branchId',
  cost_centre: 'costCentreId',
  pay_period: 'payPeriodId',
  loan: 'loanId',
} as const;
export type DimensionName = keyof typeof DIMENSION_COLUMNS;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZERO = new Prisma.Decimal(0);

/**
 * Reads `dims` as `name:uuid,name:uuid` (for example `branch:...,costCentre:...`) into
 * line-column filters. Unknown names and bad ids are refused, never ignored, so a typo cannot
 * silently widen a balance.
 */
export function parseDimensions(text: string | undefined): Prisma.GlJournalLineWhereInput {
  const where: Record<string, string> = {};
  if (text === undefined || text.trim() === '') return where;
  for (const part of text.split(',')) {
    const [name, id, ...extra] = part.split(':').map((s) => s.trim());
    const column = name === undefined ? undefined : DIMENSION_COLUMNS[name as DimensionName];
    if (column === undefined || id === undefined || extra.length > 0 || !UUID.test(id)) {
      throw new BadRequestError(
        'bad_dimension',
        `"${part}" is not a dimension filter; use name:id with name one of ${Object.keys(
          DIMENSION_COLUMNS,
        ).join(', ')}.`,
      );
    }
    where[column] = id;
  }
  return where;
}

/** Account name in the caller's language; falls back to English, then any text. */
export function accountName(name: unknown, language = 'en'): string {
  if (typeof name === 'string') return name;
  if (name !== null && typeof name === 'object') {
    const map = name as Record<string, unknown>;
    const pick = map[language] ?? map.en ?? Object.values(map)[0];
    if (typeof pick === 'string') return pick;
  }
  return '';
}

export interface BalanceFilter {
  accountId?: string | undefined;
  partyId?: string | undefined;
  dims?: string | undefined;
  /** Inclusive; every line up to and including this day. */
  asOf?: string | undefined;
}

export interface BalanceRow {
  accountId: string;
  accountCode: string;
  accountName: string;
  baseDebit: string;
  baseCredit: string;
  /** Debit minus credit. */
  balance: string;
}

const day = (text: string): Date => new Date(`${text}T00:00:00.000Z`);

export function lineWhere(filter: BalanceFilter): Prisma.GlJournalLineWhereInput {
  return {
    ...parseDimensions(filter.dims),
    ...(filter.accountId === undefined ? {} : { accountId: filter.accountId }),
    ...(filter.partyId === undefined ? {} : { partyId: filter.partyId }),
    ...(filter.asOf === undefined ? {} : { entryDate: { lte: day(filter.asOf) } }),
  };
}

/** Balance per account over the lines matching the filter, ordered by account code. */
export async function balancesByAccount(db: Db, filter: BalanceFilter): Promise<BalanceRow[]> {
  const grouped = await db.glJournalLine.groupBy({
    by: ['accountId'],
    where: lineWhere(filter),
    _sum: { baseDebit: true, baseCredit: true },
  });
  if (grouped.length === 0) return [];
  const accounts = await db.glAccount.findMany({
    where: { id: { in: grouped.map((g) => g.accountId) } },
    select: { id: true, code: true, name: true },
  });
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return grouped
    .map((g) => {
      const debit = g._sum.baseDebit ?? ZERO;
      const credit = g._sum.baseCredit ?? ZERO;
      const account = byId.get(g.accountId);
      return {
        accountId: g.accountId,
        accountCode: account?.code ?? '',
        accountName: accountName(account?.name),
        baseDebit: debit.toFixed(4),
        baseCredit: credit.toFixed(4),
        balance: debit.minus(credit).toFixed(4),
      };
    })
    .sort((a, b) => a.accountCode.localeCompare(b.accountCode));
}

export interface StatementFilter extends BalanceFilter {
  /** Inclusive start of the statement; lines before it make the opening balance. */
  from?: string | undefined;
  to?: string | undefined;
}

export interface StatementRow {
  entryDate: string;
  journalNumber: string;
  description: string;
  accountCode: string;
  memo: string | null;
  debit: string;
  credit: string;
  /** Opening balance plus every line up to and including this one (debit minus credit). */
  runningBalance: string;
}

export interface StatementPage {
  rows: StatementRow[];
  total: number;
  openingBalance: string;
}

/**
 * One page of a statement: lines in date order with a running balance in base currency.
 *
 * Step by step: (1) opening balance = all matching lines before `from`; (2) the page's lines
 * are the matching lines from `from` to `to`, ordered by date, journal and line number (the
 * order is total, so pages never overlap); (3) the running balance of the first row on a page
 * needs the sum of the rows before the page, so those amounts are read (amounts only) and
 * added to the opening balance; (4) each row adds its own debit minus credit.
 */
export async function statement(
  db: Db,
  filter: StatementFilter,
  page: number,
  pageSize: number,
): Promise<StatementPage> {
  const base = lineWhere({ ...filter, asOf: undefined });
  let opening = ZERO;
  if (filter.from !== undefined) {
    const before = await db.glJournalLine.aggregate({
      where: { ...base, entryDate: { lt: day(filter.from) } },
      _sum: { baseDebit: true, baseCredit: true },
    });
    opening = (before._sum.baseDebit ?? ZERO).minus(before._sum.baseCredit ?? ZERO);
  }
  const range: Prisma.DateTimeFilter | Prisma.DateTimeFilter<'GlJournalLine'> = {
    ...(filter.from === undefined ? {} : { gte: day(filter.from) }),
    ...(filter.to === undefined ? {} : { lte: day(filter.to) }),
  };
  const where: Prisma.GlJournalLineWhereInput = { ...base, entryDate: range };
  const orderBy: Prisma.GlJournalLineOrderByWithRelationInput[] = [
    { entryDate: 'asc' },
    { journalId: 'asc' },
    { lineNo: 'asc' },
  ];
  const skip = (page - 1) * pageSize;
  const [total, earlier, lines] = await Promise.all([
    db.glJournalLine.count({ where }),
    skip === 0
      ? Promise.resolve([])
      : db.glJournalLine.findMany({
          where,
          orderBy,
          take: skip,
          select: { baseDebit: true, baseCredit: true },
        }),
    db.glJournalLine.findMany({
      where,
      orderBy,
      skip,
      take: pageSize,
      include: { journal: { select: { number: true, description: true } }, account: true },
    }),
  ]);
  let running = earlier.reduce((sum, l) => sum.plus(l.baseDebit).minus(l.baseCredit), opening);
  const rows = lines.map((l) => {
    running = running.plus(l.baseDebit).minus(l.baseCredit);
    return {
      entryDate: l.entryDate.toISOString().slice(0, 10),
      journalNumber: l.journal.number,
      description: l.journal.description,
      accountCode: l.account.code,
      memo: l.memo,
      debit: l.baseDebit.toFixed(4),
      credit: l.baseCredit.toFixed(4),
      runningBalance: running.toFixed(4),
    };
  });
  return { rows, total, openingBalance: opening.toFixed(4) };
}
