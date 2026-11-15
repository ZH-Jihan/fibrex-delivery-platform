/**
 * Rate tables (PLAN 3.7 `rate_table`, `rate_table_row`; SPEC 2.10 effective dating).
 *
 * Purpose: the one description of a rate table, its rows, and the rule that picks the row
 * for a set of dimension values. The API uses it for `/rate-tables/:key/resolve` and for
 * `rate()` inside formulas; the web screen uses the schemas to check its forms and the same
 * rule to show which row would apply.
 *
 * Matching rule (business rule; why: one table holds a general rate and its exceptions):
 *   1. Only rows in force on the day are considered (valid_from <= day <= valid_to, open
 *      ended when valid_to is empty).
 *   2. A row's `dims` names some of the table's dimensions. A dimension the row leaves out
 *      matches any value ("all platforms"). A dimension the row names must equal the value
 *      asked for; if the caller did not give that dimension, the row does not match.
 *   3. Of the matching rows the most specific wins: the one naming the most dimensions.
 *      Between two rows naming as many, the one naming the dimension listed earlier in the
 *      table wins (dimensions are listed most important first), so the answer is never a
 *      tie. Two rows with the same dims and overlapping dates are refused by the database.
 *
 * Depends on: zod, ../money. Used by: apps/api kernel/rates and kernel/formulas, apps/web.
 */
import { z } from 'zod';
import { currencyCodeSchema, decimalStringSchema } from '../money/index.js';

export const rateTableKeySchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_.]{0,59}$/, 'lower-case letters, digits, _ and .');

export const rateDimensionNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, 'lower-case letters, digits and _');

export const rateDimensionsSchema = z
  .array(rateDimensionNameSchema)
  .max(8, 'at most 8 dimensions')
  .refine((list) => new Set(list).size === list.length, 'each dimension once');

/** Dimension values as stored on a row and as asked for: name -> value (text). */
export const rateDimsSchema = z
  .record(rateDimensionNameSchema, z.string().trim().min(1).max(100))
  .refine((dims) => Object.keys(dims).length <= 8, 'at most 8 dimensions');
export type RateDims = z.infer<typeof rateDimsSchema>;

export const rateValueSchema = decimalStringSchema;
export const rateCurrencySchema = currencyCodeSchema;

/** The web form for a rate table (also the API create body without its defaults). */
export const rateTableFormSchema = z.object({
  key: rateTableKeySchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  dimensions: rateDimensionsSchema,
});

/** The web form for a row. */
export const rateRowFormSchema = z.object({
  dims: rateDimsSchema,
  value: rateValueSchema,
  currency: rateCurrencySchema,
  validFrom: z.iso.date(),
  validTo: z.iso.date().optional(),
});

export interface RateCandidate {
  dims: Record<string, string>;
}

export type RatePick<T> =
  | { ok: true; row: T }
  | { ok: false; code: 'rate_unknown_dimension' | 'rate_not_found'; message: string };

/**
 * Rule 2 and 3 above. `rows` must already be the rows in force on the day (rule 1).
 * Returns the winning row, or why there is none.
 */
export function pickRateRow<T extends RateCandidate>(
  dimensions: readonly string[],
  rows: readonly T[],
  asked: Record<string, string>,
): RatePick<T> {
  const unknown = Object.keys(asked).filter((name) => !dimensions.includes(name));
  if (unknown.length > 0) {
    return {
      ok: false,
      code: 'rate_unknown_dimension',
      message: `This table has no dimension ${unknown.map((n) => `"${n}"`).join(', ')}.`,
    };
  }
  let best: { row: T; count: number; rank: number } | undefined;
  for (const row of rows) {
    const named = Object.entries(row.dims);
    if (!named.every(([name, value]) => asked[name] === value)) continue;
    // Rank: one bit per named dimension, the earliest dimension the highest bit.
    const rank = named.reduce(
      (sum, [name]) => sum + 2 ** (dimensions.length - 1 - dimensions.indexOf(name)),
      0,
    );
    if (
      best === undefined ||
      named.length > best.count ||
      (named.length === best.count && rank > best.rank)
    ) {
      best = { row, count: named.length, rank };
    }
  }
  if (best === undefined) {
    const shown = Object.entries(asked)
      .map(([name, value]) => `${name}=${value}`)
      .join(', ');
    return {
      ok: false,
      code: 'rate_not_found',
      message: `No rate in force for ${shown === '' ? 'these values' : shown}.`,
    };
  }
  return { ok: true, row: best.row };
}
