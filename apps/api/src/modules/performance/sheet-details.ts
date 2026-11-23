/**
 * Platform sheet details of a person (phase 4 row 4.8c): the fixed columns of the platform's
 * daily sheet (day off, schedule, break, zone, plate, COD, skill, tags ...) as friendly values,
 * for the morning call sheet, its details panel and the employee profile.
 *
 * Where the values come from: the sync keeps every fixed column as read on each stored
 * `daily_performance` row under `metrics._fields` (see ./sync-service.ts). The details of a
 * date are those of the person's latest current row inside the date's cycle (on or before the
 * date), so a person the sheet no longer lists keeps their last reading for the cycle.
 *
 * Rules, and why:
 *   1. The sheet writes "Not updated" (any case) where a value is missing. It is shown as an
 *      empty value with a flag (`notUpdated`) the screen turns into a small hint, never as a
 *      time, weekday or amount. A break cell that is not a time is stored by the sync as
 *      empty, so it simply reads as "no value".
 *   2. "Day off" is a weekday name ("Friday", "Fri", "Fri, Sat"), read by ./day-off.ts. It is
 *      compared with the weekday of the figures date (the day before the chosen date) and of
 *      the chosen (call) date separately: `onFiguresDate` and `onCallDate` (row 4.8d). Words
 *      that are not weekdays leave `weekdays` empty and the sheet's own text is shown; nothing
 *      is then marked, because a wrong "day off" mark would hide a person who is not working.
 *   3. Duty time ("14:00-02:00") and break (two time cells) are returned as `from` and `to`;
 *      text that is not a range is returned as `text` unchanged.
 *   4. The COD (pending amount) and the balance amount are money. They are returned only when
 *      the caller holds `performance.amounts.view`; otherwise the keys are null, so the figure
 *      never reaches the browser. Amounts are strings with four decimals and a currency code.
 *
 * Depends on: kernel/db, ./cycle.ts, ./day-off.ts. Used by: ./index.ts (re-exported), ./performance-report-router.ts,
 * ../tracking/call-sheet.ts, ../tracking/tracking-router.ts.
 */
import type { Db } from '../../kernel/db/prisma.js';
import { addDays, cycleContaining } from './cycle.js';
import { dayOffFlags, isDayOffOn, parseWeekdays } from './day-off.js';

// The one parser of the day-off text lives in ./day-off.ts; these names stay available from here.
export { isDayOffOn, parseWeekdays, weekdayOf } from './day-off.js';

/** Permission to see the COD (pending amount) and balance amount of a person. */
export const AMOUNTS_VIEW = 'performance.amounts.view';

/** Currency of the sheet's amounts when the stored row names none (Qatar riyal). */
export const SHEET_CURRENCY = 'QAR';

export interface AmountView {
  /** Decimal string with four places, as stored. */
  amount: string;
  currency: string;
}

export interface SheetDetails {
  /** Whether the sheet has a stored row for this person in the date's cycle. */
  found: boolean;
  /** The sheet date the reading comes from, and when the sync that stored it ran. */
  asOfDate: string | null;
  updatedAt: string | null;
  dayOff: {
    /** The sheet's own text (null when empty or "Not updated"). */
    text: string | null;
    /** Weekday numbers (0 = Sunday ... 6 = Saturday) read from the text. */
    weekdays: number[];
    /** True when one of those weekdays is the weekday of the figures date (the day before). */
    onFiguresDate: boolean;
    /** True when one of those weekdays is the weekday of the chosen (call) date. */
    onCallDate: boolean;
    notUpdated: boolean;
  };
  dutyTime: { from: string | null; to: string | null; text: string | null; notUpdated: boolean };
  break: { from: string | null; to: string | null; text: string | null; notUpdated: boolean };
  zone: string | null;
  plate: string | null;
  /** "Driver" or "Rider" as the sheet writes it. */
  vehicleType: string | null;
  skill: string | null;
  tags: string | null;
  contactNumber: string | null;
  company: string | null;
  /** The COD (pending amount); null without the permission or when the sheet has none. */
  cod: AmountView | null;
  /** The balance amount; same rules as `cod`. */
  balance: AmountView | null;
  /** The platform's notice that a value was missing, by field, for the "Not updated" hint. */
  notUpdatedFields: string[];
}

const NOT_UPDATED = /^\s*not\s*updated\s*$/i;

/** A cell as trimmed text: empty (and the sheet's "NA") is null. */
function textValue(value: unknown): string | null {
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text === '' ? null : text;
}

const isNotUpdated = (value: unknown): boolean =>
  typeof value === 'string' && NOT_UPDATED.test(value);

/** Time of day "H:MM" or "HH:MM(:SS)" as "HH:MM"; null when it is not a time. */
function clock(text: string): string | null {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(text.trim());
  if (m === null || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${String(Number(m[1])).padStart(2, '0')}:${m[2] ?? '00'}`;
}

/** The schedule cell ("14:00-02:00", "14:00 - 02:00", "NA") as from and to. */
export function parseDutyTime(value: unknown): SheetDetails['dutyTime'] {
  if (isNotUpdated(value)) return { from: null, to: null, text: null, notUpdated: true };
  const text = textValue(value);
  if (text === null || /^n\/?a$/i.test(text)) {
    return { from: null, to: null, text: null, notUpdated: false };
  }
  const parts = text.split(/\s*[-–—]\s*|\s+to\s+/i);
  const from = parts.length === 2 ? clock(parts[0] ?? '') : null;
  const to = parts.length === 2 ? clock(parts[1] ?? '') : null;
  if (from !== null && to !== null) return { from, to, text: null, notUpdated: false };
  return { from: null, to: null, text, notUpdated: false };
}

/** The break from its two cells (start and end, each a time or text such as "Not updated"). */
export function parseBreak(start: unknown, end: unknown): SheetDetails['break'] {
  if (isNotUpdated(start) || isNotUpdated(end)) {
    return { from: null, to: null, text: null, notUpdated: true };
  }
  const a = textValue(start);
  const b = textValue(end);
  const from = a === null ? null : clock(a);
  const to = b === null ? null : clock(b);
  if (from !== null || to !== null) return { from, to, text: null, notUpdated: false };
  const text = [a, b].filter((x): x is string => x !== null).join(' - ');
  return { from: null, to: null, text: text === '' ? null : text, notUpdated: false };
}

/** An amount cell as a four-place decimal string; null when empty or not a number. */
function amountOf(value: unknown, currency: string): AmountView | null {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(n) ? { amount: n.toFixed(4), currency } : null;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** The details for a person the sheet has no row for. */
export const NO_SHEET_DETAILS: SheetDetails = {
  found: false,
  asOfDate: null,
  updatedAt: null,
  dayOff: { text: null, weekdays: [], onFiguresDate: false, onCallDate: false, notUpdated: false },
  dutyTime: { from: null, to: null, text: null, notUpdated: false },
  break: { from: null, to: null, text: null, notUpdated: false },
  zone: null,
  plate: null,
  vehicleType: null,
  skill: null,
  tags: null,
  contactNumber: null,
  company: null,
  cod: null,
  balance: null,
  notUpdatedFields: [],
};

/**
 * Friendly details from one stored row's `metrics._fields`. `withAmounts` is the caller's
 * `performance.amounts.view`: without it both amounts are left null (rule 4).
 */
export function parseSheetFields(
  metrics: unknown,
  date: string,
  options: {
    withAmounts: boolean;
    currency?: string | null;
    asOfDate?: string | null;
    updatedAt?: string | null;
  },
): SheetDetails {
  const fields = asRecord(asRecord(metrics)._fields);
  const currency = options.currency ?? SHEET_CURRENCY;
  const dayOffNotUpdated = isNotUpdated(fields.day_off);
  const dayOffText = dayOffNotUpdated ? null : textValue(fields.day_off);
  const dutyTime = parseDutyTime(fields.schedule);
  const breakTime = parseBreak(fields.break_start, fields.break_end);
  const plain = (key: string): string | null =>
    isNotUpdated(fields[key]) ? null : textValue(fields[key]);
  const notUpdatedFields = [
    ...(dayOffNotUpdated ? ['day_off'] : []),
    ...(dutyTime.notUpdated ? ['schedule'] : []),
    ...(breakTime.notUpdated ? ['break'] : []),
    ...['zone', 'plate_number', 'skill', 'tags'].filter((k) => isNotUpdated(fields[k])),
  ];
  return {
    found: true,
    asOfDate: options.asOfDate ?? null,
    updatedAt: options.updatedAt ?? null,
    dayOff: {
      text: dayOffText,
      weekdays: parseWeekdays(dayOffText),
      // Each date on its own (row 4.8d): the figures are from the day before the call date.
      ...dayOffFlags(dayOffText, addDays(date, -1), date),
      notUpdated: dayOffNotUpdated,
    },
    dutyTime,
    break: breakTime,
    zone: plain('zone'),
    plate: plain('plate_number'),
    vehicleType: plain('vehicle_type'),
    skill: plain('skill'),
    tags: plain('tags'),
    contactNumber: plain('contact_number'),
    company: plain('company'),
    cod: options.withAmounts ? amountOf(fields.pending_amount, currency) : null,
    balance: options.withAmounts ? amountOf(fields.balance_amount, currency) : null,
    notUpdatedFields,
  };
}

const toDay = (text: string) => new Date(`${text}T00:00:00.000Z`);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The sheet details of each person on `date`: their latest current stored row inside the
 * date's cycle, on or before the date. People with no such row are absent from the map.
 */
export async function loadSheetDetails(
  db: Db,
  partyIds: readonly string[],
  date: string,
  withAmounts: boolean,
): Promise<Map<string, SheetDetails>> {
  const result = new Map<string, SheetDetails>();
  if (partyIds.length === 0) return result;
  // The earliest cycle start over the company's platforms bounds the search (usually one).
  const platforms = await db.clientPlatform.findMany({
    where: { deletedAt: null },
    select: { cycleStartDay: true },
  });
  const starts = platforms.map((p) => cycleContaining(date, p.cycleStartDay).start).sort();
  const from = starts[0] ?? cycleContaining(date, 1).start;
  const rows = await db.dailyPerformance.findMany({
    where: {
      isCurrent: true,
      partyId: { in: [...partyIds] },
      businessDate: { gte: toDay(from), lte: toDay(date) },
    },
    orderBy: [{ partyId: 'asc' }, { businessDate: 'desc' }, { createdAt: 'desc' }],
    distinct: ['partyId'],
    select: { partyId: true, businessDate: true, metrics: true, currency: true, syncRunId: true },
  });
  const runs = await db.syncRun.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.syncRunId))] } },
    select: { id: true, startedAt: true, finishedAt: true },
  });
  const ranAt = new Map(runs.map((r) => [r.id, (r.finishedAt ?? r.startedAt).toISOString()]));
  for (const row of rows) {
    if (row.partyId === null) continue;
    result.set(
      row.partyId,
      parseSheetFields(row.metrics, date, {
        withAmounts,
        currency: row.currency,
        asOfDate: isoDay(row.businessDate),
        updatedAt: ranAt.get(row.syncRunId) ?? null,
      }),
    );
  }
  return result;
}

/**
 * The sheet's day-off text of each person as read on `asOf` (their latest stored row of the
 * date's cycle). Day off is a weekly habit, so the reports apply this one reading to every day
 * of their range. People with no text (none stored, "Not updated") are absent from the map.
 */
export async function loadDayOffTexts(
  db: Db,
  partyIds: readonly string[],
  asOf: string,
): Promise<Map<string, string>> {
  const sheets = await loadSheetDetails(db, partyIds, asOf, false);
  const result = new Map<string, string>();
  for (const [partyId, sheet] of sheets) {
    if (sheet.dayOff.text !== null) result.set(partyId, sheet.dayOff.text);
  }
  return result;
}

export interface RecentDay {
  date: string;
  /** True when the date was the person's weekly day off (so no orders is expected). */
  dayOff: boolean;
  /** False when the platform stored no figures at all for the date (a reset, never a zero). */
  reported: boolean;
  orders: number | null;
  hours: number | null;
}

/** The seven dates before `date` (oldest first) with the person's orders and active hours. */
export async function loadRecentDays(
  db: Db,
  partyId: string,
  date: string,
  dayOffText: string | null = null,
): Promise<RecentDay[]> {
  const first = addDays(date, -7);
  const last = addDays(date, -1);
  const range = { gte: toDay(first), lte: toDay(last) };
  const [stored, reportedDates] = await Promise.all([
    db.dailyPerformance.findMany({
      where: { isCurrent: true, partyId, businessDate: range },
      select: { businessDate: true, ordersCompleted: true, workingMinutes: true },
    }),
    db.dailyPerformance.groupBy({
      by: ['businessDate'],
      where: { isCurrent: true, businessDate: range },
    }),
  ]);
  const reported = new Set(reportedDates.map((r) => isoDay(r.businessDate)));
  const byDate = new Map<string, { orders: number; minutes: number }>();
  for (const row of stored) {
    const key = isoDay(row.businessDate);
    const known = byDate.get(key) ?? { orders: 0, minutes: 0 };
    known.orders += row.ordersCompleted ?? 0;
    known.minutes += row.workingMinutes ?? 0;
    byDate.set(key, known);
  }
  const days: RecentDay[] = [];
  for (let d = first; d <= last; d = addDays(d, 1)) {
    const isReported = reported.has(d);
    const figure = byDate.get(d);
    days.push({
      date: d,
      dayOff: isDayOffOn(dayOffText, d),
      reported: isReported,
      orders: isReported ? (figure?.orders ?? 0) : null,
      hours: isReported ? Math.round(((figure?.minutes ?? 0) / 60) * 100) / 100 : null,
    });
  }
  return days;
}

export interface PlatformIdView {
  identifierId: string;
  type: string;
  value: string;
  validFrom: string;
  validTo: string | null;
}

export interface PlatformDetails {
  partyId: string;
  date: string;
  /** The day the figures are from (the day before `date`). */
  figuresDate: string;
  sheet: SheetDetails;
  platformIds: PlatformIdView[];
  recentDays: RecentDay[];
  /** Whether COD and balance amounts are included (the caller's permission). */
  amountsVisible: boolean;
}

/**
 * Everything the details panel and the profile section show, for one person on one date:
 * the sheet details, the platform IDs with their valid-from dates and the last seven days.
 * `plainTypes` are the identifier types that are platform IDs (the party module's list).
 */
export async function loadPlatformDetails(
  db: Db,
  partyId: string,
  date: string,
  withAmounts: boolean,
  plainTypes: ReadonlySet<string>,
): Promise<PlatformDetails> {
  const day = toDay(date);
  const [sheets, identifiers] = await Promise.all([
    loadSheetDetails(db, [partyId], date, withAmounts),
    db.partyIdentifier.findMany({
      where: {
        partyId,
        type: { in: [...plainTypes] },
        deletedAt: null,
        validFrom: { lte: day },
        OR: [{ validTo: null }, { validTo: { gte: day } }],
      },
      orderBy: [{ validFrom: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        type: true,
        valuePlain: true,
        valueMasked: true,
        validFrom: true,
        validTo: true,
      },
    }),
  ]);
  const sheet = sheets.get(partyId) ?? NO_SHEET_DETAILS;
  // The last seven days carry the person's weekly day off, so a day off reads as one.
  const recentDays = await loadRecentDays(db, partyId, date, sheet.dayOff.text);
  return {
    partyId,
    date,
    figuresDate: addDays(date, -1),
    sheet,
    platformIds: identifiers.map((i) => ({
      identifierId: i.id,
      type: i.type,
      value: i.valuePlain ?? i.valueMasked,
      validFrom: isoDay(i.validFrom),
      validTo: i.validTo === null ? null : isoDay(i.validTo),
    })),
    recentDays,
    amountsVisible: withAmounts,
  };
}
