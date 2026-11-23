/**
 * Call sheet arithmetic (phase 4 row 4.7): pure functions, no database, unit-tested.
 *
 *   sheetStatusOf   what the platform sheet itself says about a person (blocked, not updated ...)
 *   crossCheck      the differences between the sheet and our employee status (SPEC 3.3)
 *   summarise       the summary strip at the top of the call sheet
 *
 * Why the sheet status is read this way: Snoonu's Daily Report has no fixed status column.
 * A status shows up either as an extra column whose header names a status ("Status",
 * "Account Status" ...; kept under `metrics._extra` by the sync, SPEC 3.1 "unknown columns are
 * kept") or in the Tags column (`metrics._fields.tags`). Both are the platform's free text, so
 * it is matched by words; text that matches none of them is shown but never compared, so an
 * unexpected word can never raise a false flag.
 *
 * Depends on: @fibrex/shared (cross-check kinds), ../performance (the shared zero-orders and
 * day-off rule, row 4.8d). Used by: ./tracking-service.ts.
 */
import type { CrossCheckKind } from '@fibrex/shared';
import { isZeroOrderProblem } from '../performance/index.js';

/** What the sheet's text can mean, as our status codes plus "not updated". */
export type SheetStatusCode = 'active' | 'inactive' | 'blocked' | 'terminated' | 'not_updated';

export interface SheetStatus {
  /** The sheet's own words, trimmed. */
  text: string;
  /** Our reading of them; null when the words match nothing we know. */
  code: SheetStatusCode | null;
}

/** Extra-column headers that hold a status (compared lower-case, spaces collapsed). */
const STATUS_HEADERS = new Set(['status', 'account status', 'rider status', 'driver status']);

/**
 * Words in the sheet's text, most specific first: "Not updated" and "Inactive" both contain
 * words that would otherwise read as something else ("updated", "active").
 */
const WORDS: readonly [RegExp, SheetStatusCode][] = [
  [/not\s*updated/i, 'not_updated'],
  [/block/i, 'blocked'],
  [/terminat/i, 'terminated'],
  [/\b(in-?active|deactivated?)\b/i, 'inactive'],
  [/\bactive\b/i, 'active'],
];

function classify(text: string): SheetStatusCode | null {
  for (const [pattern, code] of WORDS) if (pattern.test(text)) return code;
  return null;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** A sheet cell as text: words and numbers only (anything else says nothing). */
const textOf = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';

/**
 * The sheet's status of one person from a stored figure row's `metrics`: a status column
 * first, the Tags column otherwise. Null when the sheet says nothing.
 */
export function sheetStatusOf(metrics: unknown): SheetStatus | null {
  const all = asRecord(metrics);
  const extra = asRecord(all._extra);
  const fields = asRecord(all._fields);
  const candidates: string[] = [];
  for (const [header, value] of Object.entries(extra)) {
    if (STATUS_HEADERS.has(header.trim().toLowerCase().replace(/\s+/g, ' '))) {
      candidates.push(textOf(value));
    }
  }
  candidates.push(textOf(fields.tags));
  // A recognised word wins over unrecognised text; the first non-empty text otherwise.
  let fallback: SheetStatus | null = null;
  for (const raw of candidates) {
    const text = raw.trim();
    if (text === '') continue;
    const code = classify(text);
    if (code !== null) return { text, code };
    fallback ??= { text, code: null };
  }
  return fallback;
}

export interface CrossCheckInput {
  /** Our employee status on the sheet's date. */
  ourStatus: string | null;
  /**
   * Whether the figures date was reported at all (the company has stored figures for it).
   * A day the sync missed is not a day of zero orders (the reset guard of phase 4 plan 9).
   */
  reported: boolean;
  /** Orders on the figures date; null when the sheet had no row for the person. */
  orders: number | null;
  sheet: SheetStatus | null;
  /** The figures date was the person's weekly day off: no orders is then expected (row 4.8d). */
  dayOffOnFiguresDate?: boolean;
}

/** The cross-check findings for one person, in the order of CROSS_CHECK_KINDS. */
export function crossCheck(input: CrossCheckInput): CrossCheckKind[] {
  const flags: CrossCheckKind[] = [];
  const orders = input.orders ?? 0;
  if (
    input.ourStatus === 'active' &&
    isZeroOrderProblem(orders, input.reported, input.dayOffOnFiguresDate === true)
  ) {
    flags.push('active_no_orders');
  }
  if (input.reported && input.ourStatus !== null && input.ourStatus !== 'active' && orders > 0) {
    flags.push('inactive_with_orders');
  }
  const sheetCode = input.sheet?.code ?? null;
  if (
    sheetCode !== null &&
    sheetCode !== 'not_updated' &&
    input.ourStatus !== null &&
    sheetCode !== input.ourStatus
  ) {
    flags.push('status_mismatch');
  }
  if (sheetCode === 'not_updated') flags.push('sheet_not_updated');
  return flags;
}

export interface SummaryRow {
  statusCode: string | null;
  /** Called on the sheet's date (a call logged or a call outcome on the entry). */
  called: boolean;
  orders: number | null;
  workingMinutes: number | null;
  /** Whether the entry of the date records a status change (applied, pending or failed). */
  statusChanged: boolean;
  operatedByOther: boolean;
  flagged: boolean;
  /** The figures date was the person's weekly day off (row 4.8d). */
  dayOffOnFiguresDate?: boolean;
}

export interface Summary {
  totalPeople: number;
  called: number;
  notCalled: number;
  ordersYesterday: number;
  hoursYesterday: number;
  /** People with no orders on the figures date (only counted when the date was reported). */
  zeroOrders: number;
  statusChangesToday: number;
  /** People per status code. */
  byStatus: Record<string, number>;
  operatedByOthers: number;
  crossCheckFlags: number;
}

/** The summary strip over every listed person. Hours are rounded to two decimals. */
export function summarise(rows: readonly SummaryRow[], reported: boolean): Summary {
  let minutes = 0;
  const summary: Summary = {
    totalPeople: rows.length,
    called: 0,
    notCalled: 0,
    ordersYesterday: 0,
    hoursYesterday: 0,
    zeroOrders: 0,
    statusChangesToday: 0,
    byStatus: {},
    operatedByOthers: 0,
    crossCheckFlags: 0,
  };
  for (const row of rows) {
    if (row.called) summary.called += 1;
    else summary.notCalled += 1;
    summary.ordersYesterday += row.orders ?? 0;
    minutes += row.workingMinutes ?? 0;
    // Same rule as the rows, the filter and the summary email: a day off is not a zero.
    if (isZeroOrderProblem(row.orders, reported, row.dayOffOnFiguresDate === true)) {
      summary.zeroOrders += 1;
    }
    if (row.statusChanged) summary.statusChangesToday += 1;
    const status = row.statusCode ?? 'none';
    summary.byStatus[status] = (summary.byStatus[status] ?? 0) + 1;
    if (row.operatedByOther) summary.operatedByOthers += 1;
    if (row.flagged) summary.crossCheckFlags += 1;
  }
  summary.hoursYesterday = Math.round((minutes / 60) * 100) / 100;
  return summary;
}
