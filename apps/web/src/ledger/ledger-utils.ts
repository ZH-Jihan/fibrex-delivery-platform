/**
 * Small helpers shared by the ledger screens (phase 2 row 2.16a).
 *
 * Purpose: turn the account tree from `GET /accounts/tree` into an indented list, find an
 * account's label by id or code, and add up the lines of a journal or a manual-journal draft
 * per currency with exact decimals (never JavaScript floating point; SPEC 2.9).
 *
 * Depends on: @fibrex/shared (Decimal, ledger types). Used by: ledger/*Page.tsx.
 */
import { Decimal, type AccountType } from '@fibrex/shared';

export interface AccountRow {
  id: string;
  code: string;
  name: Record<string, string>;
  type: AccountType;
  parentId: string | null;
  isPostable: boolean;
  isControl: boolean;
  currencyRestriction: string | null;
  requiresDimensions: string[];
  description: string | null;
  version: number;
}
export interface AccountNode extends AccountRow {
  children: AccountNode[];
}
/** One account in the flattened tree, with its depth for indenting. */
export interface FlatAccount extends AccountRow {
  depth: number;
}

/** Depth-first, in the server's code order, so every header comes right before its children. */
export function flattenTree(nodes: readonly AccountNode[], depth = 0): FlatAccount[] {
  const out: FlatAccount[] = [];
  for (const node of nodes) {
    const { children, ...row } = node;
    out.push({ ...row, depth });
    out.push(...flattenTree(children, depth + 1));
  }
  return out;
}

/** The name in the user's language, else English, else the code. */
export function accountName(account: Pick<AccountRow, 'code' | 'name'>, language: string): string {
  return account.name[language] ?? account.name.en ?? account.code;
}

/** "1000 Cash on hand" for an id, or the id itself when the account is not loaded. */
export function accountLabel(
  accounts: readonly AccountRow[],
  id: string,
  language: string,
): string {
  const account = accounts.find((a) => a.id === id);
  return account === undefined ? id : `${account.code} ${accountName(account, language)}`;
}

export interface LineAmounts {
  debit?: string | undefined;
  credit?: string | undefined;
  currency?: string | undefined;
}
export interface CurrencyTotal {
  currency: string;
  debit: string;
  credit: string;
  balanced: boolean;
}

/**
 * Debit and credit totals per currency (a line with no currency counts under `baseCurrency`).
 * Used to show a draft's balance before it is posted. The server stays the judge: a draft
 * with foreign lines balances in base currency only after its rates are applied, which
 * `POST /manual-journals/{id}/post` checks (rounding rule in DECISIONS 2.15b).
 */
export function totalsByCurrency(
  lines: readonly LineAmounts[],
  baseCurrency: string,
): CurrencyTotal[] {
  const totals = new Map<string, { debit: Decimal; credit: Decimal }>();
  for (const line of lines) {
    const currency =
      line.currency === undefined || line.currency === '' ? baseCurrency : line.currency;
    const entry = totals.get(currency) ?? { debit: new Decimal(0), credit: new Decimal(0) };
    // A box that is empty or not yet a number counts as zero while the user types.
    entry.debit = entry.debit.plus(safeDecimal(line.debit));
    entry.credit = entry.credit.plus(safeDecimal(line.credit));
    totals.set(currency, entry);
  }
  return [...totals.entries()].map(([currency, t]) => ({
    currency,
    debit: t.debit.toFixed(2),
    credit: t.credit.toFixed(2),
    balanced: t.debit.equals(t.credit),
  }));
}

function safeDecimal(text: string | undefined): Decimal {
  if (text === undefined || text.trim() === '') return new Decimal(0);
  try {
    return new Decimal(text.trim());
  } catch {
    return new Decimal(0);
  }
}

/** "1234.5000" -> "1,234.50"; empty for zero so debit and credit columns read cleanly. */
export function showAmount(text: string): string {
  const value = safeDecimal(text);
  if (value.isZero()) return '';
  const [whole = '0', fraction = '00'] = value.toFixed(2).split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`;
}
