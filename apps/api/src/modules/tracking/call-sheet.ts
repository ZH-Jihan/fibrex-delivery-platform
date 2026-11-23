/**
 * The morning call sheet as data (phase 4 row 4.7; SPEC 3.3): who is on it, their figures for
 * the day before, the day's entry, the latest call, who works their ID, the cross-check and
 * the summary strip. Read-only; the routes in ./tracking-router.ts check the permission.
 *
 * Who is listed, and why: everyone who on the sheet's date has a live placement as a rider or
 * a driver (`people.employee_placement`, profession code in PLATFORM_PROFESSIONS). Office staff
 * and anyone else without such a placement are not called in the morning, so they are not on
 * it. One placement per employee per day is a database rule, and rows are keyed by person, so
 * a person with two platform IDs (an old and a new Falcon ID) is one row listing both.
 *
 * The figures: the sheet runs one day behind, so the call sheet of a date shows the figures of
 * the day before (`figuresDate`): orders delivered, active (working) hours, late minutes, from
 * the current `daily_performance` rows of the person (summed over platforms). A day the
 * company has no stored figures for is "not reported": no one has zero orders on such a day.
 *
 * The status shown is the employee's status on the sheet's date: the current status for today
 * or later, the dated history (`cfg.state_history`) for a past date.
 *
 * Everything is read through the caller's unit of work, so row-level security keeps each
 * company's sheet to itself.
 *
 * Depends on: @fibrex/shared, kernel/db, ../party (PLAIN_IDENTIFIER_TYPES), ../people
 * (EMPLOYEE_ENTITY), ../performance (addDays), ./tracking-calc.ts, ./tracking-service.ts
 * (entryView). Used by: ./tracking-router.ts.
 */
import {
  TRACKING_DEFAULT_LOW_HOURS,
  trackingSettingsSchema,
  type CrossCheckKind,
} from '@fibrex/shared';
import type { Db } from '../../kernel/db/prisma.js';
import { PLAIN_IDENTIFIER_TYPES } from '../party/index.js';
import { EMPLOYEE_ENTITY } from '../people/index.js';
import { addDays } from '../performance/index.js';
import {
  crossCheck,
  sheetStatusOf,
  summarise,
  type SheetStatus,
  type Summary,
} from './tracking-calc.js';
import { entryView, type EntryView } from './tracking-service.js';

/** Profession codes (the `profession` lookup) of the people called each morning. */
export const PLATFORM_PROFESSIONS: readonly string[] = ['rider', 'driver'];

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const toDay = (text: string) => new Date(`${text}T00:00:00.000Z`);

export interface PlatformId {
  identifierId: string;
  type: string;
  value: string;
}

export interface CallView {
  id: string;
  businessDate: string;
  at: string;
  outcomeId: string;
  outcomeCode: string | null;
  callerUserId: string | null;
  note: string | null;
}

export interface OperatorView {
  id: string;
  partyIdentifierId: string;
  ownerPartyId: string;
  operatorPartyId: string | null;
  operatorName: string | null;
  operatorPhone: string | null;
  fromDate: string;
  toDate: string | null;
  codAtHandover: string | null;
  currency: string | null;
  ordersAtHandover: number | null;
  note: string | null;
  /** The user who recorded the period (null for rows made by the system). */
  createdBy: string | null;
  version: number;
}

export interface SheetRow {
  partyId: string;
  employeeId: string;
  employeeCode: string;
  name: string;
  platformIds: PlatformId[];
  profession: string;
  zone: string | null;
  phone: string | null;
  statusCode: string | null;
  yesterday: {
    orders: number | null;
    hours: number | null;
    lateMinutes: number | null;
  };
  sheetStatus: SheetStatus | null;
  entry: EntryView | null;
  calledToday: boolean;
  lastCall: CallView | null;
  operator: OperatorView | null;
  crossCheck: CrossCheckKind[];
}

/** The filters of `GET /tracking` (all optional; they combine with "and"). */
export interface SheetFilters {
  status?: string | undefined;
  q?: string | undefined;
  notCalled?: boolean | undefined;
  zeroOrders?: boolean | undefined;
}

export interface CallSheet {
  date: string;
  /** The day the figures are from (the day before `date`). */
  figuresDate: string;
  /** Whether the company has stored figures for `figuresDate`. */
  reported: boolean;
  /** The strip for exactly the rows returned (the filtered set). */
  summary: Summary;
  rows: SheetRow[];
  /** True when at least one filter narrowed the list. */
  filtered: boolean;
  /** People and status counts of the whole sheet, whatever the filters. */
  unfiltered: { totalPeople: number; byStatus: Record<string, number> };
  /** Active hours below which a person is marked "low hours" (company setting). */
  lowHoursLimit: number;
}

type OperatorRow = NonNullable<Awaited<ReturnType<Db['idOperatorPeriod']['findFirst']>>>;
type CallRow = NonNullable<Awaited<ReturnType<Db['callLog']['findFirst']>>>;

export function operatorView(row: OperatorRow): OperatorView {
  return {
    id: row.id,
    partyIdentifierId: row.partyIdentifierId,
    ownerPartyId: row.ownerPartyId,
    operatorPartyId: row.operatorPartyId,
    operatorName: row.operatorName,
    operatorPhone: row.operatorPhone,
    fromDate: isoDay(row.fromDate),
    toDate: row.toDate === null ? null : isoDay(row.toDate),
    codAtHandover: row.codAtHandover === null ? null : row.codAtHandover.toFixed(4),
    currency: row.currency,
    ordersAtHandover: row.ordersAtHandover,
    note: row.note,
    createdBy: row.createdBy,
    version: row.version,
  };
}

export function callView(row: CallRow, codes: ReadonlyMap<string, string>): CallView {
  return {
    id: row.id,
    businessDate: isoDay(row.businessDate),
    at: row.at.toISOString(),
    outcomeId: row.outcomeId,
    outcomeCode: codes.get(row.outcomeId) ?? null,
    callerUserId: row.callerUserId,
    note: row.note,
  };
}

/** Lookup codes of these value ids. */
export async function lookupCodes(db: Db, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const values = await db.lookupValue.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: { id: true, code: true },
  });
  return new Map(values.map((v) => [v.id, v.code]));
}

/**
 * Each employee's status on `date`: the current status for today or later; otherwise the
 * latest history row effective on or before the date (ties: the later move), or, when every
 * move is later, where the first move started from.
 */
async function statusesOn(
  db: Db,
  employees: readonly { id: string; statusCode: string }[],
  date: string,
  today: string,
): Promise<Map<string, string>> {
  const result = new Map(employees.map((e) => [e.id, e.statusCode]));
  if (date >= today || employees.length === 0) return result;
  const history = await db.stateHistory.findMany({
    where: { entityType: EMPLOYEE_ENTITY, entityId: { in: employees.map((e) => e.id) } },
    orderBy: [{ id: 'asc' }],
    select: { entityId: true, fromCode: true, toCode: true, effectiveDate: true },
  });
  const byEmployee = new Map<string, typeof history>();
  for (const row of history) {
    byEmployee.set(row.entityId, [...(byEmployee.get(row.entityId) ?? []), row]);
  }
  for (const [employeeId, rows] of byEmployee) {
    const effective = rows
      .filter((r) => isoDay(r.effectiveDate) <= date)
      .sort((a, b) => isoDay(a.effectiveDate).localeCompare(isoDay(b.effectiveDate)));
    const last = effective.at(-1);
    const first = rows[0];
    if (last !== undefined) result.set(employeeId, last.toCode);
    else if (first !== undefined) result.set(employeeId, first.fromCode ?? first.toCode);
  }
  return result;
}

/** Key of the company setting that holds the low-hours limit: `{ "lowHours": 4 }`. */
export const TRACKING_SETTINGS_KEY = 'tracking.call_sheet';

/** The company's low-hours limit, or the default; a bad stored value falls back to the default. */
export async function readLowHours(db: Db, companyId: string | null): Promise<number> {
  if (companyId === null) return TRACKING_DEFAULT_LOW_HOURS;
  const row = await db.setting.findFirst({
    where: { scope: 'company', companyId, key: TRACKING_SETTINGS_KEY, deletedAt: null },
    orderBy: { validFrom: 'desc' },
  });
  const parsed = trackingSettingsSchema.safeParse({
    lowHours: (row?.value as { lowHours?: unknown } | null | undefined)?.lowHours,
  });
  return parsed.success ? parsed.data.lowHours : TRACKING_DEFAULT_LOW_HOURS;
}

/**
 * Whether a row has no orders on a reported day. A person the sheet has no row for on a day it
 * reported delivered nothing, so they count as zero (the same rule as the strip).
 */
export const hasZeroOrders = (orders: number | null, reported: boolean): boolean =>
  reported && (orders ?? 0) === 0;

/** Does the row pass every filter given? Text matches name, code, phone or a platform ID. */
export function matchesFilters(row: SheetRow, f: SheetFilters, reported: boolean): boolean {
  if (f.status !== undefined && row.statusCode !== f.status) return false;
  if (f.notCalled === true && row.calledToday) return false;
  if (f.zeroOrders === true && !hasZeroOrders(row.yesterday.orders, reported)) return false;
  const q = f.q?.trim().toLowerCase() ?? '';
  if (q === '') return true;
  return [row.name, row.employeeCode, row.phone ?? '', ...row.platformIds.map((p) => p.value)]
    .join(' ')
    .toLowerCase()
    .includes(q);
}

/**
 * The whole call sheet of `date`. `today` is the state service's today (UTC date).
 *
 * Filters narrow the rows first; the summary strip is then computed over those rows only, so
 * every number on the strip (and every exported line) describes exactly the people listed.
 */
export async function loadCallSheet(
  db: Db,
  date: string,
  today: string,
  filters: SheetFilters = {},
  lowHoursLimit: number = TRACKING_DEFAULT_LOW_HOURS,
): Promise<CallSheet> {
  const day = toDay(date);
  const figuresDate = addDays(date, -1);
  const live = { validFrom: { lte: day }, OR: [{ validTo: null }, { validTo: { gte: day } }] };

  // Who is on the sheet: a rider or driver placement on the date.
  const placements = await db.employeePlacement.findMany({
    where: {
      deletedAt: null,
      profession: { in: [...PLATFORM_PROFESSIONS] },
      employee: { deletedAt: null },
      ...live,
    },
    select: {
      profession: true,
      orgUnitId: true,
      employee: { select: { id: true, partyId: true, employeeCode: true, statusCode: true } },
    },
    orderBy: [{ validFrom: 'desc' }],
  });
  const people = new Map<string, (typeof placements)[number]>();
  for (const placement of placements) {
    if (!people.has(placement.employee.partyId)) people.set(placement.employee.partyId, placement);
  }
  const partyIds = [...people.keys()];
  const reported =
    (await db.dailyPerformance.count({
      where: { isCurrent: true, businessDate: toDay(figuresDate) },
    })) > 0;
  if (partyIds.length === 0) {
    return {
      date,
      figuresDate,
      reported,
      summary: summarise([], reported),
      rows: [],
      filtered: false,
      unfiltered: { totalPeople: 0, byStatus: {} },
      lowHoursLimit,
    };
  }

  const inParties = { in: partyIds };
  const [parties, phones, identifiers, zones, figures, entries, callsToday, lastCalls, operators] =
    [
      await db.party.findMany({
        where: { id: inParties },
        select: { id: true, displayName: true },
      }),
      await db.partyContact.findMany({
        where: { partyId: inParties, kind: 'phone', deletedAt: null },
        orderBy: [{ isPrimary: 'desc' }, { id: 'asc' }],
        select: { partyId: true, value: true },
      }),
      await db.partyIdentifier.findMany({
        where: {
          partyId: inParties,
          type: { in: [...PLAIN_IDENTIFIER_TYPES] },
          deletedAt: null,
          ...live,
        },
        orderBy: [{ validFrom: 'asc' }, { id: 'asc' }],
        select: { id: true, partyId: true, type: true, valuePlain: true, valueMasked: true },
      }),
      await db.orgUnit.findMany({
        where: {
          id: {
            in: [...people.values()].flatMap((p) => (p.orgUnitId === null ? [] : [p.orgUnitId])),
          },
        },
        select: { id: true, name: true },
      }),
      await db.dailyPerformance.findMany({
        where: { isCurrent: true, businessDate: toDay(figuresDate), partyId: inParties },
        select: {
          partyId: true,
          ordersCompleted: true,
          workingMinutes: true,
          lateMinutes: true,
          metrics: true,
        },
      }),
      await db.trackingEntry.findMany({
        where: { businessDate: day, partyId: inParties, deletedAt: null },
      }),
      await db.callLog.groupBy({
        by: ['partyId'],
        where: { businessDate: day, partyId: inParties },
      }),
      await db.callLog.findMany({
        where: { partyId: inParties, businessDate: { lte: day } },
        orderBy: [{ partyId: 'asc' }, { at: 'desc' }, { id: 'desc' }],
        distinct: ['partyId'],
      }),
      await db.idOperatorPeriod.findMany({
        where: {
          ownerPartyId: inParties,
          deletedAt: null,
          fromDate: { lte: day },
          OR: [{ toDate: null }, { toDate: { gte: day } }],
        },
        orderBy: [{ fromDate: 'desc' }],
      }),
    ];
  const statuses = await statusesOn(
    db,
    [...people.values()].map((p) => p.employee),
    date,
    today,
  );
  const outcomeCodes = await lookupCodes(
    db,
    lastCalls.map((c) => c.outcomeId),
  );

  const nameOf = new Map(parties.map((p) => [p.id, p.displayName]));
  const zoneOf = new Map(zones.map((z) => [z.id, z.name]));
  const phoneOf = new Map<string, string>();
  for (const phone of phones)
    if (!phoneOf.has(phone.partyId)) phoneOf.set(phone.partyId, phone.value);
  const idsOf = new Map<string, PlatformId[]>();
  for (const id of identifiers) {
    idsOf.set(id.partyId, [
      ...(idsOf.get(id.partyId) ?? []),
      { identifierId: id.id, type: id.type, value: id.valuePlain ?? id.valueMasked },
    ]);
  }
  const figuresOf = new Map<
    string,
    { orders: number; minutes: number; late: number | null; sheet: SheetStatus | null }
  >();
  for (const row of figures) {
    if (row.partyId === null) continue;
    const known = figuresOf.get(row.partyId) ?? { orders: 0, minutes: 0, late: null, sheet: null };
    known.orders += row.ordersCompleted ?? 0;
    known.minutes += row.workingMinutes ?? 0;
    if (row.lateMinutes !== null) known.late = (known.late ?? 0) + row.lateMinutes;
    known.sheet ??= sheetStatusOf(row.metrics);
    figuresOf.set(row.partyId, known);
  }
  const entryOf = new Map(entries.map((e) => [e.partyId, e]));
  const calledOn = new Set(callsToday.map((c) => c.partyId));
  const lastCallOf = new Map(lastCalls.map((c) => [c.partyId, c]));
  const operatorOf = new Map<string, OperatorRow>();
  for (const op of operators)
    if (!operatorOf.has(op.ownerPartyId)) operatorOf.set(op.ownerPartyId, op);

  const rows: SheetRow[] = partyIds.map((partyId) => {
    const placement = people.get(partyId);
    if (placement === undefined) throw new Error('call sheet: placement lost');
    const statusCode = statuses.get(placement.employee.id) ?? null;
    const figure = figuresOf.get(partyId);
    const entry = entryOf.get(partyId);
    const lastCall = lastCallOf.get(partyId);
    const operator = operatorOf.get(partyId);
    const sheetStatus = figure?.sheet ?? null;
    return {
      partyId,
      employeeId: placement.employee.id,
      employeeCode: placement.employee.employeeCode,
      name: nameOf.get(partyId) ?? '',
      platformIds: idsOf.get(partyId) ?? [],
      profession: placement.profession,
      zone: placement.orgUnitId === null ? null : (zoneOf.get(placement.orgUnitId) ?? null),
      phone: phoneOf.get(partyId) ?? null,
      statusCode,
      yesterday: {
        orders: figure?.orders ?? null,
        hours: figure === undefined ? null : Math.round((figure.minutes / 60) * 100) / 100,
        lateMinutes: figure?.late ?? null,
      },
      sheetStatus,
      entry: entry === undefined ? null : entryView(entry),
      calledToday: calledOn.has(partyId) || (entry?.callOutcomeId ?? null) !== null,
      lastCall: lastCall === undefined ? null : callView(lastCall, outcomeCodes),
      operator: operator === undefined ? null : operatorView(operator),
      crossCheck: crossCheck({
        ourStatus: statusCode,
        reported,
        orders: figure?.orders ?? null,
        sheet: sheetStatus,
      }),
    };
  });
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.employeeCode.localeCompare(b.employeeCode));
  const unfiltered = { totalPeople: rows.length, byStatus: {} as Record<string, number> };
  for (const row of rows) {
    const key = row.statusCode ?? 'none';
    unfiltered.byStatus[key] = (unfiltered.byStatus[key] ?? 0) + 1;
  }
  const shown = rows.filter((row) => matchesFilters(row, filters, reported));
  const summary = summarise(
    shown.map((row) => ({
      statusCode: row.statusCode,
      called: row.calledToday,
      orders: row.yesterday.orders,
      workingMinutes: figuresOf.get(row.partyId)?.minutes ?? null,
      statusChanged: ['applied', 'pending', 'failed'].includes(row.entry?.statusState ?? 'none'),
      operatedByOther: row.operator !== null,
      flagged: row.crossCheck.length > 0,
    })),
    reported,
  );
  return {
    date,
    figuresDate,
    reported,
    summary,
    rows: shown,
    filtered: shown.length !== rows.length,
    unfiltered,
    lowHoursLimit,
  };
}
