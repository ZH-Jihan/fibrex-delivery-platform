/**
 * Import helpers shared by the API (preview and commit) and the web wizard (row 2.8b).
 *
 * Purpose: reading a CSV sheet and turning one sheet row into the values of a record, using
 * a mapping the business can save (which column feeds which field, and which small clean-ups
 * to apply). The mapping is data (SPEC 2.6): adding a column or a clean-up never needs code.
 *
 * Pure functions only: no database, no clock, no I/O, so API and browser behave the same.
 * Depends on: zod. Used by: apps/api (kernel/imports), apps/web.
 */
import { z } from 'zod';

/** Largest sheet accepted in one import, so a preview stays quick and a commit stays one transaction. */
export const MAX_IMPORT_ROWS = 20_000;

export interface ParsedSheet {
  /** Header names in file order (trimmed, never empty, never repeated). */
  columns: string[];
  /** One object per non-blank data row, keyed by header name. Values are raw text. */
  rows: Record<string, string>[];
}

export class SheetError extends Error {
  readonly code:
    'empty' | 'duplicate_column' | 'too_many_rows' | 'unterminated_quote' | 'unreadable_file';

  constructor(code: SheetError['code'], message: string) {
    super(message);
    this.name = 'SheetError';
    this.code = code;
  }
}

/** Picks the delimiter that appears most often in the header line (comma, semicolon or tab). */
function detectDelimiter(text: string): string {
  const newline = text.search(/\r|\n/);
  const header = newline === -1 ? text : text.slice(0, newline);
  let best = ',';
  let bestCount = 0;
  for (const candidate of [',', ';', '\t']) {
    const count = header.split(candidate).length - 1;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Reads CSV text (RFC 4180: quoted fields, doubled quotes, line breaks inside quotes; also
 * accepts a UTF-8 byte-order mark and CRLF). The first non-blank line is the header.
 */
export function parseCsv(input: string): ParsedSheet {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delimiter = detectDelimiter(text);

  // Step 1: split into records of fields with a small state machine. A regular expression
  // cannot do this reliably because a quoted field may itself contain the delimiter or a
  // line break.
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let fieldStarted = false;
  const endField = () => {
    record.push(field);
    field = '';
    fieldStarted = false;
  };
  const endRecord = () => {
    endField();
    // A line with nothing in it is not a row.
    if (record.length > 1 || (record[0] ?? '').trim() !== '') records.push(record);
    record = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (quoted) {
      if (ch === '"') {
        if (text.charAt(i + 1) === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && !fieldStarted) {
      quoted = true;
      fieldStarted = true;
    } else if (ch === delimiter) {
      endField();
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text.charAt(i + 1) === '\n') i += 1;
      endRecord();
    } else {
      field += ch;
      fieldStarted = true;
    }
  }
  if (quoted) {
    throw new SheetError('unterminated_quote', 'A quoted value is never closed.');
  }
  if (fieldStarted || field !== '' || record.length > 0) endRecord();
  return sheetFromRecords(records);
}

/**
 * Turns records of text cells (first record = header) into a sheet. Shared by the CSV reader
 * and the Excel reader (API), so both apply the same header and row-limit rules.
 */
export function sheetFromRecords(input: string[][]): ParsedSheet {
  const records = [...input];
  // Step 2: the header.
  const header = records.shift();
  if (header === undefined) throw new SheetError('empty', 'The file has no header row.');
  const columns = header.map((name) => name.trim());
  const seen = new Set<string>();
  for (const name of columns) {
    if (name === '') continue;
    if (seen.has(name)) {
      throw new SheetError('duplicate_column', `The column "${name}" appears twice.`);
    }
    seen.add(name);
  }
  if (seen.size === 0) throw new SheetError('empty', 'The file has no header row.');
  if (records.length > MAX_IMPORT_ROWS) {
    throw new SheetError(
      'too_many_rows',
      `A file may have at most ${String(MAX_IMPORT_ROWS)} rows; split it into parts.`,
    );
  }

  // Step 3: rows keyed by header. A short row gets empty values; unnamed columns are dropped.
  const rows = records.map((values) => {
    const row: Record<string, string> = {};
    columns.forEach((name, index) => {
      if (name !== '') row[name] = values[index] ?? '';
    });
    return row;
  });
  return { columns: columns.filter((name) => name !== ''), rows };
}

/** Most rows one export holds; larger sets must be filtered (the file is built in memory). */
export const MAX_EXPORT_ROWS = 20_000;

/**
 * Cells that a spreadsheet program would run as a formula (CSV/formula injection): a text
 * starting with = + - @ tab or CR gets a leading apostrophe so it opens as plain text.
 * Numbers are never touched, so a negative amount stays a number.
 */
export function neutraliseFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** Writes a sheet as CSV (RFC 4180, CRLF, UTF-8 BOM so Excel opens non-English text correctly). */
export function buildCsv(
  columns: string[],
  rows: Record<string, string | number | boolean | null | undefined>[],
): string {
  const cell = (value: string | number | boolean | null | undefined): string => {
    const text =
      value === null || value === undefined
        ? ''
        : typeof value === 'string'
          ? neutraliseFormula(value)
          : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [columns.map((name) => cell(name)).join(',')];
  for (const row of rows) lines.push(columns.map((name) => cell(row[name])).join(','));
  return `${String.fromCharCode(0xfeff)}${lines.join('\r\n')}\r\n`;
}

// ---- Mapping --------------------------------------------------------------------------

const transformSchema = z.union([
  z.enum(['trim', 'upper', 'lower', 'number', 'boolean']),
  z.strictObject({ op: z.literal('default'), value: z.string().max(500) }),
  z.strictObject({ op: z.literal('date'), format: z.enum(['DMY', 'MDY', 'YMD']) }),
  z.strictObject({
    op: z.literal('map'),
    values: z.record(z.string().max(200), z.string().max(500)),
  }),
]);
export type ImportTransform = z.infer<typeof transformSchema>;

const fieldKey = z.string().regex(/^[a-z][a-z0-9_]{0,59}$/, 'lower-case letters, digits and _');

/** Which sheet column feeds which field, and the clean-ups applied to the text on the way. */
export const importMappingSchema = z.strictObject({
  /** `field key -> sheet column name`. */
  columnMap: z.record(fieldKey, z.string().min(1).max(200)),
  /** `field key -> clean-ups, applied in order`. */
  transforms: z.record(fieldKey, z.array(transformSchema).max(10)).default({}),
});
export type ImportMapping = z.infer<typeof importMappingSchema>;

export type ImportValue = string | number | boolean;

export interface RowIssue {
  path: string;
  code: string;
  message: string;
}

const TRUE_WORDS = new Set(['true', 'yes', 'y', '1']);
const FALSE_WORDS = new Set(['false', 'no', 'n', '0']);

/** Day, month and year parts to an ISO date; undefined when it is not a real calendar day. */
function isoDate(year: number, month: number, day: number): string | undefined {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return date.toISOString().slice(0, 10);
}

function applyTransform(value: string, transform: ImportTransform): ImportValue | RowIssue {
  const fail = (code: string, message: string): RowIssue => ({ path: '', code, message });
  if (transform === 'trim') return value.trim();
  if (transform === 'upper') return value.toUpperCase();
  if (transform === 'lower') return value.toLowerCase();
  if (transform === 'number') {
    // Thousands separators are removed; the decimal point stays a point.
    const cleaned = value.replace(/[,\s]/g, '');
    if (cleaned === '') return '';
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : fail('not_a_number', `"${value}" is not a number.`);
  }
  if (transform === 'boolean') {
    const word = value.trim().toLowerCase();
    if (word === '') return '';
    if (TRUE_WORDS.has(word)) return true;
    if (FALSE_WORDS.has(word)) return false;
    return fail('not_a_boolean', `"${value}" is not yes or no.`);
  }
  if (transform.op === 'default') return value.trim() === '' ? transform.value : value;
  if (transform.op === 'map') return transform.values[value.trim()] ?? value;
  // op === 'date'
  const text = value.trim();
  if (text === '') return '';
  const parts = /^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})$/.exec(text);
  const a = Number(parts?.[1]);
  const b = Number(parts?.[2]);
  const c = Number(parts?.[3]);
  const result =
    parts === null
      ? undefined
      : transform.format === 'YMD'
        ? isoDate(a, b, c)
        : transform.format === 'DMY'
          ? isoDate(c, b, a)
          : isoDate(c, a, b);
  return result ?? fail('not_a_date', `"${value}" is not a date written as ${transform.format}.`);
}

/**
 * Turns one sheet row into field values. A field whose cell is empty after the clean-ups is
 * left out (absent), not set to an empty string, so optional fields stay optional. Problems
 * are returned as issues, not thrown: the preview lists them per row.
 */
export function normaliseRow(
  raw: Record<string, string>,
  mapping: ImportMapping,
): { values: Record<string, ImportValue>; issues: RowIssue[] } {
  const values: Record<string, ImportValue> = {};
  const issues: RowIssue[] = [];
  for (const [field, column] of Object.entries(mapping.columnMap)) {
    let current: ImportValue = raw[column] ?? '';
    let failed = false;
    for (const transform of mapping.transforms[field] ?? []) {
      // Transforms work on text; a value an earlier step made a number is written back out.
      const result = applyTransform(String(current), transform);
      if (typeof result === 'object') {
        issues.push({ ...result, path: field });
        failed = true;
        break;
      }
      current = result;
    }
    if (failed) continue;
    if (typeof current === 'string') {
      const text = current.trim();
      if (text !== '') values[field] = text;
    } else {
      values[field] = current;
    }
  }
  return { values, issues };
}
