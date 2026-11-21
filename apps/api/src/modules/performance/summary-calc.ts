/**
 * Daily performance summary arithmetic (phase 4 row 4.6b): pure functions, no database.
 *
 * Purpose: turns one day's per-person figures into the numbers of the summary email, and
 * works out when the schedule is due, so both rules are unit-tested without a database.
 *
 * Rules, and why:
 *   1. "People with orders" counts people with at least one order that day; "zero orders"
 *      counts everyone listed (matched people with figures on the platform) who had none.
 *      Both use the same people as the Top and bottom report (./performance-reports.ts), so
 *      the email and the screen never disagree.
 *   2. Best = the most orders, among people with at least one order. Weakest = the fewest
 *      orders among everyone not already on the best list, so a small team does not show a
 *      person twice. Ties break by name so the lists never change between runs.
 *   3. The schedule is due once the local clock in the company's time zone has reached the
 *      send time; the date summarised is the day before the local date (the sheet holds
 *      complete figures only up to the day before, see SyncRequest.readOn).
 *
 * Depends on: ./cycle.ts (addDays), ./report-calc.ts (hoursOf).
 * Used by: ./summary-service.ts, ./summary-calc.test.ts.
 */
import { addDays } from './cycle.js';
import { hoursOf } from './report-calc.js';

export const SUMMARY_LIST_SIZE = 5;

export interface SummaryPerson {
  name: string;
  orders: number;
  workingMinutes: number;
}

export interface SummaryLine {
  rank: number;
  name: string;
  orders: number;
  hours: number;
}

export interface DaySummary {
  peopleWithOrders: number;
  totalOrders: number;
  totalHours: number;
  zeroOrders: number;
  best: SummaryLine[];
  worst: SummaryLine[];
}

export function summariseDay(people: readonly SummaryPerson[]): DaySummary {
  const byOrdersDesc = (a: SummaryPerson, b: SummaryPerson) =>
    b.orders - a.orders || a.name.localeCompare(b.name);
  const line = (person: SummaryPerson, index: number): SummaryLine => ({
    rank: index + 1,
    name: person.name,
    orders: person.orders,
    hours: hoursOf(person.workingMinutes),
  });
  // Rule 2.
  const best = people
    .filter((p) => p.orders > 0)
    .sort(byOrdersDesc)
    .slice(0, SUMMARY_LIST_SIZE);
  const bestNames = new Set(best);
  const worst = people
    .filter((p) => !bestNames.has(p))
    .sort((a, b) => a.orders - b.orders || a.name.localeCompare(b.name))
    .slice(0, SUMMARY_LIST_SIZE);
  return {
    // Rule 1.
    peopleWithOrders: people.filter((p) => p.orders > 0).length,
    totalOrders: people.reduce((sum, p) => sum + p.orders, 0),
    totalHours: hoursOf(people.reduce((sum, p) => sum + p.workingMinutes, 0)),
    zeroOrders: people.filter((p) => p.orders === 0).length,
    best: best.map(line),
    worst: worst.map(line),
  };
}

/** The local date ("YYYY-MM-DD") and minutes since local midnight of `at` in `timeZone`. */
export function localClock(timeZone: string, at: Date): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '0';
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    minutes: Number(part('hour')) * 60 + Number(part('minute')),
  };
}

/**
 * Rule 3: the date to summarise if the schedule is due now, else null.
 * `sendTime` is "HH:MM" in `timeZone`.
 */
export function dueSummaryDate(sendTime: string, timeZone: string, now: Date): string | null {
  const [hours, minutes] = sendTime.split(':').map(Number);
  const clock = localClock(timeZone, now);
  if (clock.minutes < (hours ?? 0) * 60 + (minutes ?? 0)) return null;
  return addDays(clock.date, -1);
}
