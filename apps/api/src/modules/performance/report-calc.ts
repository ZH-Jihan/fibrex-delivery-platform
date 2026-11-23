/**
 * Performance report arithmetic (phase 4 row 4.6a): pure functions, no database.
 *
 * Purpose: turns stored per-person day figures into the numbers the performance reports
 * show, so the rules live in one place and are unit-tested without a database.
 *
 * Rules, and why:
 *   1. The sync stores a row only when a person has at least one non-zero figure that day
 *      (blank and 0 both mean "no figures", phase 4 plan section 2). So a missing row does
 *      NOT prove a zero: it is a real zero only on a *reported day*, a date on which the
 *      platform sheet showed figures for somebody. A date with no stored row for anyone is a
 *      platform reset (every value 0 after a cycle ends) or a missed sync, and is never counted
 *      as a zero for anyone (the reset guard rule).
 *   2. One person is counted once however many platform IDs they hold: figures are grouped by
 *      party, and the database allows one current row per person per date.
 *   3. "Day worked" = a reported day on which the person has orders or working minutes.
 *      "Zero-order day" = a reported day on which the person has no orders (no row, or a row
 *      with 0 orders).
 *   4. A "no orders in a row" run is made of consecutive calendar dates that are all reported
 *      and all zero; an unreported date breaks a run because we do not know what happened.
 *   5. Acceptance rate is stored as the sheet gives it: a fraction (0.93) or a percentage
 *      (93). Values up to 1 are shown as percentages (x 100), larger values as they are.
 *   6. A day that is the person's weekly day off is never a zero-order day, and it breaks a
 *      "no orders in a row" run (row 4.8d). The rule itself is in ./day-off.ts, shared with the
 *      call sheet and the summary email. The day-off text is the person's latest sheet reading,
 *      applied to every day of the range.
 *
 * Depends on: ./cycle.ts (addDays), ./day-off.ts. Used by: ./performance-reports.ts, ./performance-report-router.ts.
 */
import { addDays } from './cycle.js';
import { isDayOffOn, isZeroOrderProblem } from './day-off.js';

/** One person's stored figures for one reported date. */
export interface DayFigure {
  partyId: string;
  date: string;
  orders: number;
  workingMinutes: number;
  lateMinutes: number | null;
  /** As stored in the sheet metrics (fraction or percentage), see rule 5. */
  acceptanceRate: number | null;
  kms: number | null;
}

export interface PersonTotals {
  partyId: string;
  totalOrders: number;
  totalHours: number;
  daysWorked: number;
  zeroDays: number;
  avgOrdersPerActiveDay: number;
  ordersPerHour: number;
}

export interface ZeroRun {
  days: number;
  from: string;
  to: string;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Minutes as decimal hours with two decimals (450 -> 7.5). */
export function hoursOf(minutes: number): number {
  return round2(minutes / 60);
}

/** Rule 5: shown as a percentage with at most two decimals, or null when not stored. */
export function acceptancePercent(stored: number | null): number | null {
  if (stored === null) return null;
  return round2(stored <= 1 ? stored * 100 : stored);
}

/** Groups figures by person and date, so each lookup is one map read. */
export function indexFigures(figures: readonly DayFigure[]): Map<string, Map<string, DayFigure>> {
  const byPerson = new Map<string, Map<string, DayFigure>>();
  for (const figure of figures) {
    const days = byPerson.get(figure.partyId) ?? new Map<string, DayFigure>();
    days.set(figure.date, figure);
    byPerson.set(figure.partyId, days);
  }
  return byPerson;
}

/** Totals for one person over the reported days (rules 1 to 3). */
export function totalsFor(
  partyId: string,
  days: ReadonlyMap<string, DayFigure> | undefined,
  reportedDates: readonly string[],
  dayOffText: string | null = null,
): PersonTotals {
  let orders = 0;
  let minutes = 0;
  let daysWorked = 0;
  let zeroDays = 0;
  for (const date of reportedDates) {
    const figure = days?.get(date);
    const dayOrders = figure?.orders ?? 0;
    const dayMinutes = figure?.workingMinutes ?? 0;
    orders += dayOrders;
    minutes += dayMinutes;
    if (dayOrders > 0 || dayMinutes > 0) daysWorked += 1;
    // Rule 6: a day off with no orders is not a zero-order day.
    if (isZeroOrderProblem(dayOrders, true, isDayOffOn(dayOffText, date))) zeroDays += 1;
  }
  const hours = minutes / 60;
  return {
    partyId,
    totalOrders: orders,
    totalHours: round2(hours),
    daysWorked,
    zeroDays,
    avgOrdersPerActiveDay: daysWorked === 0 ? 0 : round2(orders / daysWorked),
    ordersPerHour: hours === 0 ? 0 : round2(orders / hours),
  };
}

/**
 * The longest run of consecutive reported calendar days with no orders (rule 4); on a tie
 * the later run wins, because it is the one still to chase. Null when there is no zero day.
 */
export function longestZeroRun(
  days: ReadonlyMap<string, DayFigure> | undefined,
  reportedDates: readonly string[],
  dayOffText: string | null = null,
): ZeroRun | null {
  let best: ZeroRun | null = null;
  let current: ZeroRun | null = null;
  for (const date of [...reportedDates].sort()) {
    // Rule 6: a day off is not a zero day, and it ends a run (the person was not due to work).
    const zero = isZeroOrderProblem(
      days?.get(date)?.orders ?? 0,
      true,
      isDayOffOn(dayOffText, date),
    );
    if (!zero) {
      current = null;
      continue;
    }
    current =
      current !== null && addDays(current.to, 1) === date
        ? { days: current.days + 1, from: current.from, to: date }
        : { days: 1, from: date, to: date };
    if (best === null || current.days >= best.days) best = current;
  }
  return best;
}
