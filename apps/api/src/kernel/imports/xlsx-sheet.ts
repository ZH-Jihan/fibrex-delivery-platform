/**
 * Excel (.xlsx) reading and writing for imports and exports (row 2.8b).
 *
 * Purpose: `readXlsx` turns the first worksheet of an Excel file into the same `ParsedSheet`
 * the CSV reader makes (header row, then one object of text per row), so the preview and
 * commit steps do not care which kind of file was uploaded. `buildXlsx` writes an export.
 *
 * Why every cell becomes text: the mapping clean-ups (number, date, boolean) work on text, as
 * they do for CSV. Dates become ISO `YYYY-MM-DD` (use the `YMD` date clean-up); numbers are
 * written without thousands separators; a formula cell gives its last calculated result, never
 * the formula, and a formula is never run. Only the first sheet is read.
 *
 * Depends on: exceljs, @fibrex/shared. Used by: ./import-service, ./export-service.
 */
import { sheetFromRecords, SheetError, type ParsedSheet } from '@fibrex/shared';
import ExcelJS from 'exceljs';

/** One cell value as text; objects (rich text, links, formulas, errors) are unwrapped. */
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) {
    // A date with no time of day is written as a plain date, otherwise as date and time (UTC).
    const iso = value.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
  }
  if ('richText' in value) return value.richText.map((part) => part.text).join('');
  if ('formula' in value || 'sharedFormula' in value) {
    return cellText(value.result ?? null);
  }
  if ('text' in value) return cellText(value.text);
  return '';
}

/** Reads the first worksheet of an .xlsx file. Throws `SheetError` when it cannot be used. */
export async function readXlsx(bytes: Buffer): Promise<ParsedSheet> {
  const workbook = new ExcelJS.Workbook();
  try {
    // exceljs's types name the older Buffer type; the bytes are the same.
    await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch {
    throw new SheetError('unreadable_file', 'This is not a readable Excel (.xlsx) file.');
  }
  const sheet = workbook.worksheets[0];
  if (sheet === undefined) throw new SheetError('empty', 'The workbook has no sheet.');

  const width = sheet.columnCount;
  const records: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    for (let column = 1; column <= width; column += 1) {
      cells.push(cellText(row.getCell(column).value));
    }
    // A row with nothing in it is not a row (same rule as a blank CSV line).
    if (cells.some((cell) => cell.trim() !== '')) records.push(cells);
  });
  return sheetFromRecords(records);
}

/** Writes one sheet called `name` with a bold header row; returns the file's bytes. */
export async function buildXlsx(
  name: string,
  columns: string[],
  rows: Record<string, string | number | boolean | null | undefined>[],
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  // Sheet names may not contain : \ / ? * [ ] and are at most 31 characters.
  const sheet = workbook.addWorksheet(name.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31) || 'Export');
  sheet.addRow(columns).font = { bold: true };
  for (const row of rows) {
    // Text is stored as a string cell (never a formula), so nothing in it can run in Excel.
    sheet.addRow(columns.map((column) => row[column] ?? null));
  }
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  columns.forEach((column, index) => {
    sheet.getColumn(index + 1).width = Math.min(Math.max(column.length + 4, 12), 50);
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
