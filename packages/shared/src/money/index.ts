/**
 * Money helpers shared by the API and the web app.
 *
 * Purpose: every amount in Fibrex is an exact decimal with a currency code (SPEC 2.9, CLAUDE.md
 * "NUMERIC(18,4) with a currency code"). JavaScript numbers are binary floating point and
 * cannot represent 0.1 exactly, so they are never used for money. All arithmetic goes through
 * a decimal.js clone configured below.
 *
 * Rules implemented here:
 *   - Stored scale is 4 decimal places and the database column is NUMERIC(18,4), so the
 *     absolute value must stay below 10^14. Values outside that range are rejected, not
 *     truncated.
 *   - `money()` refuses more than 4 decimal places. Rounding is never implicit: callers that
 *     multiply (rates, percentages, FX) get an explicitly rounded result (half-up, the usual
 *     commercial rule), and the rounding point is visible in their code.
 *   - Two amounts in different currencies are never added or compared; conversion is
 *     explicit through `convert()` with a recorded rate.
 *   - `allocate()` splits an amount into parts that always sum exactly to the total
 *     (largest-remainder method). Used later for pro-rated accommodation cost (SPEC 5.4) and
 *     payment splits (SPEC 4.6, 5.9).
 *
 * Depends on: decimal.js, zod.
 * Used by: apps/api (ledger, loans, payroll ...), apps/web (display and form validation).
 */
import { Decimal as DecimalLib } from 'decimal.js';
import { z } from 'zod';

/** Decimal constructor with enough precision for any NUMERIC(18,4) arithmetic. */
export const Decimal = DecimalLib.clone({
  precision: 40,
  rounding: DecimalLib.ROUND_HALF_UP,
  toExpNeg: -40,
  toExpPos: 40,
});
export type Decimal = InstanceType<typeof Decimal>;
export type DecimalInput = Decimal | string | number;

/** Decimal places stored in the database (NUMERIC(18,4)). */
export const STORAGE_SCALE = 4;
/** NUMERIC(18,4) leaves 14 digits before the decimal point. */
const MAX_ABS_EXCLUSIVE = new Decimal(10).pow(18 - STORAGE_SCALE);

export class CurrencyMismatchError extends Error {
  constructor(a: string, b: string) {
    super(`Currency mismatch: ${a} and ${b} cannot be combined without conversion`);
    this.name = 'CurrencyMismatchError';
  }
}

export class MoneyRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyRangeError';
  }
}

/** ISO 4217 alphabetic code, for example QAR or BDT. */
export const currencyCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/, 'Currency must be a 3-letter ISO code');

/** Decimal transported as a string: up to 14 integer digits and up to 4 decimals. */
export const decimalStringSchema = z
  .string()
  .regex(/^-?\d{1,14}(\.\d{1,4})?$/, 'Amount must have at most 14 digits and 4 decimal places');

export const moneySchema = z.object({
  amount: decimalStringSchema,
  currency: currencyCodeSchema,
});

/**
 * An immutable amount. `amount` is always a normalised string with exactly 4 decimals
 * (for example "1250.5000"), which is also how PostgreSQL returns NUMERIC(18,4).
 */
export interface Money {
  readonly amount: string;
  readonly currency: string;
}

function assertInRange(d: Decimal): void {
  if (!d.isFinite()) throw new MoneyRangeError('Amount must be a finite number');
  if (d.abs().gte(MAX_ABS_EXCLUSIVE)) {
    throw new MoneyRangeError(`Amount ${d.toFixed()} exceeds NUMERIC(18,4)`);
  }
}

function make(d: Decimal, currency: string): Money {
  assertInRange(d);
  // toFixed(4) on a value that already has <= 4 decimals only pads with zeros.
  // Negative zero is normalised so "-0.0000" never appears.
  const fixed = d.isZero() ? '0.0000' : d.toFixed(STORAGE_SCALE);
  return Object.freeze({ amount: fixed, currency });
}

/**
 * Creates a Money value. Throws if the amount has more than 4 decimal places, so precision
 * is never lost silently. Use `roundToScale()` first when rounding is intended.
 */
export function money(amount: DecimalInput, currency: string): Money {
  currencyCodeSchema.parse(currency);
  const d = new Decimal(amount);
  if (d.decimalPlaces() > STORAGE_SCALE) {
    throw new MoneyRangeError(
      `Amount ${d.toFixed()} has more than ${STORAGE_SCALE} decimal places; round it explicitly`,
    );
  }
  return make(d, currency);
}

/** Rounds half-up to the given number of decimals (default: storage scale). */
export function roundToScale(value: DecimalInput, scale: number = STORAGE_SCALE): Decimal {
  return new Decimal(value).toDecimalPlaces(scale, Decimal.ROUND_HALF_UP);
}

export function zero(currency: string): Money {
  return money(0, currency);
}

export function toDecimal(m: Money): Decimal {
  return new Decimal(m.amount);
}

function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}

export function add(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return make(toDecimal(a).plus(toDecimal(b)), a.currency);
}

export function subtract(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return make(toDecimal(a).minus(toDecimal(b)), a.currency);
}

export function negate(a: Money): Money {
  return make(toDecimal(a).negated(), a.currency);
}

/**
 * Multiplies by a factor (quantity, rate, percentage as a fraction) and rounds half-up to
 * the storage scale. Example: 37 orders x 10.5 QAR = 388.5000 QAR.
 */
export function multiply(a: Money, factor: DecimalInput): Money {
  return make(roundToScale(toDecimal(a).times(new Decimal(factor))), a.currency);
}

/** Sums a list; the currency is required so an empty list still has one. */
export function sum(items: readonly Money[], currency: string): Money {
  let total = new Decimal(0);
  for (const m of items) {
    if (m.currency !== currency) throw new CurrencyMismatchError(currency, m.currency);
    total = total.plus(m.amount);
  }
  return make(total, currency);
}

/** -1, 0 or 1. */
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  sameCurrency(a, b);
  return toDecimal(a).comparedTo(toDecimal(b)) as -1 | 0 | 1;
}

export function isZero(a: Money): boolean {
  return toDecimal(a).isZero();
}

export function isNegative(a: Money): boolean {
  return toDecimal(a).isNegative() && !toDecimal(a).isZero();
}

/**
 * Converts to another currency with a recorded rate (units of `toCurrency` per one unit of
 * the source), rounded half-up to the storage scale. The caller stores the rate next to the
 * converted amount (SPEC 2.9: amount, currency, exchange rate and base amount).
 */
export function convert(a: Money, rate: DecimalInput, toCurrency: string): Money {
  currencyCodeSchema.parse(toCurrency);
  const r = new Decimal(rate);
  if (!r.isFinite() || r.lte(0)) throw new MoneyRangeError('Exchange rate must be positive');
  return make(roundToScale(toDecimal(a).times(r)), toCurrency);
}

/**
 * Splits `total` into parts proportional to `weights`, at the given scale (default 2, the
 * minor unit of QAR), so that the parts add up to exactly `total`.
 *
 * Why largest remainder: rounding each share independently can leave the sum one unit off
 * (three people sharing 100.00 would get 33.33 each = 99.99). Instead we:
 *   1. compute each exact share and round it DOWN (towards zero) to the scale;
 *   2. work out how many smallest units are still missing;
 *   3. give one unit each to the shares with the largest discarded remainders, ties going
 *      to the earlier position so the result is deterministic.
 * Negative totals are handled by allocating the absolute value and negating the parts.
 */
export function allocate(total: Money, weights: readonly DecimalInput[], scale = 2): Money[] {
  if (weights.length === 0) throw new MoneyRangeError('allocate() needs at least one weight');
  const w = weights.map((x) => new Decimal(x));
  if (w.some((x) => x.isNegative())) throw new MoneyRangeError('Weights cannot be negative');
  const weightSum = w.reduce((s, x) => s.plus(x), new Decimal(0));
  if (weightSum.isZero()) throw new MoneyRangeError('Weights must not all be zero');

  const totalD = toDecimal(total);
  if (totalD.decimalPlaces() > scale) {
    throw new MoneyRangeError(`Total ${total.amount} has more than ${scale} decimal places`);
  }
  const sign = totalD.isNegative() ? -1 : 1;
  const abs = totalD.abs();
  const unit = new Decimal(10).pow(-scale);

  // Step 1: exact shares, floored to the scale.
  const exact = w.map((x) => abs.times(x).dividedBy(weightSum));
  const floored = exact.map((e) => e.toDecimalPlaces(scale, Decimal.ROUND_DOWN));
  // Step 2: units still missing (always a whole number between 0 and the number of parts).
  const allocated = floored.reduce((s, x) => s.plus(x), new Decimal(0));
  let missingUnits = abs.minus(allocated).dividedBy(unit).toNumber();
  // Step 3: largest remainders first; stable on ties.
  const order = exact
    .map((e, i) => ({ i, remainder: e.minus(floored[i] ?? 0) }))
    .sort((a, b) => b.remainder.comparedTo(a.remainder) || a.i - b.i);
  const parts = [...floored];
  for (const { i } of order) {
    if (missingUnits <= 0) break;
    parts[i] = (parts[i] ?? new Decimal(0)).plus(unit);
    missingUnits -= 1;
  }
  return parts.map((p) => make(p.times(sign), total.currency));
}

/** Formats for display with the currency's minor units (QAR: 2). Never use for storage. */
export function formatAmount(a: Money, minorUnits = 2): string {
  return roundToScale(toDecimal(a), minorUnits).toFixed(minorUnits);
}
