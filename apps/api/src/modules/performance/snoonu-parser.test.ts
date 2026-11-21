import { SNOONU_DEFAULT_MAPPING, type SheetColumnMapping } from '@fibrex/shared';
import { describe, expect, it } from 'vitest';
import {
  BLOCK_WIDTH,
  blockColumn,
  FAKE_PEOPLE,
  fakeFigures,
  FIXTURE_TAB,
  gridToXlsx,
  snoonuGrid,
  snoonuWorkbook,
} from '../../../test/fixtures/snoonu-daily-report.js';
import {
  excelFileSource,
  memorySource,
  type ParseOutcome,
  type ParsedReport,
  type SheetGrid,
} from './report-adapter.js';
import { columnLetter, snoonuReportAdapter } from './snoonu-parser.js';

const context = (readOn: string, mapping: SheetColumnMapping = SNOONU_DEFAULT_MAPPING) => ({
  mapping,
  cycleStartDay: 26,
  readOn,
});

function parse(grid: SheetGrid, readOn = '2026-11-20', mapping?: SheetColumnMapping): ParseOutcome {
  return snoonuReportAdapter.parse(grid, context(readOn, mapping));
}

function report(outcome: ParseOutcome): ParsedReport {
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.problems));
  return outcome.report;
}

/** Sets one cell of a grid (1-based row, 0-based column), growing the row if needed. */
function setCell(
  grid: SheetGrid,
  row: number,
  column: number,
  value: SheetGrid['rows'][number][number],
) {
  const cells = grid.rows[row - 1];
  if (cells === undefined) throw new Error(`The fixture has no row ${row}`);
  cells[column] = value;
}

const [alpha] = FAKE_PEOPLE;
if (alpha === undefined) throw new Error('The fixture has no people');

describe('Snoonu Daily Report parser, from an Excel file in the real layout', () => {
  it('dates each filled block inside the 26th-to-25th cycle and reads every person', async () => {
    const grid = await excelFileSource(await snoonuWorkbook()).read(FIXTURE_TAB);
    // Read on 20 Nov: complete figures up to 19 Nov, cycle 26 Oct to 25 Nov.
    const r = report(parse(grid, '2026-11-20'));
    expect(r.cycle).toEqual({ start: '2026-10-26', end: '2026-11-25' });
    expect(r.dataThrough).toBe('2026-11-19');
    expect(r.resetDetected).toBe(false);
    expect(r.filledDates).toHaveLength(25);
    expect(r.filledDates[0]).toBe('2026-10-26');
    expect(r.filledDates.at(-1)).toBe('2026-11-19');

    const byDay = new Map(r.blocks.map((b) => [b.dayOfMonth, b]));
    expect(byDay.get(26)).toMatchObject({ date: '2026-10-26', status: 'filled', column: 'GI' });
    expect(byDay.get(1)).toMatchObject({ date: '2026-11-01', status: 'filled', column: 'P' });
    // Block 20 is the read date itself, 21 to 25 have not happened: blank in the sheet.
    expect(byDay.get(20)).toMatchObject({ date: '2026-11-20', status: 'today' });
    expect(byDay.get(21)).toMatchObject({
      date: '2026-11-21',
      status: 'future',
      peopleWithFigures: 0,
    });

    // The trailing blank rows are not people.
    expect(r.people.map((p) => p.identifier)).toEqual(['90001', '90002', '90003', '90004']);
    expect(r.rowErrors).toEqual([]);
  });

  it('reads the fixed columns, the unheaded break times and keeps unknown columns', async () => {
    const grid = await excelFileSource(await snoonuWorkbook()).read(FIXTURE_TAB);
    const r = report(parse(grid));
    const [first, , third] = r.people;
    expect(first?.row).toBe(4);
    expect(first?.fields).toMatchObject({
      name: 'Test Rider Alpha',
      contact_number: '97455500001',
      vehicle_type: 'Rider',
      schedule: '14:00-02:00',
      break_start: '17:00',
      break_end: '18:00',
      day_off: 'Saturday',
      pending_amount: -100,
      balance_amount: 0,
    });
    // "NA" in the sheet means nothing.
    expect(third?.fields).toMatchObject({ zone: null, schedule: null, break_start: null });
    // The summary columns after the last block are kept, not dropped.
    expect(typeof first?.extra['Ave. Orders']).toBe('number');
    expect(typeof first?.extra.PERFORMANCE).toBe('string');
    expect(r.unknownColumns).toEqual(
      expect.arrayContaining(['Ave. Orders', 'PERFORMANCE', 'Working / Not Working']),
    );
  });

  it('turns Delivered into orders and Working Hours into minutes; a blank day is no day', async () => {
    const grid = await excelFileSource(await snoonuWorkbook()).read(FIXTURE_TAB);
    const r = report(parse(grid));
    const person = r.people[0];
    const days = new Map(person?.days.map((d) => [d.date, d]));

    const day27 = fakeFigures(alpha, 27);
    expect(day27).not.toBeNull();
    expect(days.get('2026-10-27')).toEqual({
      date: '2026-10-27',
      ordersCompleted: day27?.delivered,
      workingMinutes: Math.round((day27?.workingHours ?? 0) * 60),
      lateMinutes: day27?.lateMinutes,
      metrics: {
        assigned: day27?.assigned,
        delivered: day27?.delivered,
        acceptance_rate: day27?.acceptanceRate,
        working_hours: day27?.workingHours,
        late_minutes: day27?.lateMinutes,
        kms: null,
        avg_km_per_order: null,
      },
    });
    // 90001 + 8 is a multiple of 9: a day off, blank in the sheet, so no row for 8 Nov.
    expect(fakeFigures(alpha, 8)).toBeNull();
    expect(days.has('2026-11-08')).toBe(false);
    expect(days.has('2026-11-20')).toBe(false);
    expect(person?.days.map((d) => d.date)).toEqual(
      [...(person?.days.map((d) => d.date) ?? [])].sort(),
    );
  });
});

describe('cycle reset and a sheet that has not reset yet', () => {
  it('flags a reset sheet (every block 0) and dates nothing', () => {
    const r = report(parse(snoonuGrid({ reset: true }), '2026-11-27'));
    expect(r.resetDetected).toBe(true);
    expect(r.filledDates).toEqual([]);
    expect(r.people).toHaveLength(4);
    expect(r.people.every((p) => p.days.length === 0)).toBe(true);
  });

  it('refuses a sheet still showing last cycle: figures on dates that have not come', () => {
    // Read on 27 Nov the cycle is 26 Nov to 25 Dec; blocks 1 to 19 would be December.
    const outcome = parse(snoonuGrid(), '2026-11-27');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.problems.every((p) => p.code === 'cycle_mismatch')).toBe(true);
    expect(outcome.problems.map((p) => p.column)).toContain(columnLetter(blockColumn(1)));
  });

  it('reads the whole cycle on the 26th, before the reset', () => {
    const all = Array.from({ length: 31 }, (_, i) => i + 1);
    const r = report(parse(snoonuGrid({ filledDays: all }), '2026-11-26'));
    expect(r.cycle).toEqual({ start: '2026-10-26', end: '2026-11-25' });
    expect(r.filledDates).toHaveLength(31);
    expect(r.filledDates.at(-1)).toBe('2026-11-25');
  });

  it('gives no date to the 31st block in a cycle whose first month has 30 days', () => {
    // Read on 1 Dec: cycle 26 Nov to 25 Dec, figures for 26 to 30 Nov only.
    const r = report(parse(snoonuGrid({ filledDays: [26, 27, 28, 29, 30] }), '2026-12-01'));
    expect(r.blocks.find((b) => b.dayOfMonth === 31)).toMatchObject({
      date: null,
      status: 'no_such_date',
    });
    expect(r.filledDates).toEqual([
      '2026-11-26',
      '2026-11-27',
      '2026-11-28',
      '2026-11-29',
      '2026-11-30',
    ]);
    // The same sheet with figures in block 31 is last cycle's: refused.
    const stale = parse(snoonuGrid({ filledDays: [26, 27, 28, 29, 30, 31] }), '2026-12-01');
    expect(stale.ok).toBe(false);
  });

  it('does not use partial figures in the block for the read date itself', () => {
    const r = report(parse(snoonuGrid({ filledDays: [...REAL, 20] }), '2026-11-20'));
    const block20 = r.blocks.find((b) => b.dayOfMonth === 20);
    expect(block20).toMatchObject({ status: 'today' });
    expect(block20?.peopleWithFigures).toBeGreaterThan(0);
    expect(r.filledDates).not.toContain('2026-11-20');
  });
});

const REAL = [26, 27, 28, 29, 30, 31, ...Array.from({ length: 19 }, (_, i) => i + 1)];

describe('unexpected layouts', () => {
  it('reports a renamed metric, and the alias in the mapping fixes it without code', () => {
    const grid = snoonuGrid();
    for (let day = 1; day <= 31; day += 1)
      setCell(grid, 2, blockColumn(day) + 1, 'Completed Orders');
    const outcome = parse(grid);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.problems).toHaveLength(31);
      expect(outcome.problems[0]).toMatchObject({ code: 'missing_metric', column: 'P' });
    }
    const mapping: SheetColumnMapping = structuredClone(SNOONU_DEFAULT_MAPPING);
    mapping.metrics.delivered?.aliases.push('Completed Orders');
    const r = report(parse(grid, '2026-11-20', mapping));
    expect(r.people[0]?.days.find((d) => d.date === '2026-11-01')?.ordersCompleted).toBe(
      fakeFigures(alpha, 1)?.delivered,
    );
  });

  it('finds fixed columns by header, not position', () => {
    const grid = snoonuGrid();
    // Swap Name (B) and Zone (H) in every row.
    for (const cells of grid.rows) [cells[1], cells[7]] = [cells[7] ?? null, cells[1] ?? null];
    const r = report(parse(grid));
    expect(r.people[0]?.fields).toMatchObject({ name: 'Test Rider Alpha', zone: 'Zone North' });
  });

  it('reports a missing Public ID header, missing titles and uneven blocks', () => {
    const noId = snoonuGrid();
    setCell(noId, 3, 0, 'Rider Code');
    expect(parse(noId)).toMatchObject({ ok: false, problems: [{ code: 'missing_field' }] });

    const noTitles = snoonuGrid();
    noTitles.rows[0]?.fill(null);
    expect(parse(noTitles)).toMatchObject({ ok: false, problems: [{ code: 'no_day_blocks' }] });

    const uneven = snoonuGrid();
    // Block 5 starts one column late.
    setCell(uneven, 1, blockColumn(5), '4th of the month');
    const outcome = parse(uneven);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.problems.map((p) => p.code)).toContain('uneven_day_blocks');

    const twice = snoonuGrid();
    for (let o = 0; o < BLOCK_WIDTH; o += 1)
      setCell(twice, 1, blockColumn(2) + o, '1st of the month');
    // Block "1" then "1" again directly after reads as one wide block, so make a gap.
    setCell(twice, 1, blockColumn(2), '3rd of the month');
    for (let o = 1; o < BLOCK_WIDTH; o += 1) setCell(twice, 1, blockColumn(2) + o, null);
    expect(parse(twice).ok).toBe(false);
  });

  it('keeps an unknown column inside a block under its own key', () => {
    const grid = snoonuGrid();
    for (let day = 1; day <= 31; day += 1) setCell(grid, 2, blockColumn(day) + 5, 'Cash Orders');
    setCell(grid, 4, blockColumn(1) + 5, 3);
    const r = report(parse(grid));
    expect(r.unknownColumns).toContain('Cash Orders');
    expect(r.people[0]?.days.find((d) => d.date === '2026-11-01')?.metrics).toMatchObject({
      cash_orders: 3,
    });
    expect(r.people[0]?.days.find((d) => d.date === '2026-11-01')?.metrics).not.toHaveProperty(
      'kms',
    );
  });
});

describe('row problems', () => {
  it('leaves out every row of a Public ID that appears twice', () => {
    const grid = snoonuGrid();
    setCell(grid, 5, 0, alpha.falconId);
    const r = report(parse(grid));
    expect(r.people.map((p) => p.identifier)).toEqual(['90003', '90004']);
    expect(r.rowErrors).toEqual([
      expect.objectContaining({
        row: 4,
        code: 'duplicate_identifier',
        identifier: '90001',
        column: 'A',
      }),
      expect.objectContaining({ row: 5, code: 'duplicate_identifier', identifier: '90001' }),
    ]);
  });

  it('reports a cell that is not a number, ignores #DIV/0! and refuses part orders', () => {
    const grid = snoonuGrid();
    setCell(grid, 4, blockColumn(1) + 1, 'abc');
    setCell(grid, 4, blockColumn(1) + 6, '#DIV/0!');
    setCell(grid, 5, blockColumn(2) + 1, 2.5);
    setCell(grid, 6, blockColumn(3) + 3, 30);
    const r = report(parse(grid));
    expect(r.rowErrors.map((e) => [e.row, e.code, e.column])).toEqual([
      [4, 'bad_value', columnLetter(blockColumn(1) + 1)],
      [5, 'bad_value', columnLetter(blockColumn(2) + 1)],
      [6, 'bad_value', columnLetter(blockColumn(3) + 3)],
    ]);
    const day1 = r.people[0]?.days.find((d) => d.date === '2026-11-01');
    // The other figures of the day are still used.
    expect(day1).toMatchObject({
      ordersCompleted: null,
      metrics: { delivered: null, avg_km_per_order: null },
    });
    expect(day1?.workingMinutes).toBe(Math.round((fakeFigures(alpha, 1)?.workingHours ?? 0) * 60));
  });
});

describe('late login', () => {
  it('counts an early login (negative minutes) as 0 late and keeps the raw figure', () => {
    const grid = snoonuGrid();
    setCell(grid, 4, blockColumn(1) + 4, -246);
    const r = report(parse(grid));
    const day1 = r.people[0]?.days.find((d) => d.date === '2026-11-01');
    expect(day1).toMatchObject({ lateMinutes: 0, metrics: { late_minutes: -246 } });
    expect(r.rowErrors).toEqual([]);
  });
});

describe('a grid as the Google Sheets reader will give it', () => {
  it('reads text ids, day-fraction times and titles only over the first block column', async () => {
    const grid = snoonuGrid();
    for (let day = 1; day <= 31; day += 1) {
      for (let o = 1; o < BLOCK_WIDTH; o += 1) setCell(grid, 1, blockColumn(day) + o, null);
    }
    setCell(grid, 4, 0, ' 90001 ');
    setCell(grid, 4, 5, 17 / 24);
    setCell(grid, 4, 6, '18:00');
    setCell(grid, 4, blockColumn(1) + 2, '95%');
    const r = report(parse(await memorySource([grid]).read(FIXTURE_TAB)));
    expect(r.filledDates).toHaveLength(25);
    expect(r.people[0]).toMatchObject({
      identifier: '90001',
      fields: { break_start: '17:00', break_end: '18:00' },
    });
    expect(
      r.people[0]?.days.find((d) => d.date === '2026-11-01')?.metrics.acceptance_rate,
    ).toBeCloseTo(0.95);
  });
});

describe('sources', () => {
  it('reports a missing tab and an unreadable file', async () => {
    await expect(memorySource([]).read(FIXTURE_TAB)).rejects.toMatchObject({ code: 'missing_tab' });
    await expect(excelFileSource(Buffer.from('nope')).read(FIXTURE_TAB)).rejects.toMatchObject({
      code: 'unreadable_file',
    });
    const bytes = await gridToXlsx(snoonuGrid());
    await expect(excelFileSource(bytes).read('Payout_Nov26')).rejects.toMatchObject({
      code: 'missing_tab',
    });
  });

  it('gives the same result from the Excel file and from memory', async () => {
    const grid = snoonuGrid();
    const fromFile = await excelFileSource(await gridToXlsx(grid)).read(FIXTURE_TAB);
    expect(report(parse(fromFile))).toEqual(report(parse(grid)));
  });
});
