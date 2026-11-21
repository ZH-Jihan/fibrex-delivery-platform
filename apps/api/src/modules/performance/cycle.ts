/**
 * Performance cycles of a client platform (phase 4 row 4.2; plan sections 2 and 9).
 *
 * Purpose: a platform's performance "month" starts on its `cycle_start_day` (Snoonu: the
 * 26th, so a cycle runs 26 Oct to 25 Nov). Snoonu's day blocks are titled only with a day of
 * the month ("26th of the month"), with no month name, so a block can be dated only by
 * knowing which cycle the sheet shows. These helpers do that date arithmetic.
 *
 * Dates are plain `YYYY-MM-DD` strings (business dates in Asia/Qatar); the arithmetic is done
 * in UTC so no time zone or daylight saving shift can move a date.
 *
 * Depends on: nothing. Used by: ./snoonu-parser.ts, the sync engine (row 4.3), reports (4.6).
 */

export interface Cycle {
  /** First day of the cycle, inclusive. */
  start: string;
  /** Last day of the cycle, inclusive. */
  end: string;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function toUtc(date: string): Date {
  const match = ISO_DATE.exec(date);
  if (match === null) throw new Error(`Not a YYYY-MM-DD date: ${date}`);
  const value = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (value.toISOString().slice(0, 10) !== date) throw new Error(`Not a real date: ${date}`);
  return value;
}

function fromParts(year: number, monthIndex: number, day: number): string {
  return new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** `date` moved by `days` (negative goes back). */
export function addDays(date: string, days: number): string {
  const value = toUtc(date);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function checkStartDay(startDay: number): void {
  // Same rule as the database check on client_platform: a day every month has.
  if (!Number.isInteger(startDay) || startDay < 1 || startDay > 28) {
    throw new Error(`cycle_start_day must be 1 to 28, got ${startDay}`);
  }
}

/** The cycle that contains `date`. With start day 26: 2026-11-20 -> 2026-10-26 .. 2026-11-25. */
export function cycleContaining(date: string, startDay: number): Cycle {
  checkStartDay(startDay);
  const value = toUtc(date);
  const year = value.getUTCFullYear();
  let month = value.getUTCMonth();
  // Before the start day we are still in the cycle that began last month.
  if (value.getUTCDate() < startDay) month -= 1;
  const start = fromParts(year, month, startDay);
  // The cycle ends the day before the same start day next month.
  const end = addDays(fromParts(year, month + 1, startDay), -1);
  return { start, end };
}

/**
 * The date a day block titled with `dayOfMonth` stands for inside `cycle`, or null when the
 * cycle has no such day (the 31st block in a cycle whose first month has 30 days, the 29th to
 * 31st of February ...).
 *
 * Rule (owner answer 2026-11-21): days from the start day to the end of the first month
 * belong to the first month; days before the start day belong to the following month.
 * Cycle 26 Oct to 25 Nov: block 26 is 26 Oct, block 31 is 31 Oct, block 1 is 1 Nov.
 */
export function blockDate(cycle: Cycle, startDay: number, dayOfMonth: number): string | null {
  checkStartDay(startDay);
  if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) return null;
  const start = toUtc(cycle.start);
  const year = start.getUTCFullYear();
  const month = dayOfMonth >= startDay ? start.getUTCMonth() : start.getUTCMonth() + 1;
  // Normalise a December + 1 into January of the next year before checking the length.
  const first = new Date(Date.UTC(year, month, 1));
  if (dayOfMonth > daysInMonth(first.getUTCFullYear(), first.getUTCMonth())) return null;
  return fromParts(first.getUTCFullYear(), first.getUTCMonth(), dayOfMonth);
}
