/**
 * Snoonu Daily Report parser (phase 4 row 4.2; SPEC 3.1, phase 4 plan sections 2 and 9).
 *
 * Purpose: turns the wide `Daily Report` tab into one record per person with that person's
 * figures per date. The sync engine (row 4.3) stores the result; this file only reads.
 *
 * The layout (saved copy of 2026-11-20, plan section 2):
 *
 *   row 1   day block titles: "1st of the month" ... "31st of the month" over each block
 *   row 2   metric names inside each block (Assigned, Delivered, Acceptance Rate, Working
 *           Hours, Late Log In By Min, Kms, AVG KM per Order); labels of Pending / Balance
 *           Amount and of the summary columns after the last block
 *   row 3   headers of the fixed columns A to M (Public ID, Name, ... Tags); totals elsewhere
 *   row 4+  one row per person; rows with no Public ID are not people
 *
 * Every row number and header text comes from the column mapping (SPEC 2.6), so a moved or
 * renamed column is a mapping change. Block titles must read "<day> of the month".
 *
 * How a block is dated (owner answer 2026-11-21): Snoonu's month runs from the 26th to the
 * 25th, and the sheet is one day behind. A sheet read on date D holds complete figures up to
 * D - 1, so it shows the cycle that contains D - 1, and block N is the date with day number
 * N inside that cycle (see ./cycle.ts).
 *
 * Safety rules, and why:
 *   - Blank and 0 are both "no figures". After a cycle reset every value becomes 0, so a
 *     person's day counts only when at least one figure is non-zero; zeros never become
 *     stored figures.
 *   - If every block is blank or zero, `resetDetected` is set so the sync engine keeps the
 *     figures it already has instead of replacing them.
 *   - If a block dated after D (or on a day the cycle does not have) holds figures, the sheet
 *     is still showing the previous cycle (it has not reset yet). Dating its blocks would
 *     put last cycle's figures on this cycle's dates, so the whole sheet is refused
 *     (`cycle_mismatch`) and nothing is dated. Figures in the block for D itself are partial
 *     (the day is not over) and are not used.
 *   - A Public ID that appears on two rows cannot be told apart, so both rows are left out
 *     and reported, rather than picking one.
 *   - Unknown columns are kept (`extra`, unknown metric keys), never dropped (SPEC 3.1).
 *
 * Depends on: @fibrex/shared (mapping, normaliseHeader), ./cycle.ts, ./report-adapter.ts.
 * Used by: ./index.ts, the sync engine (row 4.3).
 */
import { normaliseHeader, type ReportFieldType, type SheetColumnMapping } from '@fibrex/shared';
import { addDays, blockDate, cycleContaining } from './cycle.js';
import type {
  ClientReportAdapter,
  DayBlockStatus,
  DayBlockSummary,
  LayoutProblem,
  ParseContext,
  ParsedDay,
  ParsedPerson,
  ParseOutcome,
  RowError,
  SheetCell,
  SheetGrid,
} from './report-adapter.js';

/** Cell texts the sheet uses for "nothing here". */
const NOTHING = new Set(['', 'na', 'n/a', '-']);
/** Formula results that mean "nothing to compute" (AVG KM per Order with no orders). */
const EMPTY_FORMULA_RESULTS = new Set(['#n/a', '#div/0!']);
/** "26th of the month" after normaliseHeader. */
const BLOCK_TITLE = /^(\d{1,2})(?:st|nd|rd|th)? of the month$/;

// ---------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------

/** 0 -> "A", 25 -> "Z", 26 -> "AA". */
export function columnLetter(index: number): string {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const rest = (n - 1) % 26;
    letters = String.fromCharCode(65 + rest) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/** "A" -> 0, "AA" -> 26. */
function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function cellAt(grid: SheetGrid, row: number, column: number): SheetCell {
  return grid.rows[row - 1]?.[column] ?? null;
}

/** Text of a header cell, or null when the cell holds no text (blank, a total, a date). */
function headerOf(cell: SheetCell): string | null {
  return typeof cell === 'string' && cell.trim() !== '' ? cell.trim() : null;
}

/** A metric key for a block column no mapping knows: "Cash Orders" -> "cash_orders". */
function unknownKey(label: string): string {
  const slug = normaliseHeader(label).replace(/%/g, 'pct').replace(/ /g, '_');
  return /^[a-z]/.test(slug) ? slug : `col_${slug}`;
}

function isNothing(cell: SheetCell): boolean {
  // An unreadable date cell (the saved copy has some) holds no value either.
  if (cell instanceof Date) return Number.isNaN(cell.getTime());
  return cell === null || (typeof cell === 'string' && NOTHING.has(cell.trim().toLowerCase()));
}

/** A time of day as HH:MM from an Excel time cell, a day fraction or "H:MM" text. */
function timeOf(cell: SheetCell): string | undefined {
  let minutes: number | undefined;
  if (cell instanceof Date) minutes = cell.getUTCHours() * 60 + cell.getUTCMinutes();
  else if (typeof cell === 'number' && cell >= 0 && cell < 1) minutes = Math.round(cell * 1440);
  else if (typeof cell === 'string') {
    const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(cell.trim());
    if (match !== null && Number(match[1]) < 24 && Number(match[2]) < 60) {
      minutes = Number(match[1]) * 60 + Number(match[2]);
    }
  }
  if (minutes === undefined) return undefined;
  const h = Math.floor(minutes / 60) % 24;
  return `${String(h).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** A number from a number cell or numeric text ("1,250", "99%"); undefined when not one. */
function numberOf(cell: SheetCell): number | undefined {
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : undefined;
  if (typeof cell !== 'string') return undefined;
  const text = cell.trim().replace(/,/g, '');
  const percent = text.endsWith('%');
  const value = Number(percent ? text.slice(0, -1) : text);
  if (text === '' || !Number.isFinite(value)) return undefined;
  // A percentage is kept as a fraction, as the sheet's own Acceptance Rate is (1 = 100%).
  return percent ? value / 100 : value;
}

/** Plain text of a cell: whole numbers without decimals (ids, phones), dates as ISO. */
function textOf(cell: SheetCell): string {
  if (typeof cell === 'string') return cell.trim();
  if (typeof cell === 'number') return Number.isInteger(cell) ? cell.toFixed(0) : String(cell);
  if (typeof cell === 'boolean') return cell ? 'true' : 'false';
  if (cell instanceof Date && !Number.isNaN(cell.getTime())) return cell.toISOString().slice(0, 10);
  return '';
}

// ---------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------

interface BlockLayout {
  dayOfMonth: number;
  start: number;
  /** Metric key -> column index. */
  metricColumns: Map<string, number>;
}

interface Layout {
  blocks: BlockLayout[];
  /** Field key -> column index. */
  fieldColumns: Map<string, { column: number; type: ReportFieldType }>;
  /** Columns outside the blocks that no field claims, with their header text. */
  extraColumns: { column: number; header: string }[];
  unknownColumns: string[];
}

/** Finds the day blocks, the metric columns in each and the fixed columns. */
function readLayout(
  grid: SheetGrid,
  mapping: SheetColumnMapping,
): { layout: Layout } | { problems: LayoutProblem[] } {
  const problems: LayoutProblem[] = [];
  const width = Math.max(0, ...grid.rows.map((row) => row.length));

  // 1. Block starts: a column whose title names a day that differs from the column before
  //    (titles are repeated over all 7 columns in the saved copy; a merged title may sit in
  //    the first column only).
  const starts: { day: number; column: number }[] = [];
  let previousDay: number | null = null;
  for (let column = 0; column < width; column += 1) {
    const title = headerOf(cellAt(grid, mapping.blockTitleRow, column));
    const match = title === null ? null : BLOCK_TITLE.exec(normaliseHeader(title));
    const day = match === null ? null : Number(match[1]);
    if (day !== null && day !== previousDay) starts.push({ day, column });
    // A blank title cell continues the block it is in.
    if (title !== null) previousDay = day;
  }
  if (starts.length === 0) {
    return {
      problems: [
        {
          code: 'no_day_blocks',
          message: `No day block titles ("1st of the month" ...) in row ${mapping.blockTitleRow}.`,
        },
      ],
    };
  }
  const seenDays = new Set<number>();
  for (const s of starts) {
    if (s.day < 1 || s.day > 31 || seenDays.has(s.day)) {
      problems.push({
        code: 'duplicate_day_block',
        message: `Day block "${s.day}" appears twice or is not a day of the month.`,
        column: columnLetter(s.column),
      });
    }
    seenDays.add(s.day);
  }

  // 2. Block width: every block must be as wide as the first one. With a single block the
  //    width runs while row `blockLabelRow` has labels.
  const first = starts[0] as { day: number; column: number };
  let blockWidth: number;
  if (starts.length > 1) {
    blockWidth = (starts[1] as { column: number }).column - first.column;
    for (let i = 1; i < starts.length - 1; i += 1) {
      const gap =
        (starts[i + 1] as { column: number }).column - (starts[i] as { column: number }).column;
      if (gap !== blockWidth) {
        problems.push({
          code: 'uneven_day_blocks',
          message: `Day block ${(starts[i] as { day: number }).day} is ${gap} columns wide; the first block is ${blockWidth}.`,
          column: columnLetter((starts[i] as { column: number }).column),
        });
      }
    }
  } else {
    blockWidth = 0;
    while (headerOf(cellAt(grid, mapping.blockLabelRow, first.column + blockWidth)) !== null) {
      blockWidth += 1;
    }
  }

  // 3. Metric columns inside each block, by the labels in row `blockLabelRow`.
  const aliasToMetric = new Map<string, string>();
  for (const [key, metric] of Object.entries(mapping.metrics)) {
    for (const alias of metric.aliases) aliasToMetric.set(normaliseHeader(alias), key);
  }
  const unknownColumns = new Set<string>();
  const blocks: BlockLayout[] = starts.map((s) => {
    const metricColumns = new Map<string, number>();
    for (let offset = 0; offset < blockWidth; offset += 1) {
      const label = headerOf(cellAt(grid, mapping.blockLabelRow, s.column + offset));
      if (label === null) continue;
      const known = aliasToMetric.get(normaliseHeader(label));
      if (known === undefined) unknownColumns.add(label);
      const key = known ?? unknownKey(label);
      if (metricColumns.has(key)) {
        problems.push({
          code: 'duplicate_metric',
          message: `"${label}" appears twice in day block ${s.day}.`,
          column: columnLetter(s.column + offset),
        });
      }
      metricColumns.set(key, s.column + offset);
    }
    for (const [key, metric] of Object.entries(mapping.metrics)) {
      if (metric.required && !metricColumns.has(key)) {
        problems.push({
          code: 'missing_metric',
          message: `Day block ${s.day} has no "${metric.aliases[0] ?? key}" column.`,
          column: columnLetter(s.column),
        });
      }
    }
    return { dayOfMonth: s.day, start: s.column, metricColumns };
  });

  // 4. Fixed columns: before the first block and after the last one. A column's header is
  //    the first text found in the header row, then the label row, then the title row
  //    (Pending / Balance Amount and the summary columns are labelled in row 2, with totals
  //    in row 3).
  const lastEnd = (starts[starts.length - 1] as { column: number }).column + blockWidth;
  const outside: { column: number; header: string | null }[] = [];
  for (let column = 0; column < width; column += 1) {
    if (column >= first.column && column < lastEnd) continue;
    const header =
      headerOf(cellAt(grid, mapping.headerRow, column)) ??
      headerOf(cellAt(grid, mapping.blockLabelRow, column)) ??
      headerOf(cellAt(grid, mapping.blockTitleRow, column));
    outside.push({ column, header });
  }
  const fieldColumns = new Map<string, { column: number; type: ReportFieldType }>();
  const claimed = new Set<number>();
  for (const [key, field] of Object.entries(mapping.fields)) {
    const aliases = new Set(field.aliases.map(normaliseHeader));
    let found = outside.find(
      (c) => !claimed.has(c.column) && c.header !== null && aliases.has(normaliseHeader(c.header)),
    );
    // The fallback letter is used only for a column with no header (Break start / End).
    if (found === undefined && field.column !== undefined) {
      const index = columnIndex(field.column);
      found = outside.find((c) => c.column === index && c.header === null && !claimed.has(index));
    }
    if (found === undefined) {
      if (field.required) {
        problems.push({
          code: 'missing_field',
          message: `No "${field.aliases[0] ?? key}" column in row ${mapping.headerRow}.`,
        });
      }
      continue;
    }
    claimed.add(found.column);
    fieldColumns.set(key, { column: found.column, type: field.type });
  }
  const extraColumns: { column: number; header: string }[] = [];
  for (const c of outside) {
    if (claimed.has(c.column) || c.header === null) continue;
    extraColumns.push({ column: c.column, header: c.header });
    unknownColumns.add(c.header);
  }

  if (problems.length > 0) return { problems };
  return { layout: { blocks, fieldColumns, extraColumns, unknownColumns: [...unknownColumns] } };
}

// ---------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------

/** One person's figures in one block, before the block is dated. */
interface BlockFigures {
  hasFigures: boolean;
  day: Omit<ParsedDay, 'date'>;
}

interface PersonDraft {
  person: ParsedPerson;
  figures: BlockFigures[];
  errors: RowError[];
}

/** Reads one data row. `errors` collects bad cells; the rest of the row is still used. */
function readPerson(grid: SheetGrid, layout: Layout, row: number, identifier: string): PersonDraft {
  const errors: RowError[] = [];
  const bad = (column: number, message: string): void => {
    errors.push({ row, code: 'bad_value', message, identifier, column: columnLetter(column) });
  };

  const fields: Record<string, string | number | null> = {};
  for (const [key, { column, type }] of layout.fieldColumns) {
    if (key === 'public_id') continue;
    const cell = cellAt(grid, row, column);
    if (isNothing(cell)) {
      fields[key] = null;
      continue;
    }
    if (type === 'time') {
      const time = timeOf(cell);
      if (time === undefined) bad(column, `"${textOf(cell)}" is not a time of day.`);
      fields[key] = time ?? null;
    } else if (type === 'number') {
      const value = numberOf(cell);
      if (value === undefined) bad(column, `"${textOf(cell)}" is not a number.`);
      fields[key] = value ?? null;
    } else {
      fields[key] = textOf(cell);
    }
  }

  const extra: Record<string, string | number | null> = {};
  for (const { column, header } of layout.extraColumns) {
    const cell = cellAt(grid, row, column);
    extra[header] = isNothing(cell) ? null : typeof cell === 'number' ? cell : textOf(cell);
  }

  const figures = layout.blocks.map((block): BlockFigures => {
    const metrics: Record<string, number | null> = {};
    let hasFigures = false;
    for (const [key, column] of block.metricColumns) {
      const cell = cellAt(grid, row, column);
      let value: number | null = null;
      if (!isNothing(cell)) {
        const parsed = numberOf(cell);
        if (parsed !== undefined) value = parsed;
        else if (!EMPTY_FORMULA_RESULTS.has(textOf(cell).toLowerCase())) {
          bad(column, `"${textOf(cell)}" in day block ${block.dayOfMonth} is not a number.`);
        }
      }
      metrics[key] = value;
      // Blank and 0 both mean "no figures" (a reset sheet is all zeros).
      if (value !== null && value !== 0) hasFigures = true;
    }

    // The three figures with their own columns on daily_performance (plan section 9).
    const delivered = metrics.delivered ?? null;
    let ordersCompleted: number | null = null;
    if (delivered !== null) {
      if (Number.isInteger(delivered) && delivered >= 0) ordersCompleted = delivered;
      else
        bad(
          block.metricColumns.get('delivered') ?? 0,
          `Delivered ${delivered} is not a whole number of orders.`,
        );
    }
    const hours = metrics.working_hours ?? null;
    let workingMinutes: number | null = null;
    if (hours !== null) {
      // Working Hours is decimal hours (7.5 = 7 h 30 min); stored as whole minutes.
      if (hours >= 0 && hours <= 24) workingMinutes = Math.round(hours * 60);
      else
        bad(
          block.metricColumns.get('working_hours') ?? 0,
          `Working Hours ${hours} is not 0 to 24.`,
        );
    }
    const late = metrics.late_minutes ?? null;
    let lateMinutes: number | null = null;
    if (late !== null) {
      // Snoonu writes a negative "Late Log In By Min" when the person logged in before the
      // shift start (the saved copy has many). Early is not late: 0 late minutes. The raw
      // negative figure stays in `metrics.late_minutes`, so nothing is lost.
      lateMinutes = Math.max(0, Math.round(late));
    }
    return { hasFigures, day: { ordersCompleted, workingMinutes, lateMinutes, metrics } };
  });

  return { person: { row, identifier, fields, extra, days: [] }, figures, errors };
}

// ---------------------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------------------

export function parseDailyReport(grid: SheetGrid, context: ParseContext): ParseOutcome {
  const { mapping } = context;
  const read = readLayout(grid, mapping);
  if ('problems' in read) return { ok: false, problems: read.problems };
  const { layout } = read;
  const idField = layout.fieldColumns.get('public_id');
  // readLayout already reports a missing match key; this only narrows the type.
  if (idField === undefined) {
    return { ok: false, problems: [{ code: 'missing_field', message: 'No Public ID column.' }] };
  }
  const idColumn = idField.column;

  // 1. Which cycle the sheet shows: the one containing the day before it was read.
  const dataThrough = addDays(context.readOn, -1);
  const cycle = cycleContaining(dataThrough, context.cycleStartDay);
  const dates = layout.blocks.map((b) => blockDate(cycle, context.cycleStartDay, b.dayOfMonth));

  // 2. Every row with a Public ID is a person.
  const drafts: PersonDraft[] = [];
  for (let row = mapping.firstDataRow; row <= grid.rows.length; row += 1) {
    const idCell = cellAt(grid, row, idColumn);
    if (isNothing(idCell)) continue;
    drafts.push(readPerson(grid, layout, row, textOf(idCell)));
  }

  // 3. A Public ID on two rows: leave every such row out and report each one.
  const rowErrors: RowError[] = [];
  const count = new Map<string, number>();
  for (const d of drafts) count.set(d.person.identifier, (count.get(d.person.identifier) ?? 0) + 1);
  const kept: PersonDraft[] = [];
  for (const d of drafts) {
    if ((count.get(d.person.identifier) ?? 0) > 1) {
      rowErrors.push({
        row: d.person.row,
        code: 'duplicate_identifier',
        message: `Public ID ${d.person.identifier} is on more than one row; none of them is used.`,
        identifier: d.person.identifier,
        column: columnLetter(idColumn),
      });
      continue;
    }
    rowErrors.push(...d.errors);
    kept.push(d);
  }

  // 4. Status of each block from its date and whether anybody has figures in it.
  const blocks: DayBlockSummary[] = layout.blocks.map((block, i) => {
    const date = dates[i] ?? null;
    const peopleWithFigures = kept.filter((d) => d.figures[i]?.hasFigures === true).length;
    let status: DayBlockStatus;
    if (date === null) status = 'no_such_date';
    else if (date > context.readOn) status = 'future';
    else if (date === context.readOn) status = 'today';
    else status = peopleWithFigures > 0 ? 'filled' : 'empty';
    return {
      dayOfMonth: block.dayOfMonth,
      column: columnLetter(block.start),
      date,
      status,
      peopleWithFigures,
    };
  });

  // 5. Figures on a date that has not happened yet (or does not exist in this cycle) mean
  //    the sheet still shows the previous cycle: refuse rather than misdate them.
  const stale = blocks.filter(
    (b) => (b.status === 'future' || b.status === 'no_such_date') && b.peopleWithFigures > 0,
  );
  if (stale.length > 0) {
    return {
      ok: false,
      problems: stale.map((b) => ({
        code: 'cycle_mismatch' as const,
        message:
          `Day block ${b.dayOfMonth} has figures but stands for ` +
          (b.date === null
            ? 'a day this cycle does not have'
            : `${b.date}, after the read date ${context.readOn}`) +
          `; the sheet still shows cycle ending before ${cycle.start}.`,
        column: b.column,
      })),
    };
  }

  // 6. Attach the dated days: only filled blocks, and only the people with figures there.
  for (const d of kept) {
    blocks.forEach((b, i) => {
      const figures = d.figures[i];
      if (b.status !== 'filled' || b.date === null || figures?.hasFigures !== true) return;
      d.person.days.push({ date: b.date, ...figures.day });
    });
    d.person.days.sort((a, b) => a.date.localeCompare(b.date));
  }

  const people = kept.map((d) => d.person);
  return {
    ok: true,
    report: {
      cycle,
      dataThrough,
      blocks,
      filledDates: blocks
        .flatMap((b) => (b.status === 'filled' && b.date !== null ? [b.date] : []))
        .sort(),
      resetDetected: people.length > 0 && blocks.every((b) => b.peopleWithFigures === 0),
      people,
      rowErrors,
      unknownColumns: layout.unknownColumns,
    },
  };
}

/** Snoonu's Daily Report (adapter kind `sheet`). */
export const snoonuReportAdapter: ClientReportAdapter = {
  platformCode: 'snoonu',
  adapterKind: 'sheet',
  parse: parseDailyReport,
};
