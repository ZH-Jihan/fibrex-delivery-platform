/**
 * Client report adapters and sources (phase 4 row 4.2; SPEC 3.1, SPEC 2.11).
 *
 * Purpose: every client platform (Snoonu now; Keeta and Talabat later) sends its daily
 * figures in its own layout. The sync engine (row 4.3) works only with two small interfaces:
 *
 *   - `ReportSource` reads one tab of the platform's report as a plain grid of cell values.
 *     Implementations: an uploaded Excel file (`excelFileSource`), an in-memory grid for
 *     tests (`memorySource`), and the read-only Google Sheets reader (row 4.4). A source
 *     never writes anything back (plan section 9: never write to the sheet).
 *   - `ClientReportAdapter` turns that grid into dated per-person figures for one platform
 *     layout. Snoonu's wide Daily Report is `./snoonu-parser.ts`.
 *
 * Why a grid of raw values: the parser must see numbers as numbers and times as times
 * (Break start is a time cell), and must tell a blank cell from a 0, so nothing here
 * converts cells to text. A formula cell gives its last calculated result and is never run.
 *
 * Depends on: exceljs, @fibrex/shared (mapping types). Used by: ./snoonu-parser.ts, the sync
 * engine (row 4.3), the Google Sheets reader (row 4.4).
 */
import type { SheetColumnMapping } from '@fibrex/shared';
import ExcelJS from 'exceljs';

/** One cell as read: a blank cell is null. Spreadsheet errors (#N/A ...) arrive as text. */
export type SheetCell = string | number | boolean | Date | null;

/** One tab, row by row; `rows[0]` is sheet row 1 and `rows[r][0]` is column A. */
export interface SheetGrid {
  tab: string;
  rows: SheetCell[][];
}

export type ReportSourceErrorCode =
  | 'unreadable_file'
  | 'missing_tab'
  /** Row 4.4: no Google account is connected, or the source has no spreadsheet id. */
  | 'not_connected'
  /** The Google grant was revoked or expired (invalid_grant); an admin must reconnect. */
  | 'access_revoked'
  /** The spreadsheet is not shared with the connected account, or does not exist. */
  | 'not_shared'
  /** The Google Sheets API is not enabled in the Cloud project. */
  | 'api_disabled'
  /** Google kept refusing for quota or rate limits after the back-off. */
  | 'quota_exceeded'
  /** The sheet shows an error or "Loading..." instead of data (IMPORTRANGE not ready). */
  | 'sheet_unreadable';

/** A source could not give a grid at all (the sync run records it and alerts admins). */
export class ReportSourceError extends Error {
  readonly code: ReportSourceErrorCode;
  /**
   * Whether trying again later can help (the queue retries; admins hear on the last try).
   * Undefined: the sync engine decides from the code.
   */
  readonly retryable: boolean | undefined;

  constructor(code: ReportSourceErrorCode, message: string, retryable?: boolean) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.name = 'ReportSourceError';
  }
}

export interface ReportSource {
  /** Reads the named tab. Throws `ReportSourceError` when the tab cannot be read. */
  read(tab: string): Promise<SheetGrid>;
}

// ---------------------------------------------------------------------------------------
// What an adapter returns
// ---------------------------------------------------------------------------------------

export interface ParseContext {
  mapping: SheetColumnMapping;
  /** The platform's `cycle_start_day` (Snoonu: 26). */
  cycleStartDay: number;
  /**
   * The business date the sheet was read or downloaded on (Asia/Qatar). The sheet runs one
   * day behind, so its newest complete figures are for the day before.
   */
  readOn: string;
}

export type LayoutProblemCode =
  | 'missing_field'
  | 'no_day_blocks'
  | 'duplicate_day_block'
  | 'uneven_day_blocks'
  | 'missing_metric'
  | 'duplicate_metric'
  | 'cycle_mismatch';

/** Why a sheet could not be read as the expected layout (sync run `layout_changed`). */
export interface LayoutProblem {
  code: LayoutProblemCode;
  message: string;
  /** Column letter the problem was found at, when there is one. */
  column?: string;
}

export type RowErrorCode = 'duplicate_identifier' | 'bad_value';

/** A problem with one row; the rest of the sheet is still used (`sync_run_error`). */
export interface RowError {
  row: number;
  code: RowErrorCode;
  message: string;
  identifier?: string;
  column?: string;
}

/**
 * One person's figures for one date. Only days with at least one non-zero figure are
 * listed: a blank or all-zero block means "no figures", never "worked and did nothing".
 */
export interface ParsedDay {
  date: string;
  /** Delivered (orders), whole number. */
  ordersCompleted: number | null;
  /** Working Hours x 60, rounded to whole minutes. */
  workingMinutes: number | null;
  /** Late Log In By Min, rounded to whole minutes. */
  lateMinutes: number | null;
  /** Every figure of the block by metric key, unknown block columns included. */
  metrics: Record<string, number | null>;
}

export interface ParsedPerson {
  /** Sheet row number (1-based), for error messages. */
  row: number;
  /** The platform's id for the person (Snoonu Public ID = Falcon ID), as text. */
  identifier: string;
  /** Mapped fixed columns by field key; a time is `HH:MM`. */
  fields: Record<string, string | number | null>;
  /** Columns no mapping claims, by their header text (kept, never dropped). */
  extra: Record<string, string | number | null>;
  days: ParsedDay[];
}

export type DayBlockStatus =
  /** Figures present and the date is complete (on or before the day before `readOn`). */
  | 'filled'
  /** Blank or all zeros. */
  | 'empty'
  /** The block's date is `readOn` itself: figures, if any, are partial and not used. */
  | 'today'
  /** The block's date is after `readOn` (no figures can exist yet). */
  | 'future'
  /** The cycle has no such day (the 31st in a 30-day month). */
  | 'no_such_date';

export interface DayBlockSummary {
  dayOfMonth: number;
  /** First column of the block, as a letter. */
  column: string;
  date: string | null;
  status: DayBlockStatus;
  /** People with at least one non-zero figure in this block. */
  peopleWithFigures: number;
}

export interface ParsedReport {
  cycle: { start: string; end: string };
  /** The newest date the sheet can hold complete figures for (`readOn` minus one day). */
  dataThrough: string;
  blocks: DayBlockSummary[];
  /** Dates (ascending) of blocks with status `filled`. */
  filledDates: string[];
  /**
   * True when people are listed but every day block is blank or zero: the sheet has been
   * reset for a new cycle. The sync engine must not replace stored figures with this.
   */
  resetDetected: boolean;
  people: ParsedPerson[];
  rowErrors: RowError[];
  /** Header texts of columns kept in `extra` and of unknown block columns. */
  unknownColumns: string[];
}

export type ParseOutcome =
  { ok: true; report: ParsedReport } | { ok: false; problems: LayoutProblem[] };

/** Turns one platform's report grid into dated figures. */
export interface ClientReportAdapter {
  /** `client_platform.code` this adapter serves. */
  readonly platformCode: string;
  /** `client_platform.adapter_kind`. */
  readonly adapterKind: 'sheet';
  parse(grid: SheetGrid, context: ParseContext): ParseOutcome;
}

// ---------------------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------------------

/** A grid held in memory (tests, and a re-parse of a stored raw snapshot). */
export function memorySource(grids: readonly SheetGrid[]): ReportSource {
  return {
    read(tab) {
      const grid = grids.find((g) => g.tab === tab);
      if (grid === undefined) {
        return Promise.reject(
          new ReportSourceError('missing_tab', `The report has no tab called "${tab}".`),
        );
      }
      return Promise.resolve(grid);
    },
  };
}

/** One exceljs cell value as a raw `SheetCell` (formula -> its cached result). */
function excelCell(value: ExcelJS.CellValue | undefined): SheetCell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  // A date cell Excel cannot turn into a date is blank, not an error.
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if ('formula' in value || 'sharedFormula' in value) {
    return excelCell(value.result);
  }
  if ('richText' in value) return value.richText.map((part) => part.text).join('');
  if ('error' in value) return value.error;
  if ('text' in value) return excelCell(value.text);
  return null;
}

/** An uploaded .xlsx file, such as a downloaded copy of the platform's sheet. */
export function excelFileSource(bytes: Buffer): ReportSource {
  let loaded: Promise<ExcelJS.Workbook> | undefined;
  const load = async (): Promise<ExcelJS.Workbook> => {
    const workbook = new ExcelJS.Workbook();
    try {
      // exceljs's types name the older Buffer type; the bytes are the same.
      await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    } catch {
      throw new ReportSourceError('unreadable_file', 'This is not a readable Excel (.xlsx) file.');
    }
    return workbook;
  };
  return {
    async read(tab) {
      loaded ??= load();
      const workbook = await loaded;
      const sheet = workbook.getWorksheet(tab);
      if (sheet === undefined) {
        throw new ReportSourceError('missing_tab', `The workbook has no tab called "${tab}".`);
      }
      const width = sheet.columnCount;
      const rows: SheetCell[][] = [];
      sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
        const cells: SheetCell[] = [];
        for (let column = 1; column <= width; column += 1) {
          cells.push(excelCell(row.getCell(column).value));
        }
        rows[rowNumber - 1] = cells;
      });
      // Rows exceljs skipped entirely are blank rows.
      for (let i = 0; i < rows.length; i += 1) rows[i] ??= [];
      return { tab, rows };
    },
  };
}
