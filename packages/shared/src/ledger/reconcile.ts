/**
 * Bank reconciliation: shared rules (phase 2 row 2.17b; PLAN 3.9).
 *
 * Purpose: what a match rule's conditions look like and how one decides whether a statement
 * line satisfies them; the request bodies of rules and manual matches. Pure functions (no
 * database, no clock) so the API and the screens agree. The conditions are data the user
 * edits (SPEC 2.6): a new bank's wording never needs code.
 *
 * Money rules (SPEC 2.9): amounts are decimal strings compared with Decimal, never floats. A
 * statement line is signed from the company's point of view (money in > 0), so "direction"
 * and the amount range use the sign and the absolute value respectively.
 *
 * Depends on: zod, ../money (Decimal). Used by: apps/api modules/gl (reconcile-router.ts) and
 * the reconciliation screens.
 */
import { z } from 'zod';
import { Decimal } from '../money/index.js';

/** The widest date gap (days) between a statement line and its ledger entry. */
export const MAX_MATCH_WINDOW_DAYS = 30;
/** The gap used when a rule or the default pass does not say. */
export const DEFAULT_MATCH_WINDOW_DAYS = 3;

const positiveAmount = z
  .string()
  .regex(/^\d{1,14}(\.\d{1,4})?$/, 'Enter an amount with at most 4 decimals.');

/**
 * What a statement line must look like for a rule to apply. Every field is optional; all
 * fields that are given must hold (AND). `textContains` looks in the reference and the
 * description, ignoring case.
 */
export const matchConditionsSchema = z
  .strictObject({
    direction: z.enum(['in', 'out']).optional(),
    textContains: z.string().trim().min(1).max(200).optional(),
    referenceEquals: z.string().trim().min(1).max(200).optional(),
    amountMin: positiveAmount.optional(),
    amountMax: positiveAmount.optional(),
    dateWindowDays: z.number().int().min(0).max(MAX_MATCH_WINDOW_DAYS).optional(),
  })
  .refine(
    (c) =>
      c.amountMin === undefined ||
      c.amountMax === undefined ||
      new Decimal(c.amountMin).lte(c.amountMax),
    { message: 'The smallest amount cannot be more than the largest.', path: ['amountMin'] },
  );
export type MatchConditions = z.infer<typeof matchConditionsSchema>;

/** The parts of a statement line a rule looks at. */
export interface MatchableLine {
  /** Signed decimal string, money in > 0. */
  amount: string;
  reference: string | null;
  description: string | null;
}

/** Whether every given condition holds for the line. An empty condition set holds for all. */
export function lineSatisfiesConditions(line: MatchableLine, conditions: MatchConditions): boolean {
  const amount = new Decimal(line.amount);
  if (conditions.direction === 'in' && !amount.isPositive()) return false;
  if (conditions.direction === 'out' && amount.isPositive()) return false;
  const size = amount.abs();
  if (conditions.amountMin !== undefined && size.lt(conditions.amountMin)) return false;
  if (conditions.amountMax !== undefined && size.gt(conditions.amountMax)) return false;
  if (conditions.referenceEquals !== undefined) {
    if ((line.reference ?? '').trim().toLowerCase() !== conditions.referenceEquals.toLowerCase()) {
      return false;
    }
  }
  if (conditions.textContains !== undefined) {
    const needle = conditions.textContains.toLowerCase();
    const haystack = `${line.reference ?? ''}\n${line.description ?? ''}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

/** The date window a rule uses (the default when it does not say). */
export function windowDaysOf(conditions: MatchConditions | null): number {
  return conditions?.dateWindowDays ?? DEFAULT_MATCH_WINDOW_DAYS;
}

/** Whole days between two ISO dates (absolute). */
export function daysBetween(a: string, b: string): number {
  const ms = Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`));
  return Math.round(ms / 86_400_000);
}

const ruleName = z.string().trim().min(1).max(200);

export const bankMatchRuleCreateSchema = z.strictObject({
  name: ruleName,
  conditions: matchConditionsSchema.default({}),
  targetAccountId: z.uuid().nullable().default(null),
  targetPartyId: z.uuid().nullable().default(null),
  priority: z.number().int().min(0).max(9999).default(100),
  active: z.boolean().default(true),
});
export const bankMatchRuleUpdateSchema = z
  .strictObject({
    name: ruleName,
    conditions: matchConditionsSchema,
    targetAccountId: z.uuid().nullable(),
    targetPartyId: z.uuid().nullable(),
    priority: z.number().int().min(0).max(9999),
    active: z.boolean(),
  })
  .partial();

/** A manual match: one statement line, one ledger line. The amount is always the whole line. */
export const reconciliationMatchCreateSchema = z.strictObject({
  statementLineId: z.uuid(),
  journalLineId: z.uuid(),
});
/** Matches never change; unmatch (delete with a reason) and match again. */
export const reconciliationMatchUpdateSchema = z.strictObject({});

export const matchCandidatesQuerySchema = z.object({
  windowDays: z.coerce.number().int().min(0).max(MAX_MATCH_WINDOW_DAYS).optional(),
});
