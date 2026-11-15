/**
 * Numbering patterns (PLAN 3.1 `number_sequence`, SPEC 2.12).
 * Purpose: one definition of what a numbering pattern such as `L{0000}` or
 * `INV-{YYYY}-{00000}` means, used by the API when it allocates a number and by the web
 * settings screen to validate the form and show a live sample. The API's own router copies
 * the field rules with OpenAPI metadata; the rules there must match these.
 *
 * Tokens inside braces; everything else is literal text:
 *   {0000}    the running number, padded to the number of zeros (1 to 12)
 *   {number}  the running number, padded to the sequence's `padding` column
 *   {prefix}  the sequence's `prefix` column
 *   {YYYY} {YY} {MM}  year and month of the allocation date
 * Exactly one running-number token is required. A sequence that resets every year must
 * carry a year token, and one that resets every month a year and a month token; otherwise
 * the same number would be given out twice, which SPEC 2.12 forbids.
 *
 * Depends on: zod. Used by: apps/api kernel/numbering, apps/web organisation screens.
 */
import { z } from 'zod';

export const RESET_POLICIES = ['never', 'yearly', 'monthly'] as const;
export type ResetPolicy = (typeof RESET_POLICIES)[number];

export type PatternToken =
  | { kind: 'text'; text: string }
  | { kind: 'prefix' }
  | { kind: 'number'; padding: number | null }
  | { kind: 'year'; digits: 2 | 4 }
  | { kind: 'month' };

export const MAX_PADDING = 12;

/** Why a pattern is unusable, as a message for the form or the API. */
export class PatternError extends Error {}

/**
 * Splits a pattern into tokens, refusing anything the allocator could not render.
 * The checks are strict on purpose: a pattern is set once and then every number of a
 * loan or invoice depends on it.
 */
export function parsePattern(pattern: string): PatternToken[] {
  const tokens: PatternToken[] = [];
  let text = '';
  let numberTokens = 0;
  for (let i = 0; i < pattern.length;) {
    const ch = pattern.charAt(i);
    if (ch === '}') throw new PatternError(`Unexpected "}" at position ${String(i + 1)}`);
    if (ch !== '{') {
      text += ch;
      i += 1;
      continue;
    }
    const end = pattern.indexOf('}', i);
    if (end < 0) throw new PatternError(`"{" at position ${String(i + 1)} is never closed`);
    const name = pattern.slice(i + 1, end);
    if (name.includes('{'))
      throw new PatternError(`"{" at position ${String(i + 1)} is never closed`);
    if (text !== '') {
      tokens.push({ kind: 'text', text });
      text = '';
    }
    if (name === 'prefix') tokens.push({ kind: 'prefix' });
    else if (name === 'number') {
      tokens.push({ kind: 'number', padding: null });
      numberTokens += 1;
    } else if (/^0+$/.test(name)) {
      if (name.length > MAX_PADDING) {
        throw new PatternError(`At most ${String(MAX_PADDING)} digits in the running number`);
      }
      tokens.push({ kind: 'number', padding: name.length });
      numberTokens += 1;
    } else if (name === 'YYYY') tokens.push({ kind: 'year', digits: 4 });
    else if (name === 'YY') tokens.push({ kind: 'year', digits: 2 });
    else if (name === 'MM') tokens.push({ kind: 'month' });
    else throw new PatternError(`Unknown token {${name}}`);
    i = end + 1;
  }
  if (text !== '') tokens.push({ kind: 'text', text });
  if (numberTokens !== 1) {
    throw new PatternError('The pattern needs exactly one running number, e.g. {0000}');
  }
  return tokens;
}

/**
 * The message explaining why `pattern` cannot be used with `resetPolicy`, or null when it
 * can. Combines the syntax check with the reset rule (see the header).
 */
export function patternProblem(pattern: string, resetPolicy: ResetPolicy): string | null {
  let tokens: PatternToken[];
  try {
    tokens = parsePattern(pattern);
  } catch (err) {
    return err instanceof PatternError ? err.message : 'Invalid pattern';
  }
  const hasYear = tokens.some((t) => t.kind === 'year');
  const hasMonth = tokens.some((t) => t.kind === 'month');
  if (resetPolicy === 'yearly' && !hasYear) {
    return 'A sequence that restarts every year needs {YYYY} or {YY} in the pattern';
  }
  if (resetPolicy === 'monthly' && !(hasYear && hasMonth)) {
    return 'A sequence that restarts every month needs a year token and {MM} in the pattern';
  }
  return null;
}

export interface RenderInput {
  prefix: string;
  /** Padding used by `{number}`; `{0000}` carries its own. */
  padding: number;
  /** The running number to show. */
  value: number | bigint;
  /** The allocation date, for the year and month tokens. */
  date: Date;
}

const pad = (n: number | bigint, width: number) => String(n).padStart(width, '0');

/** Renders one number from a pattern that `parsePattern` accepts. */
export function renderNumber(pattern: string, input: RenderInput): string {
  return parsePattern(pattern)
    .map((token) => {
      switch (token.kind) {
        case 'text':
          return token.text;
        case 'prefix':
          return input.prefix;
        case 'number':
          return pad(input.value, token.padding ?? input.padding);
        case 'year': {
          const year = pad(input.date.getUTCFullYear(), 4);
          return token.digits === 4 ? year : year.slice(2);
        }
        case 'month':
          return pad(input.date.getUTCMonth() + 1, 2);
      }
    })
    .join('');
}

/**
 * The reset period a date falls in under a policy: '' when the sequence never resets,
 * otherwise the UTC year or year-month. Two dates in the same period share the count.
 */
export function resetPeriod(resetPolicy: ResetPolicy, date: Date): string {
  if (resetPolicy === 'never') return '';
  const year = pad(date.getUTCFullYear(), 4);
  return resetPolicy === 'yearly' ? year : `${year}-${pad(date.getUTCMonth() + 1, 2)}`;
}

// ---- Form schema (web) ------------------------------------------------------------------
export const sequenceKeyPattern = /^[a-z][a-z0-9_]{0,49}$/;
/** Numbers arrive from text inputs, so they are coerced here; the API takes JSON numbers. */
const numberSequenceFormFields = {
  key: z
    .string()
    .trim()
    .regex(sequenceKeyPattern, { message: 'Lower-case letters, digits and _, up to 50' }),
  // An empty prefix box is "no prefix", not a missing field.
  prefix: z.string().trim().max(20).default(''),
  format: z.string().trim().min(1).max(100),
  padding: z.coerce.number().int().min(1).max(MAX_PADDING),
  resetPolicy: z.enum(RESET_POLICIES),
  nextValue: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
};
const checkPattern = (
  v: { format: string; resetPolicy: ResetPolicy },
  ctx: z.RefinementCtx,
): void => {
  const problem = patternProblem(v.format, v.resetPolicy);
  if (problem !== null) ctx.addIssue({ code: 'custom', path: ['format'], message: problem });
};
export const numberSequenceFormSchema = z
  .strictObject(numberSequenceFormFields)
  .superRefine(checkPattern);
export type NumberSequenceForm = z.infer<typeof numberSequenceFormSchema>;
