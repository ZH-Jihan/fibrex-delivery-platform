/**
 * Journal lines in foreign currency and manual journal shapes (phase 2 row 2.15b), shared by
 * the API (modules/gl posting service and manual journals) and the ledger screens (row 2.16).
 *
 * Multi-currency rule (SPEC 2.9 "every amount is stored with its currency code, exchange rate
 * and base-currency amount"; PLAN 3.9 journal_line):
 *   - fx_rate means 1 unit of the line's currency = fx_rate units of the company's base
 *     currency; a base-currency line has rate exactly 1.
 *   - base amount = amount x fx_rate, rounded half-up to 4 decimals (NUMERIC(18,4)).
 *   - The journal must balance in the base currency (the database checks this at commit).
 *
 * Why a rounding fix: lines that balance in their own currency at one rate can stop
 * balancing in base by a few 0.0001 after each line is rounded (3 x 33.3333 USD against
 * 99.9999 USD). That difference is not an exchange gain or loss, only rounding, so
 * `baseRoundingFix` moves it onto one line. It applies ONLY when every currency's lines
 * balance in that currency and share one rate; otherwise the difference is real (two rates
 * for one currency, or a cross-currency entry) and the caller must post it explicitly (for
 * example to an exchange difference account), so the journal is refused as unbalanced.
 *
 * Depends on: zod, ../money (Decimal), ./index (accountCodeSchema, taxCodeCodeSchema,
 * exchangeRateValueSchema, LEDGER_DIMENSIONS). Used by: apps/api modules/gl.
 */
import { z } from 'zod';
import { Decimal } from '../money/index.js';
import {
  accountCodeSchema,
  exchangeRateValueSchema,
  LEDGER_DIMENSIONS,
  taxCodeCodeSchema,
} from './index.js';

/** amount x rate in base currency, half-up to 4 decimals, as text with 4 decimals. */
export function toBaseAmount(amount: string, fxRate: string): string {
  return new Decimal(amount).times(fxRate).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4);
}

/** A line as the rounding fix sees it (decimal text; zero on the unused side). */
export interface FxLine {
  currency: string;
  fxRate: string;
  debit: string;
  credit: string;
  baseDebit: string;
  baseCredit: string;
}

/** Change `delta` (positive, decimal text) on the base amount of line `index`, side `side`. */
export interface RoundingFix {
  index: number;
  side: 'debit' | 'credit';
  delta: string;
}

/**
 * The single change that makes the base totals equal when the difference is rounding only
 * (see the header), or null when there is nothing to fix or the difference is not rounding.
 * The short side's foreign line (rate not 1) with the largest base amount takes the
 * difference (ties: the first such line), so a reversal with the same lines swapped picks
 * the same line. Lines at rate 1 are exact and never change.
 */
export function baseRoundingFix(lines: readonly FxLine[]): RoundingFix | null {
  let baseDebit = new Decimal(0);
  let baseCredit = new Decimal(0);
  const byCurrency = new Map<string, { rate: string; debit: Decimal; credit: Decimal }>();
  for (const line of lines) {
    baseDebit = baseDebit.plus(line.baseDebit);
    baseCredit = baseCredit.plus(line.baseCredit);
    const group = byCurrency.get(line.currency);
    if (group === undefined) {
      byCurrency.set(line.currency, {
        rate: line.fxRate,
        debit: new Decimal(line.debit),
        credit: new Decimal(line.credit),
      });
    } else {
      if (!new Decimal(group.rate).eq(line.fxRate)) return null; // two rates: not rounding
      group.debit = group.debit.plus(line.debit);
      group.credit = group.credit.plus(line.credit);
    }
  }
  if (baseDebit.eq(baseCredit)) return null;
  for (const group of byCurrency.values()) {
    if (!group.debit.eq(group.credit)) return null; // does not balance in its own currency
  }
  // Rounding of n lines is at most n x 0.00005; anything larger is not rounding.
  const diff = baseDebit.minus(baseCredit);
  if (diff.abs().gt(new Decimal('0.00005').times(lines.length))) return null;
  const side: 'debit' | 'credit' = diff.isNegative() ? 'debit' : 'credit';
  let index = -1;
  let largest = new Decimal(-1);
  lines.forEach((line, i) => {
    // A line at rate 1 (a base-currency line) is exact and keeps base = amount.
    if (new Decimal(line.fxRate).eq(1)) return;
    const base = new Decimal(side === 'debit' ? line.baseDebit : line.baseCredit);
    if (base.gt(0) && base.gt(largest)) {
      largest = base;
      index = i;
    }
  });
  if (index < 0) return null;
  return { index, side, delta: diff.abs().toFixed(4) };
}

/* --------------------------------------------------------------------------------------
 * Manual journals (PLAN 3.9 `manual_journal`): drafts an accountant prepares, posted later
 * through the posting service. A draft may be unbalanced while it is being written; posting
 * runs every check.
 * ------------------------------------------------------------------------------------ */

export const MANUAL_JOURNAL_STATUSES = ['draft', 'submitted', 'posted'] as const;
export type ManualJournalStatus = (typeof MANUAL_JOURNAL_STATUSES)[number];

/** Debit or credit amount as typed: positive, at most 14 integer digits and 4 decimals. */
export const journalAmountSchema = z
  .string()
  .regex(/^\d{1,14}(\.\d{1,4})?$/, 'A positive amount with at most 4 decimals.')
  .refine((text) => /[1-9]/.test(text), 'The amount must be above zero.');

export const manualJournalLineSchema = z
  .strictObject({
    accountCode: accountCodeSchema,
    debit: journalAmountSchema.optional(),
    credit: journalAmountSchema.optional(),
    /** Base currency when left out. */
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    /** The rate of the entry day from the exchange rates when left out. */
    fxRate: exchangeRateValueSchema.optional(),
    dimensions: z.partialRecord(z.enum(LEDGER_DIMENSIONS), z.uuid()).optional(),
    taxCode: taxCodeCodeSchema.optional(),
    memo: z.string().trim().max(500).optional(),
  })
  .refine((line) => (line.debit === undefined) !== (line.credit === undefined), {
    message: 'Give a debit or a credit, not both.',
  });
export type ManualJournalLine = z.infer<typeof manualJournalLineSchema>;

export const manualJournalLinesSchema = z.array(manualJournalLineSchema).max(500);
