/**
 * Ledger set-up rules shared by the API and the web app (phase 2 row 2.14; PLAN 3.9).
 *
 * Purpose: what an account code, account type, ledger dimension, tax rate and exchange rate
 * look like, and how a fiscal year is cut into periods, so the screens (row 2.16) and the
 * API (apps/api/src/modules/gl) check the same things.
 *
 * Depends on: zod. Used by: apps/api modules/gl, later the ledger screens.
 */
import { z } from 'zod';

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];
export const accountTypeSchema = z.enum(ACCOUNT_TYPES);

/**
 * Dimensions a journal line can carry (PLAN 3.9 `journal_line`). An account may require
 * some of them (`requires_dimensions`); the posting service (row 2.15) enforces that.
 */
export const LEDGER_DIMENSIONS = [
  'party',
  'employee',
  'vehicle',
  'client_platform',
  'branch',
  'cost_centre',
  'pay_period',
  'loan',
] as const;
export type LedgerDimension = (typeof LEDGER_DIMENSIONS)[number];
export const ledgerDimensionsSchema = z
  .array(z.enum(LEDGER_DIMENSIONS))
  .max(LEDGER_DIMENSIONS.length)
  .refine((dims) => new Set(dims).size === dims.length, 'A dimension is listed twice.');

/** Account codes: 1 to 20 letters, digits, dots or dashes, starting with a letter or digit. */
export const accountCodeSchema = z
  .string()
  .regex(/^[0-9A-Za-z][0-9A-Za-z.-]{0,19}$/, 'Use 1 to 20 letters, digits, dots or dashes.');
export const costCentreCodeSchema = z
  .string()
  .regex(/^[0-9A-Za-z][0-9A-Za-z._-]{0,29}$/, 'Use 1 to 30 letters, digits, dots, dashes or _.');
export const taxCodeCodeSchema = z
  .string()
  .regex(/^[A-Z0-9][A-Z0-9_-]{0,19}$/, 'Use 1 to 20 capital letters, digits, dashes or _.');

/** Name per language (`{"en": "Cash on hand", "bn": "..."}`); English is required. */
export const ledgerNameSchema = z
  .record(z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/), z.string().trim().min(1).max(200))
  .refine((names) => typeof names.en === 'string' && names.en.length > 0, {
    message: 'An English name is required.',
  });

/** Tax rate in percent as text: 0 to 100 with at most 4 decimals (5 = 5 %). */
export const taxRateSchema = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,4})?$/, 'A percentage with at most 4 decimals, for example 5 or 2.5.')
  .refine((text) => Number(text) <= 100, 'A tax rate cannot be above 100 %.');

/** Exchange rate as text: above zero, at most 10 integer digits and 8 decimals. */
export const exchangeRateValueSchema = z
  .string()
  .regex(/^\d{1,10}(\.\d{1,8})?$/, 'A positive number with at most 8 decimals.')
  .refine((text) => /[1-9]/.test(text), 'An exchange rate must be above zero.');

export interface PeriodSpan {
  periodNo: number;
  /** YYYY-MM-DD, inclusive. */
  startDate: string;
  /** YYYY-MM-DD, inclusive. */
  endDate: string;
}

const DAY_MS = 86_400_000;
const parseDay = (text: string): Date => new Date(`${text}T00:00:00.000Z`);
const dayText = (d: Date): string => d.toISOString().slice(0, 10);

/** Longest fiscal year accepted (a long first year), in days; the database checks it too. */
export const MAX_FISCAL_YEAR_DAYS = 548;
/** Most periods a year can have: 18 months for a long first year. */
export const MAX_FISCAL_PERIODS = 18;

/** The usual end of a year starting on `startDate`: one day before the same date a year later. */
export function defaultFiscalYearEnd(startDate: string): string {
  const start = parseDay(startDate);
  const next = new Date(
    Date.UTC(start.getUTCFullYear() + 1, start.getUTCMonth(), start.getUTCDate()),
  );
  return dayText(new Date(next.getTime() - DAY_MS));
}

/**
 * Cuts a fiscal year into monthly periods.
 *
 * Why calendar-month edges: pay periods, invoices and the Qatar WPS file are all monthly by
 * calendar month, so a period must never straddle two months. A year that starts mid-month
 * gets a short first period (start to the end of that month); a year that ends mid-month gets
 * a short last period. A year that starts on the 1st and lasts twelve months gets exactly 12.
 *
 * Throws when the dates are not a valid year (end before start, longer than 548 days).
 */
export function fiscalPeriods(startDate: string, endDate: string): PeriodSpan[] {
  const start = parseDay(startDate);
  const end = parseDay(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error('Fiscal year dates must be YYYY-MM-DD.');
  }
  if (end < start) throw new Error('A fiscal year cannot end before it starts.');
  if ((end.getTime() - start.getTime()) / DAY_MS >= MAX_FISCAL_YEAR_DAYS) {
    throw new Error('A fiscal year can last at most 18 months.');
  }
  const periods: PeriodSpan[] = [];
  let cursor = start;
  while (cursor <= end) {
    // Last day of the cursor's calendar month (day 0 of the next month).
    const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0));
    const periodEnd = monthEnd < end ? monthEnd : end;
    periods.push({
      periodNo: periods.length + 1,
      startDate: dayText(cursor),
      endDate: dayText(periodEnd),
    });
    cursor = new Date(periodEnd.getTime() + DAY_MS);
  }
  if (periods.length > MAX_FISCAL_PERIODS) {
    throw new Error('A fiscal year can have at most 18 periods.');
  }
  return periods;
}
