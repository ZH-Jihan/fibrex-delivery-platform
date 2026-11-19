/**
 * Calendar-date helpers and database-error mapping shared by the people routers.
 *
 * Purpose: the API speaks "2026-03-01"; `date` columns are Dates at midnight UTC. Exclusion
 * constraints (one placement, one employment period per day) reach us as driver errors and
 * become a clear 409 here.
 *
 * Depends on: kernel/http/errors.ts. Used by: ./employee-router.ts, ./placement-router.ts,
 * ./document-router.ts.
 */
import { ConflictError } from '../../kernel/http/errors.js';

/** "2026-03-01" -> Date for a `date` column. */
export function toDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** Date from a `date` column -> "2026-03-01". */
export function fromDate(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

/** Today as "2026-03-01" (UTC, as the database's current_date in this deployment). */
export function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Converts the named string fields of a body to Dates (null stays null). */
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

const OVERLAPS: Record<string, { code: string; detail: string }> = {
  employee_placement_no_overlap: {
    code: 'placement_overlap',
    detail: 'The employee already has a placement on these days. End the current one first.',
  },
  employment_period_no_overlap: {
    code: 'period_overlap',
    detail: 'The employee already has an employment period on these days.',
  },
  document_one_current: {
    code: 'document_exists',
    detail: 'This owner already has a current document of this type. Renew it instead.',
  },
};

/** Runs a write; an overlap of our exclusion constraints becomes 409, anything else is rethrown. */
export async function guardOverlap<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    const text = err instanceof Error ? `${err.message} ${JSON.stringify(err)}` : String(err);
    for (const [name, message] of Object.entries(OVERLAPS)) {
      if (text.includes(name)) throw new ConflictError(message.code, message.detail);
    }
    throw err;
  }
}
