/**
 * Posting rules and journal lines: shapes and pure checks shared by the API (modules/gl
 * posting service, row 2.15a) and the ledger screens (row 2.16).
 *
 * A posting rule says how one business event (for example `loan.disbursed`) becomes journal
 * lines, as data (SPEC 2.6, PLAN 3.9). Each rule line has:
 *   side        debit or credit
 *   account     an account resolver (below), giving an account CODE of the company's chart
 *   amount      a CEL formula over the rule's inputs returning a decimal (packages/formula)
 *   dimensions  ledger dimension -> name of a rule input holding that dimension's id
 *   taxCode     optional tax code; the company's default tax code otherwise
 *   memo        optional fixed text copied to the line
 *
 * Account resolvers (why three: the account is either always the same, chosen by the
 * caller, or chosen from a small table by a value of the event):
 *   {kind: 'fixed', code}                     always this account
 *   {kind: 'input', input}                    the code the event passes in that input
 *   {kind: 'map', input, map, default?}       map[value of input], else default, else error
 *
 * Depends on: zod, ./index (LEDGER_DIMENSIONS, accountCodeSchema, taxCodeCodeSchema),
 * ../formulas (input schema), ../money (Decimal). Used by: apps/api modules/gl.
 */
import { z } from 'zod';
import { formulaInputNameSchema, formulaInputSchemaSchema } from '../formulas/index.js';
import { Decimal } from '../money/index.js';
import {
  accountCodeSchema,
  LEDGER_DIMENSIONS,
  taxCodeCodeSchema,
  type LedgerDimension,
} from './index.js';

export const POSTING_RULE_STATUSES = ['draft', 'active', 'retired'] as const;
export type PostingRuleStatus = (typeof POSTING_RULE_STATUSES)[number];

/** Event keys look like outbox event types: `loan.disbursed`, `payroll.run.posted`. */
export const postingEventKeySchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/,
    'Use lower-case words joined by dots, for example loan.disbursed.',
  )
  .max(100);

export const accountResolverSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('fixed'), code: accountCodeSchema }),
  z.strictObject({ kind: z.literal('input'), input: formulaInputNameSchema }),
  z.strictObject({
    kind: z.literal('map'),
    input: formulaInputNameSchema,
    map: z
      .record(z.string().min(1).max(100), accountCodeSchema)
      .refine((m) => Object.keys(m).length >= 1 && Object.keys(m).length <= 100, {
        message: 'A map needs 1 to 100 entries.',
      }),
    default: accountCodeSchema.optional(),
  }),
]);
export type AccountResolver = z.infer<typeof accountResolverSchema>;

export const postingRuleLineSchema = z.strictObject({
  side: z.enum(['debit', 'credit']),
  account: accountResolverSchema,
  amount: z.string().trim().min(1).max(2000),
  dimensions: z.partialRecord(z.enum(LEDGER_DIMENSIONS), formulaInputNameSchema).optional(),
  taxCode: taxCodeCodeSchema.optional(),
  memo: z.string().trim().min(1).max(200).optional(),
});
export type PostingRuleLine = z.infer<typeof postingRuleLineSchema>;

/** 2 to 50 lines with at least one on each side (a journal always has both). */
export const postingRuleLinesSchema = z
  .array(postingRuleLineSchema)
  .min(2)
  .max(50)
  .refine(
    (lines) => lines.some((l) => l.side === 'debit') && lines.some((l) => l.side === 'credit'),
    'A posting rule needs at least one debit line and one credit line.',
  );

export const postingRuleInputSchemaSchema = formulaInputSchemaSchema;

/** Journal-line field (API/Prisma name) that holds each ledger dimension. */
export const DIMENSION_FIELDS: Record<LedgerDimension, string> = {
  party: 'partyId',
  employee: 'employeePartyId',
  vehicle: 'vehicleId',
  client_platform: 'clientPlatformId',
  branch: 'branchId',
  cost_centre: 'costCentreId',
  pay_period: 'payPeriodId',
  loan: 'loanId',
};

export interface RuleInputProblem {
  path: string;
  message: string;
}

/**
 * Inputs a rule's resolvers and dimension mappings read must be declared, as text (an
 * account code or an id). Amount formulas are checked separately by compiling them.
 */
export function ruleInputProblems(
  lines: readonly PostingRuleLine[],
  inputSchema: Record<string, { type: string }>,
): RuleInputProblem[] {
  const problems: RuleInputProblem[] = [];
  const needText = (name: string, path: string) => {
    const field = inputSchema[name];
    if (field === undefined) {
      problems.push({ path, message: `Input "${name}" is not declared in the input schema.` });
    } else if (field.type !== 'string') {
      problems.push({ path, message: `Input "${name}" must be of type string.` });
    }
  };
  lines.forEach((line, i) => {
    if (line.account.kind !== 'fixed')
      needText(line.account.input, `lines.${String(i)}.account.input`);
    for (const [dim, input] of Object.entries(line.dimensions ?? {})) {
      needText(input, `lines.${String(i)}.dimensions.${dim}`);
    }
  });
  return problems;
}

/** Every account code a rule can post to (fixed, mapped and default), for existence checks. */
export function ruleAccountCodes(lines: readonly PostingRuleLine[]): string[] {
  const codes = new Set<string>();
  for (const { account } of lines) {
    if (account.kind === 'fixed') codes.add(account.code);
    if (account.kind === 'map') {
      for (const code of Object.values(account.map)) codes.add(code);
      if (account.default !== undefined) codes.add(account.default);
    }
  }
  return [...codes];
}

export class AccountResolveError extends Error {}

/** The account code a resolver gives for these inputs; throws AccountResolveError. */
export function resolveAccountCode(
  resolver: AccountResolver,
  inputs: Record<string, unknown>,
): string {
  if (resolver.kind === 'fixed') return resolver.code;
  const value = inputs[resolver.input];
  if (resolver.kind === 'input') {
    if (typeof value !== 'string' || !accountCodeSchema.safeParse(value).success) {
      throw new AccountResolveError(`Input "${resolver.input}" must be an account code.`);
    }
    return value;
  }
  const mapped =
    typeof value === 'string' && Object.hasOwn(resolver.map, value)
      ? resolver.map[value]
      : resolver.default;
  if (mapped === undefined) {
    throw new AccountResolveError(
      `No account is mapped for ${resolver.input} = ${JSON.stringify(value ?? null)} and the rule has no default.`,
    );
  }
  return mapped;
}

export interface SidedAmount {
  /** Decimal text; zero on the other side. */
  debit: string;
  credit: string;
}

/** Totals of both sides, exact (decimal.js), and whether they match and are above zero. */
export function journalTotals(lines: readonly SidedAmount[]): {
  debit: string;
  credit: string;
  balanced: boolean;
} {
  let debit = new Decimal(0);
  let credit = new Decimal(0);
  for (const line of lines) {
    debit = debit.plus(line.debit);
    credit = credit.plus(line.credit);
  }
  return {
    debit: debit.toFixed(4),
    credit: credit.toFixed(4),
    balanced: debit.eq(credit) && debit.gt(0),
  };
}

/** Same JSON for the same content, whatever the key order (for the rule checksum). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
