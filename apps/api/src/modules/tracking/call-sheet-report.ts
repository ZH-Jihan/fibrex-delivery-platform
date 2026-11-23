/**
 * The call sheet as a report (phase 4 row 4.8b): `tracking.call_sheet`, so "Export to Excel"
 * on the call sheet goes through the report engine's own CSV and Excel writers.
 *
 * Purpose: one line per person of the sheet of a date with yesterday's figures, our status and
 * the day's call outcome and notes. It takes the same filters as `GET /tracking` and calls the
 * same `loadCallSheet`, so the file holds exactly the people the screen lists and the numbers
 * the strip shows.
 *
 * Rules, and why:
 *   - The date defaults to today in Qatar (the business date of the morning call).
 *   - Only a call made on the sheet's own date is shown as its outcome; an older call is
 *     history, not today's outcome.
 *   - Outcome text is the English label of the lookup value (the file is for people to read).
 *   - Row 4.8c adds the sheet's details: day off, duty time (from - to), break (from - to),
 *     plate, driver or rider, skill, tags and "COD (pending amount)" with its currency. The COD
 *     amount is filled only when the caller holds performance.amounts.view (`canSeeAmounts`);
 *     without it the cells stay empty. The balance amount is never exported.
 *
 * Depends on: ./call-sheet.ts, ../performance (qatarToday), kernel/db. Used by: ./index.ts.
 */
import type { Db } from '../../kernel/db/prisma.js';
import type { ReportDef } from '../../kernel/module-registry/manifest.js';
import { qatarToday } from '../performance/index.js';
import { loadCallSheet } from './call-sheet.js';

const YES_NO = [
  { value: 'true', label: 'Yes' },
  { value: 'false', label: 'No' },
] as const;

/** Builds the report. `canSeeAmounts` tells whether the caller may see COD amounts. */
export function createCallSheetReport(canSeeAmounts: () => Promise<boolean>): ReportDef {
  return {
    key: 'tracking.call_sheet',
    label: 'Morning call sheet',
    description:
      "The morning call sheet of a day (default today): each person's yesterday figures, status and the day's call outcome and note. Takes the same filters as the screen.",
    permission: 'tracking.entry.view',
    columns: [
      { key: 'personName', label: 'Person', type: 'text', sortable: true },
      { key: 'employeeCode', label: 'Employee code', type: 'text', sortable: true },
      { key: 'platformId', label: 'Platform ID', type: 'text', sortable: true },
      { key: 'zone', label: 'Zone', type: 'text', sortable: true },
      { key: 'dayOff', label: 'Day off', type: 'text', sortable: true },
      { key: 'dayOffToday', label: 'Day off today', type: 'boolean', sortable: true },
      { key: 'dutyTime', label: 'Duty time', type: 'text' },
      { key: 'breakTime', label: 'Break', type: 'text' },
      { key: 'plate', label: 'Plate number', type: 'text' },
      { key: 'vehicleType', label: 'Driver or rider', type: 'text' },
      { key: 'skill', label: 'Skill', type: 'text' },
      { key: 'tags', label: 'Tags', type: 'text' },
      { key: 'cod', label: 'COD (pending amount)', type: 'number', sortable: true },
      { key: 'currency', label: 'Currency', type: 'text' },
      { key: 'phone', label: 'Phone', type: 'text' },
      { key: 'status', label: 'Status', type: 'text', sortable: true },
      { key: 'orders', label: 'Orders yesterday', type: 'number', sortable: true },
      { key: 'hours', label: 'Hours yesterday', type: 'number', sortable: true },
      { key: 'lateMinutes', label: 'Late minutes', type: 'number', sortable: true },
      { key: 'called', label: 'Called', type: 'boolean', sortable: true },
      { key: 'outcome', label: 'Call outcome', type: 'text', sortable: true },
      { key: 'calledAt', label: 'Last call at', type: 'datetime' },
      { key: 'note', label: 'Note', type: 'text' },
    ],
    filters: [
      { key: 'date', label: 'Day', type: 'date' },
      { key: 'status', label: 'Status', type: 'text' },
      { key: 'q', label: 'Search', type: 'text' },
      { key: 'notCalled', label: 'Not yet called', type: 'select', options: YES_NO },
      { key: 'zeroOrders', label: 'Zero orders yesterday', type: 'select', options: YES_NO },
      { key: 'dayOffToday', label: 'Day off today', type: 'select', options: YES_NO },
    ],
    async run(db: Db, input) {
      const date = input.filters.date ?? qatarToday();
      const sheet = await loadCallSheet(
        db,
        date,
        new Date().toISOString().slice(0, 10),
        {
          status: input.filters.status,
          q: input.filters.q,
          notCalled: input.filters.notCalled === 'true',
          zeroOrders: input.filters.zeroOrders === 'true',
          dayOffToday: input.filters.dayOffToday === 'true',
        },
        undefined,
        await canSeeAmounts(),
      );
      // Outcome labels (English) for the calls shown.
      const ids = sheet.rows.flatMap((r) => (r.lastCall === null ? [] : [r.lastCall.outcomeId]));
      const values =
        ids.length === 0 ? [] : await db.lookupValue.findMany({ where: { id: { in: ids } } });
      const labelOf = new Map(
        values.map((v) => [
          v.id,
          typeof (v.labels as { en?: unknown } | null)?.en === 'string'
            ? (v.labels as { en: string }).en
            : v.code,
        ]),
      );
      const rows = sheet.rows.map((row) => {
        const call =
          row.lastCall !== null && row.lastCall.businessDate === date ? row.lastCall : null;
        const notes = [call?.note, row.entry?.note].filter((n): n is string => !!n);
        return {
          personName: row.name,
          employeeCode: row.employeeCode,
          platformId: row.platformIds.map((p) => p.value).join(', '),
          zone: row.sheet.zone ?? row.zone,
          dayOff: row.sheet.dayOff.text,
          dayOffToday: row.sheet.dayOff.isToday,
          dutyTime: range(row.sheet.dutyTime),
          breakTime: range(row.sheet.break),
          plate: row.sheet.plate,
          vehicleType: row.sheet.vehicleType,
          skill: row.sheet.skill,
          tags: row.sheet.tags,
          cod: row.sheet.cod === null ? null : Number(row.sheet.cod.amount),
          currency: row.sheet.cod?.currency ?? null,
          phone: row.phone,
          status: row.statusCode,
          orders: row.yesterday.orders,
          hours: row.yesterday.hours,
          lateMinutes: row.yesterday.lateMinutes,
          called: row.calledToday,
          outcome: call === null ? null : (labelOf.get(call.outcomeId) ?? call.outcomeCode),
          calledAt: call?.at ?? null,
          note: notes.length === 0 ? null : notes.join(' | '),
        };
      });
      const sort = input.sort;
      if (sort !== undefined) {
        const direction = sort.direction === 'desc' ? -1 : 1;
        rows.sort((a, b) => {
          const x = a[sort.key as keyof typeof a] ?? '';
          const y = b[sort.key as keyof typeof b] ?? '';
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
    },
  };
}

/** The report with no amounts (for callers that have no permission service). */
export const callSheetReport = createCallSheetReport(() => Promise.resolve(false));

/** "from - to" of a duty time or break, else the sheet's own text. */
function range(r: { from: string | null; to: string | null; text: string | null }): string | null {
  if (r.from !== null || r.to !== null) return [r.from ?? '?', r.to ?? '?'].join(' - ');
  return r.text;
}
