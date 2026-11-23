/**
 * Day off of a person, and what it means for "no orders" (phase 4 row 4.8d). Pure functions,
 * no database, unit-tested. This is the only place that reads the sheet's day-off text and the
 * only place that decides whether a zero-order day is a problem.
 *
 * Two dates are involved on the call sheet, and they must never be mixed up:
 *   - the figures date: the day the orders and hours are from (the day before the call date);
 *   - the call date: the day the sheet is for ("today").
 * A person can have the day off on either, both or neither, so each date is checked on its own.
 *
 * Rules, and why:
 *   1. The sheet's "Day off" cell is weekday words ("Friday", "Fri", "Fri, Sat", "Tues"). Any
 *      other text ("Not updated", "Rotation B", empty) names no weekday, so the person has no
 *      known day off and nothing is marked: a wrong "day off" mark would hide a real problem
 *      (a rider with no orders who was meant to work).
 *   2. The weekday of a date is the weekday of the calendar date itself (UTC arithmetic on
 *      `YYYY-MM-DD`), so month and year boundaries need no special case.
 *   3. A zero-order day is a problem only when the platform reported the day, and the person
 *      did not have the day off. On their day off, no orders is expected, so it is neither
 *      flagged, nor counted, nor part of a "no orders in a row" run (a day off breaks the run).
 *   4. The same function is used by the call sheet (rows, strip, filter, cross-check), the
 *      Top and bottom report, the cycle summary and the daily summary email, so the screen, the
 *      reports and the email never disagree.
 *
 * Depends on: nothing. Used by: ./sheet-details.ts, ./report-calc.ts, ./summary-calc.ts,
 * ./summary-service.ts, ./performance-reports.ts, ../tracking/*.
 */

const WEEKDAY_WORDS: readonly (readonly string[])[] = [
  ['sun', 'sunday'],
  ['mon', 'monday'],
  ['tue', 'tues', 'tuesday'],
  ['wed', 'wednesday'],
  ['thu', 'thur', 'thurs', 'thursday'],
  ['fri', 'friday'],
  ['sat', 'saturday'],
];

/** Weekday numbers (0 = Sunday) named in `text` ("Fri", "Friday, Saturday"); none otherwise (rule 1). */
export function parseWeekdays(text: string | null | undefined): number[] {
  if (text === null || text === undefined) return [];
  const found = new Set<number>();
  for (const word of text.toLowerCase().split(/[^a-z]+/)) {
    if (word === '') continue;
    const index = WEEKDAY_WORDS.findIndex((names) => names.includes(word));
    if (index >= 0) found.add(index);
  }
  return [...found].sort((a, b) => a - b);
}

/** Weekday number (0 = Sunday) of a calendar date `YYYY-MM-DD` (rule 2). */
export const weekdayOf = (date: string): number => new Date(`${date}T00:00:00.000Z`).getUTCDay();

/** Whether the day-off text names the weekday of `date`. */
export function isDayOffOn(dayOffText: string | null | undefined, date: string): boolean {
  return parseWeekdays(dayOffText).includes(weekdayOf(date));
}

/** The day-off flags of one person for the two dates of a call sheet. */
export interface DayOffFlags {
  onFiguresDate: boolean;
  onCallDate: boolean;
}

export function dayOffFlags(
  dayOffText: string | null | undefined,
  figuresDate: string,
  callDate: string,
): DayOffFlags {
  const weekdays = parseWeekdays(dayOffText);
  return {
    onFiguresDate: weekdays.includes(weekdayOf(figuresDate)),
    onCallDate: weekdays.includes(weekdayOf(callDate)),
  };
}

/**
 * Rule 3: is "no orders" on a date a problem? Only on a reported day, with orders at zero (a
 * person the sheet has no row for delivered nothing), and not on the person's day off.
 */
export function isZeroOrderProblem(
  orders: number | null,
  reported: boolean,
  dayOff: boolean,
): boolean {
  return reported && !dayOff && (orders ?? 0) === 0;
}
