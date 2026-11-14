/**
 * Small helpers shared by the party routers.
 *
 * Purpose: one place for the date and database-error handling every party resource needs,
 * so each router stays about its own rules.
 *
 * Depends on: kernel/http/errors.ts. Used by: every router in this module.
 */
import { ConflictError } from '../../kernel/http/errors.js';

/** "2026-03-01" (the API form of a calendar date) -> Date for a `date` column. */
export function toDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** Date from a `date` column -> "2026-03-01". */
export function fromDate(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

/** Converts the named string fields of a request body to Dates (null stays null). */
export function withDates(
  data: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const out = { ...data };
  for (const key of keys) {
    const value = out[key];
    if (typeof value === 'string') out[key] = toDate(value);
  }
  return out;
}

/** Database constraints that mean "someone else already holds this", with the message to show. */
const EXCLUSION_MESSAGES: Record<string, { code: string; detail: string }> = {
  party_identifier_no_overlap: {
    code: 'identifier_in_use',
    detail: 'Another person holds this identifier in an overlapping period.',
  },
  party_role_no_overlap: {
    code: 'role_overlap',
    detail: 'This person already has this role in an overlapping period.',
  },
};

/**
 * Exclusion-constraint violations reach us as a generic driver error. Recognise ours by
 * constraint name and answer 409; anything else is rethrown untouched.
 */
export function mapExclusionError(err: unknown): unknown {
  const text = err instanceof Error ? `${err.message} ${JSON.stringify(err)}` : String(err);
  for (const [name, message] of Object.entries(EXCLUSION_MESSAGES)) {
    if (text.includes(name)) return new ConflictError(message.code, message.detail);
  }
  return err;
}

export async function guardExclusion<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw mapExclusionError(err);
  }
}
