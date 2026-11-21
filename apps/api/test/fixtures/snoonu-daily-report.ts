/**
 * Fixture: a Snoonu `Daily Report` tab in the real layout, filled with FAKE people
 * (phase 4 row 4.2). No name, Falcon ID or phone number here belongs to anyone; the real
 * saved copy in `reference/` is never copied into the repository (CLAUDE.md, plan section 9).
 *
 * Layout copied from the saved copy of 2026-11-20 (plan section 2):
 *   row 1   report title and totals in A to F; "Nth of the month" over all 7 columns of each
 *           day block, from column P, days 1 to 31 in calendar order
 *   row 2   "Pending Amount -" / "Balance Amount +" in N and O; metric names in each block;
 *           summary labels after the last block
 *   row 3   headers of A to M, with F and G (Break start / Break End) blank as in the copy;
 *           totals in N, O, the blocks and the summary columns
 *   row 4+  one row per person, then blank rows with no Public ID
 * Public IDs and phones are numbers, break times are Excel time cells, Kms and AVG KM per
 * Order are blank, and a day with no figures is blank (or 0 after a cycle reset).
 *
 * Used by: src/modules/performance/snoonu-parser.test.ts, the sync engine tests (row 4.3).
 */
import ExcelJS from 'exceljs';
import type { SheetCell, SheetGrid } from '../../src/modules/performance/report-adapter.js';

export const FIXTURE_TAB = 'Daily Report';

export interface FakePerson {
  falconId: number;
  name: string;
  phone: number;
  type: 'Driver' | 'Rider';
  zone: string;
  schedule: string;
  dayOff: string;
  /** HH:MM, or null when the sheet shows no break. */
  breakStart: string | null;
  breakEnd: string | null;
  plate: string;
}

export const FAKE_PEOPLE: readonly FakePerson[] = [
  {
    falconId: 90001,
    name: 'Test Rider Alpha',
    phone: 97455500001,
    type: 'Rider',
    zone: 'Zone North',
    schedule: '14:00-02:00',
    dayOff: 'Saturday',
    breakStart: '17:00',
    breakEnd: '18:00',
    plate: 'TEST-001',
  },
  {
    falconId: 90002,
    name: 'Test Driver Bravo',
    phone: 97455500002,
    type: 'Driver',
    zone: 'Zone South',
    schedule: '08:00-20:00',
    dayOff: 'Monday',
    breakStart: '23:00',
    breakEnd: '00:00',
    plate: 'TEST-002',
  },
  {
    falconId: 90003,
    name: 'Test Rider Charlie',
    phone: 97455500003,
    type: 'Rider',
    zone: 'NA',
    schedule: 'NA',
    dayOff: 'NA',
    breakStart: null,
    breakEnd: null,
    plate: 'NA',
  },
  {
    falconId: 90004,
    name: 'Test Driver Delta',
    phone: 97455500004,
    type: 'Driver',
    zone: 'Zone East',
    schedule: '17:00-05:00',
    dayOff: 'Friday',
    breakStart: '16:00',
    breakEnd: '17:00',
    plate: 'TEST-004',
  },
];

/** Blocks with figures in the saved copy (downloaded 2026-11-20): 26 to 31 and 1 to 19. */
export const REAL_FILLED_DAYS: readonly number[] = [
  26, 27, 28, 29, 30, 31, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
];

export const METRIC_LABELS = [
  'Assigned',
  'Delivered',
  'Acceptance Rate',
  'Working Hours',
  'Late Log In By Min',
  'Kms',
  'AVG KM per Order',
] as const;

const FIXED_HEADERS = [
  'Public ID',
  'Name',
  'Company',
  'Day OFF',
  'Schedule',
  null,
  null,
  'Zone',
  'Contact Number',
  'Driver / Rider',
  'Plate Number',
  'Skill',
  'Tags',
];
export const FIRST_BLOCK_COLUMN = 15; // column P (0-based)
export const BLOCK_WIDTH = 7;
const SUMMARY_LABELS = ['Ave. Orders ', 'PERFORMANCE', 'Working / Not Working'];

/** Fake figures of one person on one day, or null when that person did not work. */
export interface DayFigures {
  assigned: number;
  delivered: number;
  acceptanceRate: number;
  workingHours: number;
  lateMinutes: number;
}

/**
 * Deterministic fake figures. Every ninth person-day is a day off (blank), so absences are
 * covered; late minutes are sometimes 0 (on time) while orders are not.
 */
export function fakeFigures(person: FakePerson, day: number): DayFigures | null {
  if ((person.falconId + day) % 9 === 0) return null;
  const delivered = 5 + ((person.falconId + day * 3) % 17);
  const assigned = delivered + (day % 3 === 0 ? 1 : 0);
  return {
    assigned,
    delivered,
    acceptanceRate: delivered / assigned,
    workingHours: 4 + ((person.falconId + day) % 16) / 2,
    lateMinutes: (person.falconId * day) % 40,
  };
}

/** Column index (0-based) of day block `day`. */
export function blockColumn(day: number): number {
  return FIRST_BLOCK_COLUMN + (day - 1) * BLOCK_WIDTH;
}

function ordinal(day: number): string {
  const suffix =
    day % 10 === 1 && day !== 11
      ? 'st'
      : day % 10 === 2 && day !== 12
        ? 'nd'
        : day % 10 === 3 && day !== 13
          ? 'rd'
          : 'th';
  return `${day}${suffix} of the month`;
}

/** An Excel time cell (exceljs reads time-only cells as a date on 1899-12-30). */
function excelTime(hhmm: string | null): Date | null {
  if (hhmm === null) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(1899, 11, 30, h ?? 0, m ?? 0));
}

export interface FixtureOptions {
  people?: readonly FakePerson[];
  /** Day blocks that carry figures; other blocks are blank. */
  filledDays?: readonly number[];
  /** Every day block value is 0, as after Snoonu's cycle reset. */
  reset?: boolean;
  /** Blank rows (no Public ID) after the people, as in the real sheet. */
  trailingBlankRows?: number;
}

/** The fixture as a grid of raw cells (what a source returns). */
export function snoonuGrid(options: FixtureOptions = {}): SheetGrid {
  const people = options.people ?? FAKE_PEOPLE;
  const filled = new Set(options.filledDays ?? REAL_FILLED_DAYS);
  const summaryStart = blockColumn(32);
  const width = summaryStart + SUMMARY_LABELS.length;
  const blankRow = (): SheetCell[] => Array.from({ length: width }, () => null);

  const row1 = blankRow();
  const row2 = blankRow();
  const row3 = blankRow();
  row1[0] = 'Fake Fleet Company';
  row1[1] = 'Drivers & Riders Monthly Performance';
  row1[2] = 'Total Rider';
  row1[3] = people.filter((p) => p.type === 'Rider').length;
  row1[4] = 'Total Driver';
  row1[5] = people.filter((p) => p.type === 'Driver').length;
  row2[0] = 'Performance Report ';
  row2[2] = 'Total Active >>>>>: ';
  row2[3] = people.length;
  row2[13] = 'Pending Amount -';
  row2[14] = 'Balance Amount +';
  FIXED_HEADERS.forEach((h, i) => (row3[i] = h));
  row3[13] = -1234.5;
  row3[14] = 56.25;
  for (let day = 1; day <= 31; day += 1) {
    METRIC_LABELS.forEach((label, offset) => {
      row1[blockColumn(day) + offset] = ordinal(day);
      row2[blockColumn(day) + offset] = label;
    });
    row3[blockColumn(day) + 1] = filled.has(day) ? 123 : null; // a total, as in the copy
  }
  SUMMARY_LABELS.forEach((label, i) => {
    row2[summaryStart + i] = label;
    row3[summaryStart + i] = i === 0 ? 7.5 : people.length;
  });

  const rows: SheetCell[][] = [row1, row2, row3];
  people.forEach((p) => {
    const row = blankRow();
    row[0] = p.falconId;
    row[1] = p.name;
    row[2] = 'Fake Fleet Company';
    row[3] = p.dayOff;
    row[4] = p.schedule;
    row[5] = excelTime(p.breakStart);
    row[6] = excelTime(p.breakEnd);
    row[7] = p.zone;
    row[8] = p.phone;
    row[9] = p.type;
    row[10] = p.plate;
    row[11] = 'General';
    row[12] = 'General';
    row[13] = -100;
    row[14] = 0;
    let delivered = 0;
    for (let day = 1; day <= 31; day += 1) {
      const c = blockColumn(day);
      if (options.reset === true) {
        for (let offset = 0; offset < 5; offset += 1) row[c + offset] = 0;
        continue;
      }
      const f = filled.has(day) ? fakeFigures(p, day) : null;
      if (f === null) continue;
      row[c] = f.assigned;
      row[c + 1] = f.delivered;
      row[c + 2] = f.acceptanceRate;
      row[c + 3] = f.workingHours;
      row[c + 4] = f.lateMinutes;
      delivered += f.delivered;
    }
    row[summaryStart] = delivered / 25;
    row[summaryStart + 1] = delivered > 200 ? 'Good' : 'Poor';
    row[summaryStart + 2] = 'Working';
    rows.push(row);
  });
  for (let i = 0; i < (options.trailingBlankRows ?? 3); i += 1) rows.push(blankRow());
  return { tab: FIXTURE_TAB, rows };
}

/** Writes a grid as an .xlsx workbook (the tab plus one other, as the real file has). */
export async function gridToXlsx(grid: SheetGrid): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(grid.tab);
  grid.rows.forEach((cells, r) => {
    cells.forEach((value, c) => {
      if (value !== null) sheet.getCell(r + 1, c + 1).value = value;
    });
  });
  workbook.addWorksheet('FDB Report').addRow(['Falcon ID', 'Agent Name']);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** The fixture as an .xlsx file, like a downloaded copy of the sheet. */
export async function snoonuWorkbook(options: FixtureOptions = {}): Promise<Buffer> {
  return gridToXlsx(snoonuGrid(options));
}
