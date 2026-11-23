/**
 * Performance reports on the report engine (phase 4 row 4.6a; plan row 4.6):
 * `performance.daily`, `performance.cycle_summary`, `performance.top_bottom`.
 *
 * Purpose: read the stored `daily_performance` figures and show them per person for a day,
 * for a platform cycle (Snoonu: 26th to 25th) or a date range. CSV and Excel export come from
 * the report engine (it calls `run` page by page), so nothing here writes a file.
 *
 * Scope rules, and why:
 *   1. Everything is read through the `db` the engine hands us, so row-level security and the
 *      caller's company scope apply. The optional `companyId` filter narrows it further when
 *      someone has several companies.
 *   2. One platform per report. `platformId` picks it; without it the first active platform by
 *      name is used, because a cycle only has a meaning for one platform's `cycle_start_day`.
 *   3. A range is `from` + `to`; without both, the cycle (`cycle` = this or last, default this)
 *      of the platform. Only current rows (`is_current`) are read.
 *   4. Reset guard, people counted once and what a zero means: see ./report-calc.ts. The
 *      "reported days" of a range are the dates that hold at least one current row for the
 *      platform (matched to a person or not).
 *   5. Who is listed: people with figures in the range, plus active employees seen on this
 *      platform at any time (so a rider with no figures shows as zeros instead of vanishing).
 *      Rows stored without a person (unmatched IDs) are not people and are left out.
 *   6. Cell values that are codes (`list` of the top and bottom report) are translated by the
 *      screen; the export keeps the code.
 *
 * Depends on: @fibrex/shared (report types), kernel/module-registry, kernel/http/errors,
 * ./cycle.ts, ./report-calc.ts. Used by: ./index.ts (the manifest's `reports`),
 * ./performance-report-router.ts.
 */
import type { ReportCell } from '@fibrex/shared';
import type { Db } from '../../kernel/db/prisma.js';
import { BadRequestError, NotFoundError } from '../../kernel/http/errors.js';
import type { ReportDef, ReportRunInput } from '../../kernel/module-registry/manifest.js';
import { addDays, cycleContaining, type Cycle } from './cycle.js';
import { loadDayOffTexts } from './sheet-details.js';
import {
  acceptancePercent,
  hoursOf,
  indexFigures,
  longestZeroRun,
  totalsFor,
  type DayFigure,
} from './report-calc.js';

export const REPORT_VIEW = 'performance.report.view';
/** A range longer than this is refused (a cycle is about 31 days; a year is plenty). */
export const MAX_RANGE_DAYS = 366;
/** The people on the top and bottom lists, and the length of an "inactive" run worth listing. */
export const TOP_COUNT = 10;
export const STREAK_DAYS = 3;

type Row = Record<string, ReportCell>;

const isoDay = (value: Date): string => value.toISOString().slice(0, 10);
const toDay = (text: string): Date => new Date(`${text}T00:00:00.000Z`);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Today's business date in Qatar (UTC+3, no daylight saving). */
export function qatarToday(now: Date = new Date()): string {
  return isoDay(new Date(now.getTime() + 3 * 3_600_000));
}

export function yesterdayInQatar(now: Date = new Date()): string {
  return addDays(qatarToday(now), -1);
}

/** The cycle that holds today and the one before it, for a start day. */
export function thisAndLastCycle(
  startDay: number,
  now: Date = new Date(),
): { thisCycle: Cycle; lastCycle: Cycle } {
  const thisCycle = cycleContaining(qatarToday(now), startDay);
  return { thisCycle, lastCycle: cycleContaining(addDays(thisCycle.start, -1), startDay) };
}

export interface ReportScope {
  platformId: string;
  platformName: string;
  companyId: string | null;
  from: string;
  to: string;
  /** The cycle the range is, or null when the caller gave a free date range. */
  cycle: Cycle | null;
}

function checkCompany(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!UUID.test(value)) throw new BadRequestError('bad_company', 'Company is not a valid id.');
  return value;
}

/** Rule 2: the platform the report is about. */
async function resolvePlatform(db: Db, platformId: string | undefined, companyId: string | null) {
  const platforms = await db.clientPlatform.findMany({
    where: {
      deletedAt: null,
      ...(companyId === null ? {} : { companyId }),
      ...(platformId === undefined ? { status: 'active' } : { id: platformId }),
    },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    take: 1,
  });
  const platform = platforms[0];
  if (platform === undefined) {
    if (platformId !== undefined) throw new NotFoundError('That platform does not exist.');
    throw new BadRequestError('no_platform', 'There is no active client platform yet.');
  }
  return platform;
}

/** Rule 3: a range, or the platform's cycle. `dayFilter` is the one-day form of `daily`. */
export async function resolveScope(
  db: Db,
  filters: Record<string, string>,
  options: { singleDay?: boolean; now?: Date } = {},
): Promise<ReportScope> {
  const companyId = checkCompany(filters.companyId);
  const platformId = filters.platformId;
  if (platformId !== undefined && !UUID.test(platformId)) {
    throw new BadRequestError('bad_platform', 'Platform is not a valid id.');
  }
  const platform = await resolvePlatform(db, platformId, companyId);
  const base = {
    platformId: platform.id,
    platformName: platform.name,
    companyId,
  };

  if (options.singleDay === true) {
    const date = filters.date ?? yesterdayInQatar(options.now);
    return { ...base, from: date, to: date, cycle: null };
  }

  const { from, to, cycle: cycleChoice } = filters;
  if ((from === undefined) !== (to === undefined)) {
    throw new BadRequestError('range_needs_both', 'Give both a from date and a to date.');
  }
  if (from !== undefined && to !== undefined) {
    if (from > to) throw new BadRequestError('bad_range', 'The from date is after the to date.');
    if (Date.parse(to) - Date.parse(from) > (MAX_RANGE_DAYS - 1) * 86_400_000) {
      throw new BadRequestError('range_too_long', `Choose at most ${MAX_RANGE_DAYS} days.`);
    }
    return { ...base, from, to, cycle: null };
  }
  const { thisCycle, lastCycle } = thisAndLastCycle(platform.cycleStartDay, options.now);
  const cycle = cycleChoice === 'last' ? lastCycle : thisCycle;
  return { ...base, from: cycle.start, to: cycle.end, cycle };
}

interface Loaded {
  /** Dates in range with at least one current row for the platform (rule 4). */
  reportedDates: string[];
  figures: DayFigure[];
  /** Everyone to list (rule 5), by party id. */
  people: Map<string, { name: string; falconIds: string }>;
  /** Each listed person's weekly day-off text (sheet reading at the end of the range), row 4.8d. */
  dayOffTexts: Map<string, string>;
}

function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Reads the range once: reported days, per-person figures and the people to list. */
export async function loadFigures(db: Db, scope: ReportScope): Promise<Loaded> {
  const where = {
    clientPlatformId: scope.platformId,
    isCurrent: true,
    ...(scope.companyId === null ? {} : { companyId: scope.companyId }),
  };
  const inRange = { ...where, businessDate: { gte: toDay(scope.from), lte: toDay(scope.to) } };

  const dates = await db.dailyPerformance.groupBy({
    by: ['businessDate'],
    where: inRange,
    orderBy: { businessDate: 'asc' },
  });
  const rows = await db.dailyPerformance.findMany({
    where: { ...inRange, partyId: { not: null } },
    select: {
      partyId: true,
      businessDate: true,
      ordersCompleted: true,
      workingMinutes: true,
      lateMinutes: true,
      metrics: true,
    },
  });
  const figures: DayFigure[] = [];
  for (const row of rows) {
    if (row.partyId === null) continue;
    const metrics = (row.metrics ?? {}) as Record<string, unknown>;
    figures.push({
      partyId: row.partyId,
      date: isoDay(row.businessDate),
      orders: row.ordersCompleted ?? 0,
      workingMinutes: row.workingMinutes ?? 0,
      lateMinutes: row.lateMinutes,
      acceptanceRate: numberOf(metrics.acceptance_rate),
      kms: numberOf(metrics.kms),
    });
  }

  // Everyone who ever had a matched figure on this platform, with their platform ids (a person
  // with two ids is one entry with both ids).
  const everSeen = await db.dailyPerformance.groupBy({
    by: ['partyId', 'externalId'],
    where: { ...where, partyId: { not: null } },
  });
  const idsOf = new Map<string, string[]>();
  for (const seen of everSeen) {
    if (seen.partyId === null) continue;
    idsOf.set(seen.partyId, [...(idsOf.get(seen.partyId) ?? []), seen.externalId]);
  }
  const active = await db.employee.findMany({
    where: { deletedAt: null, statusCode: 'active', partyId: { in: [...idsOf.keys()] } },
    select: { partyId: true },
  });
  const listed = new Set<string>([
    ...figures.map((f) => f.partyId),
    ...active.map((e) => e.partyId),
  ]);
  const parties = await db.party.findMany({
    where: { id: { in: [...listed] } },
    select: { id: true, displayName: true },
  });
  const people = new Map<string, { name: string; falconIds: string }>();
  for (const party of parties) {
    people.set(party.id, {
      name: party.displayName,
      falconIds: [...new Set(idsOf.get(party.id) ?? [])].sort().join(', '),
    });
  }
  const dayOffTexts = await loadDayOffTexts(db, [...people.keys()], scope.to);
  return {
    reportedDates: dates.map((d) => isoDay(d.businessDate)),
    figures,
    people,
    dayOffTexts,
  };
}

/** Sorts rows by a column and cuts one page (the rows are computed, not table rows). */
function pageOf(rows: Row[], input: ReportRunInput): { rows: Row[]; total: number } {
  const sort = input.sort;
  if (sort !== undefined) {
    const direction = sort.direction === 'desc' ? -1 : 1;
    rows.sort((a, b) => {
      const x = a[sort.key] ?? '';
      const y = b[sort.key] ?? '';
      return (
        direction *
        (typeof x === 'number' && typeof y === 'number'
          ? x - y
          : String(x).localeCompare(String(y)))
      );
    });
  }
  const start = (input.page - 1) * input.pageSize;
  return { rows: rows.slice(start, start + input.pageSize), total: rows.length };
}

const byName = (a: Row, b: Row) => String(a.personName).localeCompare(String(b.personName));

/** Filters every performance report shares. Labels are English; the screen translates them. */
const PLATFORM_FILTERS = [
  { key: 'platformId', label: 'Platform', type: 'text' },
  { key: 'companyId', label: 'Company', type: 'text' },
] as const;

const RANGE_FILTERS = [
  ...PLATFORM_FILTERS,
  {
    key: 'cycle',
    label: 'Cycle',
    type: 'select',
    options: [
      { value: 'this', label: 'This cycle' },
      { value: 'last', label: 'Last cycle' },
    ],
  },
  { key: 'from', label: 'From', type: 'date' },
  { key: 'to', label: 'To', type: 'date' },
] as const;

export const dailyReport: ReportDef = {
  key: 'performance.daily',
  label: 'Daily performance',
  description:
    "One day's orders (delivered), working hours, acceptance rate, late minutes and km for each person. Default day: yesterday.",
  permission: REPORT_VIEW,
  columns: [
    { key: 'personName', label: 'Person', type: 'text', sortable: true },
    { key: 'falconId', label: 'Platform ID', type: 'text', sortable: true },
    { key: 'date', label: 'Date', type: 'date', sortable: true },
    { key: 'orders', label: 'Orders', type: 'number', sortable: true },
    { key: 'hoursActive', label: 'Hours active', type: 'number', sortable: true },
    { key: 'acceptanceRate', label: 'Acceptance rate %', type: 'number', sortable: true },
    { key: 'lateMinutes', label: 'Late minutes', type: 'number', sortable: true },
    { key: 'km', label: 'Km', type: 'number', sortable: true },
  ],
  filters: [...PLATFORM_FILTERS, { key: 'date', label: 'Day', type: 'date' }],
  async run(db, input) {
    const scope = await resolveScope(db, input.filters, { singleDay: true });
    const data = await loadFigures(db, scope);
    // A day with no figures for anybody is a reset or a missed sync: show nothing, not zeros.
    if (data.reportedDates.length === 0) return { rows: [], total: 0 };
    const byPerson = indexFigures(data.figures);
    const rows: Row[] = [...data.people].map(([partyId, person]) => {
      const figure = byPerson.get(partyId)?.get(scope.from);
      return {
        personName: person.name,
        falconId: person.falconIds,
        date: scope.from,
        orders: figure?.orders ?? 0,
        hoursActive: hoursOf(figure?.workingMinutes ?? 0),
        acceptanceRate: acceptancePercent(figure?.acceptanceRate ?? null),
        lateMinutes: figure?.lateMinutes ?? null,
        km: figure?.kms ?? null,
      };
    });
    rows.sort(byName);
    return pageOf(rows, input);
  },
};

export const cycleSummaryReport: ReportDef = {
  key: 'performance.cycle_summary',
  label: 'Cycle summary',
  description:
    "Each person's orders, hours, active days and orders per hour for a platform cycle (Snoonu: 26th to 25th) or a date range. Days the platform reset to zero are not counted.",
  permission: REPORT_VIEW,
  columns: [
    { key: 'personName', label: 'Person', type: 'text', sortable: true },
    { key: 'falconId', label: 'Platform ID', type: 'text', sortable: true },
    { key: 'cycleStart', label: 'Cycle start', type: 'date', sortable: true },
    { key: 'cycleEnd', label: 'Cycle end', type: 'date', sortable: true },
    { key: 'totalOrders', label: 'Total orders', type: 'number', sortable: true },
    { key: 'totalHours', label: 'Total hours', type: 'number', sortable: true },
    {
      key: 'avgOrdersPerActiveDay',
      label: 'Avg orders per active day',
      type: 'number',
      sortable: true,
    },
    { key: 'daysWorked', label: 'Days worked', type: 'number', sortable: true },
    { key: 'zeroDays', label: 'Days with zero orders', type: 'number', sortable: true },
    { key: 'ordersPerHour', label: 'Orders per hour', type: 'number', sortable: true },
  ],
  filters: RANGE_FILTERS,
  async run(db, input) {
    const scope = await resolveScope(db, input.filters);
    const data = await loadFigures(db, scope);
    const byPerson = indexFigures(data.figures);
    const rows: Row[] = [...data.people].map(([partyId, person]) => {
      const totals = totalsFor(
        partyId,
        byPerson.get(partyId),
        data.reportedDates,
        data.dayOffTexts.get(partyId) ?? null,
      );
      return {
        personName: person.name,
        falconId: person.falconIds,
        cycleStart: scope.from,
        cycleEnd: scope.to,
        totalOrders: totals.totalOrders,
        totalHours: totals.totalHours,
        avgOrdersPerActiveDay: totals.avgOrdersPerActiveDay,
        daysWorked: totals.daysWorked,
        zeroDays: totals.zeroDays,
        ordersPerHour: totals.ordersPerHour,
      };
    });
    // No reported day at all: nothing to summarise (an empty cycle, not a list of zeros).
    if (data.reportedDates.length === 0) return { rows: [], total: 0 };
    rows.sort(byName);
    return pageOf(rows, input);
  },
};

export const topBottomReport: ReportDef = {
  key: 'performance.top_bottom',
  label: 'Top and bottom performers',
  description: `The ${String(TOP_COUNT)} people with the most and the fewest orders in the range, and people with no orders for ${String(STREAK_DAYS)} or more reported days in a row.`,
  permission: REPORT_VIEW,
  columns: [
    { key: 'list', label: 'List', type: 'text', sortable: true },
    { key: 'rank', label: 'Rank', type: 'number', sortable: true },
    { key: 'personName', label: 'Person', type: 'text', sortable: true },
    { key: 'falconId', label: 'Platform ID', type: 'text', sortable: true },
    { key: 'totalOrders', label: 'Total orders', type: 'number', sortable: true },
    { key: 'totalHours', label: 'Total hours', type: 'number', sortable: true },
    { key: 'streakDays', label: 'Days in a row with no orders', type: 'number', sortable: true },
    { key: 'streakFrom', label: 'Run from', type: 'date', sortable: true },
    { key: 'streakTo', label: 'Run to', type: 'date', sortable: true },
  ],
  filters: RANGE_FILTERS,
  async run(db, input) {
    const scope = await resolveScope(db, input.filters);
    const data = await loadFigures(db, scope);
    if (data.reportedDates.length === 0) return { rows: [], total: 0 };
    const byPerson = indexFigures(data.figures);
    const ranked = [...data.people].map(([partyId, person]) => ({
      partyId,
      person,
      totals: totalsFor(
        partyId,
        byPerson.get(partyId),
        data.reportedDates,
        data.dayOffTexts.get(partyId) ?? null,
      ),
    }));
    // Same count, then name, so the lists never change between runs.
    const order = (a: (typeof ranked)[number], b: (typeof ranked)[number]) =>
      b.totals.totalOrders - a.totals.totalOrders || a.person.name.localeCompare(b.person.name);
    const best = [...ranked].sort(order).slice(0, TOP_COUNT);
    const bestIds = new Set(best.map((r) => r.partyId));
    // The weakest come from the people not already on the top list, so a small team does not
    // show everyone twice.
    const worst = ranked
      .filter((r) => !bestIds.has(r.partyId))
      .sort((a, b) => -order(a, b))
      .slice(0, TOP_COUNT);

    const listRow = (list: string, rank: number, r: (typeof ranked)[number]): Row => ({
      list,
      rank,
      personName: r.person.name,
      falconId: r.person.falconIds,
      totalOrders: r.totals.totalOrders,
      totalHours: r.totals.totalHours,
      streakDays: null,
      streakFrom: null,
      streakTo: null,
    });
    const rows: Row[] = [
      ...best.map((r, i) => listRow('top', i + 1, r)),
      ...worst.map((r, i) => listRow('bottom', i + 1, r)),
    ];
    const streaks = ranked
      .flatMap((r) => {
        // Days that were the person's day off are not zero days and end a run (row 4.8d).
        const run = longestZeroRun(
          byPerson.get(r.partyId),
          data.reportedDates,
          data.dayOffTexts.get(r.partyId) ?? null,
        );
        return run !== null && run.days >= STREAK_DAYS ? [{ r, run }] : [];
      })
      .sort((a, b) => b.run.days - a.run.days || a.r.person.name.localeCompare(b.r.person.name));
    streaks.forEach(({ r, run }, i) => {
      rows.push({
        ...listRow('streak', i + 1, r),
        streakDays: run.days,
        streakFrom: run.from,
        streakTo: run.to,
      });
    });
    return pageOf(rows, input);
  },
};

export const PERFORMANCE_REPORTS: readonly ReportDef[] = [
  dailyReport,
  cycleSummaryReport,
  topBottomReport,
];
