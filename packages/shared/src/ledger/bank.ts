/**
 * Cash locations, company bank accounts and bank statement import: shared rules (phase 2
 * row 2.17a; PLAN 3.9).
 *
 * Purpose: what a cash location and a company bank account look like, and how one row of a
 * bank's CSV statement becomes a statement line (date, signed amount, reference, text). The
 * column mapping is data the user gives with each import (SPEC 2.6), so a new bank's layout
 * never needs code. Pure functions only (no database, no clock), so the API and the import
 * screen of row 2.17c behave the same.
 *
 * Money rules (SPEC 2.9): amounts stay decimal strings with 4 places, never floats; a line is
 * signed from the company's point of view (money in > 0, money out < 0) and is never zero.
 *
 * Depends on: zod, ../money (Decimal), ../imports (ParsedSheet). Used by: apps/api
 * modules/gl (bank-router.ts, bank-statement-router.ts), later the reconciliation screens.
 */
import { z } from 'zod';
import type { ParsedSheet } from '../imports/index.js';
import { Decimal, currencyCodeSchema } from '../money/index.js';

export const CASH_LOCATION_KINDS = ['hand', 'bank', 'card', 'wallet'] as const;
export const cashLocationKindSchema = z.enum(CASH_LOCATION_KINDS);

/** An IBAN as typed: 8 to 34 letters and digits once spaces and dashes are removed. */
export const ibanInputSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]+/g, '').toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{2}[0-9]{2}[A-Z0-9]{4,30}$/, 'Enter a valid IBAN.'));

/** What lists show of an IBAN: only the last four characters. */
export function maskIban(normalised: string): string {
  return normalised.length <= 4
    ? '*'.repeat(normalised.length)
    : `${'*'.repeat(normalised.length - 4)}${normalised.slice(-4)}`;
}

export const STATEMENT_DATE_FORMATS = ['ymd', 'dmy', 'mdy'] as const;
export const statementDateFormatSchema = z.enum(STATEMENT_DATE_FORMATS);
export type StatementDateFormat = (typeof STATEMENT_DATE_FORMATS)[number];

const column = z.string().trim().min(1).max(200);

/**
 * Which CSV column feeds which field. Either one signed `amountColumn`, or both
 * `debitColumn` (money out) and `creditColumn` (money in), as banks export them.
 */
export const bankStatementMappingSchema = z
  .strictObject({
    dateColumn: column,
    dateFormat: statementDateFormatSchema.default('ymd'),
    amountColumn: column.optional(),
    debitColumn: column.optional(),
    creditColumn: column.optional(),
    referenceColumn: column.optional(),
    descriptionColumn: column.optional(),
  })
  .superRefine((m, ctx) => {
    const single = m.amountColumn !== undefined;
    const split = m.debitColumn !== undefined && m.creditColumn !== undefined;
    const partial = (m.debitColumn !== undefined) !== (m.creditColumn !== undefined);
    if (single === split || partial) {
      ctx.addIssue({
        code: 'custom',
        path: ['amountColumn'],
        message: 'Map either one amount column, or both a debit and a credit column.',
      });
    }
  });
export type BankStatementMapping = z.infer<typeof bankStatementMappingSchema>;

/** One statement line ready to store (amount is a signed 4-place decimal string). */
export interface StatementLineDraft {
  lineNo: number;
  valueDate: string;
  amount: string;
  reference: string | null;
  description: string | null;
}

export interface StatementRowError {
  /** 1-based data row number (the first row after the header is row 1). */
  row: number;
  field: string;
  message: string;
}

export interface NormalisedStatement {
  lines: StatementLineDraft[];
  errors: StatementRowError[];
  periodFrom: string | null;
  periodTo: string | null;
  totalIn: string;
  totalOut: string;
}

/** The most errors reported at once; a wrong mapping would otherwise list every row. */
export const MAX_STATEMENT_ERRORS = 50;

/**
 * Reads a date in the chosen order. Day and month may have one or two digits, the separator
 * is `-`, `/` or `.`, and a time after the date ("2026-11-03 10:15") is ignored. Returns an
 * ISO date, or null when the text is not a real calendar date (31 February is refused).
 */
export function parseStatementDate(text: string, format: StatementDateFormat): string | null {
  const cleaned = text.trim().replace(/[ T].*$/, '');
  const ymd = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(cleaned);
  const other = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(cleaned);
  let year: number;
  let month: number;
  let day: number;
  if (format === 'ymd') {
    if (ymd === null) return null;
    [year, month, day] = [Number(ymd[1]), Number(ymd[2]), Number(ymd[3])];
  } else {
    if (other === null) return null;
    year = Number(other[3]);
    [month, day] =
      format === 'dmy'
        ? [Number(other[2]), Number(other[1])]
        : [Number(other[1]), Number(other[2])];
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return probe.toISOString().slice(0, 10);
}

/**
 * Reads an amount as a banks prints it into a Decimal, or null when it is not a number.
 *
 * Accepts "1234.50", "1,234.50", "1.234,50", "1 234,50", "(1,234.50)" and "1234.50-" (both
 * meaning negative), and a leading + or -. A single comma followed by exactly three digits
 * ("1,234") is a thousands separator; a single dot is always a decimal point ("1.234" is
 * 1.234). More than four decimals is refused rather than silently rounded.
 */
export function parseStatementAmount(text: string): Decimal | null {
  // \s also matches the no-break space some banks print between thousands.
  let value = text.trim().replace(/[\s']/g, '');
  if (value === '') return null;
  let negative = false;
  if (/^\(.*\)$/.test(value)) {
    negative = true;
    value = value.slice(1, -1);
  }
  if (value.endsWith('-')) {
    negative = !negative;
    value = value.slice(0, -1);
  }
  if (value.startsWith('-')) {
    negative = !negative;
    value = value.slice(1);
  } else if (value.startsWith('+')) {
    value = value.slice(1);
  }
  if (!/^[0-9.,]+$/.test(value) || !/\d/.test(value)) return null;

  // Step 1: decide which separator (if any) is the decimal point.
  //   - both kinds present: the one that comes last is the decimal point;
  //   - one kind, repeated ("1.234.567"): thousands, no decimals;
  //   - a comma once with exactly three digits after it ("1,234"): thousands;
  //   - anything else with one separator ("12,50", "1234.5", "1.234"): decimal point.
  const lastDot = value.lastIndexOf('.');
  const lastComma = value.lastIndexOf(',');
  const last = Math.max(lastDot, lastComma);
  let integer = value;
  let fraction = '';
  if (last !== -1) {
    const after = value.slice(last + 1);
    const separator = value.charAt(last);
    const repeated = value.split(separator).length - 1 > 1;
    const bothKinds = lastDot !== -1 && lastComma !== -1;
    const thousandsOnly = !bothKinds && (repeated || (separator === ',' && after.length === 3));
    if (!thousandsOnly) {
      integer = value.slice(0, last);
      fraction = after;
    }
  }
  // Step 2: the whole part is plain digits or correctly grouped by three.
  if (!/^\d{1,3}([.,]\d{3})+$|^\d+$/.test(integer)) return null;
  if (!/^\d{0,4}$/.test(fraction)) return null;
  const digits = `${integer.replace(/[.,]/g, '')}${fraction === '' ? '' : `.${fraction}`}`;
  const parsed = new Decimal(digits);
  return negative ? parsed.negated() : parsed;
}

/**
 * Turns the parsed CSV into statement lines, collecting every problem (never rewriting a
 * value to make it fit). Steps:
 *   1. The mapped columns must exist in the file.
 *   2. Each row: a real date, a number (or a debit/credit pair with exactly one side set),
 *      and not zero. Free text is trimmed and limited in length.
 *   3. Money in is positive. With a debit/credit pair, amount = credit - debit.
 *   4. Totals and the period (earliest and latest date) come from the accepted lines.
 * When `errors` is not empty the caller stores nothing (all or nothing).
 */
export function normaliseStatement(
  sheet: ParsedSheet,
  mapping: BankStatementMapping,
): NormalisedStatement {
  const errors: StatementRowError[] = [];
  const lines: StatementLineDraft[] = [];
  const wanted = [
    mapping.dateColumn,
    mapping.amountColumn,
    mapping.debitColumn,
    mapping.creditColumn,
    mapping.referenceColumn,
    mapping.descriptionColumn,
  ].filter((c): c is string => c !== undefined);
  const missing = wanted.filter((c) => !sheet.columns.includes(c));
  const empty: NormalisedStatement = {
    lines,
    errors,
    periodFrom: null,
    periodTo: null,
    totalIn: '0.0000',
    totalOut: '0.0000',
  };
  if (missing.length > 0) {
    errors.push({
      row: 0,
      field: 'mapping',
      message: `The file has no column named ${missing.map((c) => `"${c}"`).join(', ')}.`,
    });
    return empty;
  }

  const add = (row: number, field: string, message: string) => {
    if (errors.length < MAX_STATEMENT_ERRORS) errors.push({ row, field, message });
  };
  const text = (record: Record<string, string>, name: string | undefined, max: number) => {
    const value = name === undefined ? '' : (record[name] ?? '').trim();
    return value === '' ? null : value.slice(0, max);
  };

  let totalIn = new Decimal(0);
  let totalOut = new Decimal(0);
  sheet.rows.forEach((record, index) => {
    const row = index + 1;
    const date = parseStatementDate(record[mapping.dateColumn] ?? '', mapping.dateFormat);
    if (date === null)
      add(row, mapping.dateColumn, 'This is not a valid date in the chosen order.');

    let amount: Decimal | null = null;
    if (mapping.amountColumn !== undefined) {
      amount = parseStatementAmount(record[mapping.amountColumn] ?? '');
      if (amount === null) add(row, mapping.amountColumn, 'This is not a valid amount.');
    } else if (mapping.debitColumn !== undefined && mapping.creditColumn !== undefined) {
      const debitText = (record[mapping.debitColumn] ?? '').trim();
      const creditText = (record[mapping.creditColumn] ?? '').trim();
      const debit = debitText === '' ? new Decimal(0) : parseStatementAmount(debitText);
      const credit = creditText === '' ? new Decimal(0) : parseStatementAmount(creditText);
      if (debit === null) add(row, mapping.debitColumn, 'This is not a valid amount.');
      else if (credit === null) add(row, mapping.creditColumn, 'This is not a valid amount.');
      else if (!debit.isZero() && !credit.isZero()) {
        add(row, mapping.debitColumn, 'Both debit and credit are filled; use one side only.');
      } else amount = credit.minus(debit);
    }
    if (amount?.isZero() === true) add(row, 'amount', 'A statement line cannot be zero.');

    if (date === null || amount === null || amount.isZero()) return;
    if (amount.isPositive()) totalIn = totalIn.plus(amount);
    else totalOut = totalOut.plus(amount.abs());
    lines.push({
      lineNo: row,
      valueDate: date,
      amount: amount.toFixed(4),
      reference: text(record, mapping.referenceColumn, 200),
      description: text(record, mapping.descriptionColumn, 1000),
    });
  });

  const dates = lines.map((l) => l.valueDate).sort();
  return {
    lines,
    errors,
    periodFrom: dates[0] ?? null,
    periodTo: dates[dates.length - 1] ?? null,
    totalIn: totalIn.toFixed(4),
    totalOut: totalOut.toFixed(4),
  };
}

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

const name200 = z.string().trim().min(1).max(200);

export const cashLocationCreateSchema = z.strictObject({
  name: name200,
  kind: cashLocationKindSchema,
  accountId: z.uuid(),
  currency: currencyCodeSchema,
});
export const cashLocationUpdateSchema = z
  .strictObject({ name: name200, accountId: z.uuid() })
  .partial();

export const companyBankAccountCreateSchema = z.strictObject({
  cashLocationId: z.uuid(),
  bankName: name200,
  iban: ibanInputSchema,
  wpsEmployerId: z.string().trim().min(1).max(50).nullable().default(null),
});
export const companyBankAccountUpdateSchema = z
  .strictObject({
    bankName: name200,
    iban: ibanInputSchema,
    wpsEmployerId: z.string().trim().min(1).max(50).nullable(),
  })
  .partial();

export const bankStatementImportSchema = z.strictObject({
  companyBankAccountId: z.uuid(),
  fileObjectId: z.uuid(),
  mapping: bankStatementMappingSchema,
  note: z.string().trim().min(1).max(500).nullable().default(null),
});
export const bankStatementUpdateSchema = z
  .strictObject({ note: z.string().trim().min(1).max(500).nullable() })
  .partial();
