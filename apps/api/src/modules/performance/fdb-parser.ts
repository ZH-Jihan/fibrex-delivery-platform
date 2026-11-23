/**
 * Snoonu "FDB Report" tab parser (phase 4 row 4.9; plan section 2).
 *
 * Purpose: the FDB tab lists every agent Snoonu holds for the company: Falcon ID, name, type
 * (Driver or Rider), account status, employment status, documents status, sponsorship, a
 * secondment column and the expiry dates of QID, passport, Istimara, driving licence,
 * insurance, food handling (FHC) and health card. This file turns that grid into plain rows;
 * ./fdb-compare.ts compares the rows with our records. It reads nothing from the database and
 * never writes to the sheet.
 *
 * Layout facts checked against the real saved copy (2026-11): row 1 holds totals ("Active
 * Fleet: 43 ..."), row 2 is the header row, data starts on row 3, one row per person. Snoonu's
 * header cells are text formulas in cells formatted as dates, and Excel readers then return
 * the header as an invalid date (blank to us). So a header is found by its text when it can be
 * read, and otherwise by its fixed position counted from the Falcon ID column (secondment +7,
 * QID +8, passport +9, Istimara +10, driving licence +11, insurance +12, FHC +13, health card
 * +14). A column whose header is readable is never taken from its position.
 *
 * Dates: a date cell, an Excel serial number, or text (2026-12-31, 31-Dec-2026, 31/12/2026).
 * Anything else ("NA", "Pending") is kept as text and counts as "no date".
 *
 * Depends on: ./report-adapter.ts (grid types). Used by: ./fdb-compare.ts, ./fdb-service.ts.
 */
import type { SheetCell, SheetGrid } from './report-adapter.js';

/** The tab the check reads. */
export const FDB_TAB = 'FDB Report';

/** Document type codes of the FDB date columns (the same codes as our `people.document_type`). */
export const FDB_DOC_KEYS = [
  'qid',
  'passport',
  'istimara',
  'driving_licence',
  'insurance',
  'food_handling',
  'health_card',
] as const;
export type FdbDocKey = (typeof FDB_DOC_KEYS)[number];

export interface FdbRow {
  /** Sheet row number (1-based). */
  row: number;
  /** The Falcon ID as text. */
  identifier: string;
  name: string | null;
  type: string | null;
  accountStatus: string | null;
  employmentStatus: string | null;
  documentsStatus: string | null;
  sponsorship: string | null;
  secondment: string | null;
  /** Expiry date by document, "YYYY-MM-DD", or null when the cell has no date. */
  dates: Record<FdbDocKey, string | null>;
  /** The text of a date cell that holds text instead of a date ("NA"), by document. */
  notes: Partial<Record<FdbDocKey, string>>;
}

export interface FdbRowError {
  row: number;
  code: 'duplicate_identifier';
  message: string;
  identifier: string;
}

export interface FdbReport {
  headerRow: number;
  rows: FdbRow[];
  rowErrors: FdbRowError[];
  /** Fields whose column was found by position because its header could not be read. */
  positional: string[];
}

export type FdbParseOutcome = { ok: true; report: FdbReport } | { ok: false; message: string };

/** Header text without case, spaces and punctuation: "Driving License" -> "drivinglicense". */
function norm(cell: SheetCell | undefined): string {
  if (typeof cell !== 'string') return '';
  return cell.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const HEAD_ALIASES: Record<string, readonly string[]> = {
  identifier: ['falconid', 'publicid'],
  name: ['agentname', 'name'],
  type: ['type'],
  accountStatus: ['accountstatus'],
  employmentStatus: ['employmentstatus'],
  documentsStatus: ['documentsstatus', 'documentstatus'],
  sponsorship: ['sponsorship'],
};

const DOC_ALIASES: Record<FdbDocKey, readonly string[]> = {
  qid: ['qid', 'qatarid'],
  passport: ['passport'],
  istimara: ['istimara', 'istimarah', 'vehicleregistration'],
  driving_licence: ['drivinglicense', 'drivinglicence', 'license', 'licence'],
  insurance: ['insurance'],
  food_handling: ['fhc', 'foodhandling', 'foodhandlingcard', 'foodhandlercertificate'],
  health_card: ['healthcard'],
};

/** Offsets from the Falcon ID column, used only for a column whose header cannot be read. */
const POSITION: Record<'secondment' | FdbDocKey, number> = {
  secondment: 7,
  qid: 8,
  passport: 9,
  istimara: 10,
  driving_licence: 11,
  insurance: 12,
  food_handling: 13,
  health_card: 14,
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function iso(year: number, month: number, day: number): string | null {
  if (year < 1990 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1) return null;
  return d.toISOString().slice(0, 10);
}

/** A cell as a calendar date ("YYYY-MM-DD"), or null when it holds none. */
export function fdbDate(cell: SheetCell | undefined): string | null {
  if (cell === null || cell === undefined) return null;
  if (cell instanceof Date) {
    return Number.isNaN(cell.getTime()) ? null : cell.toISOString().slice(0, 10);
  }
  if (typeof cell === 'number') {
    // An Excel serial day number (1900 system): 25569 is 1970-01-01.
    if (cell < 20000 || cell > 80000) return null;
    return new Date(Math.round((cell - 25569) * 86_400_000)).toISOString().slice(0, 10);
  }
  if (typeof cell !== 'string') return null;
  const text = cell.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (m !== null) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[-/ ]([A-Za-z]{3})[A-Za-z]*[-/ ,]+(\d{4})$/.exec(text);
  if (m !== null) {
    const month = MONTHS.indexOf((m[2] ?? '').toLowerCase()) + 1;
    return month === 0 ? null : iso(Number(m[3]), month, Number(m[1]));
  }
  // Day first, as the sheet is kept in Qatar.
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  if (m !== null) return iso(Number(m[3]), Number(m[2]), Number(m[1]));
  return null;
}

function text(cell: SheetCell | undefined): string | null {
  if (cell === null || cell === undefined) return null;
  if (cell instanceof Date) return null;
  const t = String(cell).trim();
  return t === '' ? null : t;
}

function identifierText(cell: SheetCell | undefined): string {
  if (typeof cell === 'number') return Number.isInteger(cell) ? String(cell) : String(cell).trim();
  return typeof cell === 'string' ? cell.trim() : '';
}

/** Reads the FDB tab into rows. */
export function parseFdbReport(grid: SheetGrid): FdbParseOutcome {
  // Find the header row among the first rows: the one with a "Falcon ID" (or "Public ID") cell.
  let headerRow = -1;
  let idColumn = -1;
  for (let r = 0; r < Math.min(grid.rows.length, 10); r += 1) {
    const cells = grid.rows[r] ?? [];
    const c = cells.findIndex((cell) => HEAD_ALIASES.identifier?.includes(norm(cell)) === true);
    if (c >= 0) {
      headerRow = r;
      idColumn = c;
      break;
    }
  }
  if (headerRow < 0) {
    return {
      ok: false,
      message: `The "${grid.tab}" tab has no "Falcon ID" header in its first rows, so it cannot be read.`,
    };
  }

  const header = grid.rows[headerRow] ?? [];
  const claimed = new Set<number>([idColumn]);
  const columnOf = new Map<string, number>();
  const find = (key: string, aliases: readonly string[], prefix = false): void => {
    const c = header.findIndex(
      (cell, i) =>
        !claimed.has(i) &&
        (prefix ? norm(cell).startsWith(aliases[0] ?? '#') : aliases.includes(norm(cell))),
    );
    if (c >= 0) {
      columnOf.set(key, c);
      claimed.add(c);
    }
  };
  for (const [key, aliases] of Object.entries(HEAD_ALIASES)) {
    if (key !== 'identifier') find(key, aliases);
  }
  find('secondment', ['secondment'], true);
  for (const key of FDB_DOC_KEYS) find(key, DOC_ALIASES[key]);

  // Fall back to the fixed position for the date columns whose header could not be read.
  const positional: string[] = [];
  for (const [key, offset] of Object.entries(POSITION)) {
    if (columnOf.has(key)) continue;
    const c = idColumn + offset;
    if (claimed.has(c)) continue;
    if (norm(header[c]) !== '') continue; // a readable header that is something else
    columnOf.set(key, c);
    claimed.add(c);
    positional.push(key);
  }

  const cellOf = (cells: SheetCell[], key: string): SheetCell | undefined => {
    const c = columnOf.get(key);
    return c === undefined ? undefined : cells[c];
  };

  const rows: FdbRow[] = [];
  const rowErrors: FdbRowError[] = [];
  const seen = new Set<string>();
  for (let r = headerRow + 1; r < grid.rows.length; r += 1) {
    const cells = grid.rows[r] ?? [];
    const identifier = identifierText(cells[idColumn]);
    if (identifier === '') continue;
    if (seen.has(identifier)) {
      rowErrors.push({
        row: r + 1,
        code: 'duplicate_identifier',
        identifier,
        message: `Falcon ID ${identifier} is listed twice; the first row is used.`,
      });
      continue;
    }
    seen.add(identifier);
    const dates = {} as Record<FdbDocKey, string | null>;
    const notes: Partial<Record<FdbDocKey, string>> = {};
    for (const key of FDB_DOC_KEYS) {
      const cell = cellOf(cells, key);
      const date = fdbDate(cell);
      dates[key] = date;
      const note = date === null ? text(cell) : null;
      if (note !== null) notes[key] = note;
    }
    rows.push({
      row: r + 1,
      identifier,
      name: text(cellOf(cells, 'name')),
      type: text(cellOf(cells, 'type')),
      accountStatus: text(cellOf(cells, 'accountStatus')),
      employmentStatus: text(cellOf(cells, 'employmentStatus')),
      documentsStatus: text(cellOf(cells, 'documentsStatus')),
      sponsorship: text(cellOf(cells, 'sponsorship')),
      secondment: text(cellOf(cells, 'secondment')) ?? fdbDate(cellOf(cells, 'secondment')),
      dates,
      notes,
    });
  }
  return { ok: true, report: { headerRow: headerRow + 1, rows, rowErrors, positional } };
}
