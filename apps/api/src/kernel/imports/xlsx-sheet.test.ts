import { buildCsv, parseCsv, SheetError } from '@fibrex/shared';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { buildXlsx, readXlsx } from './xlsx-sheet.js';

/** An .xlsx made with exceljs from rows of mixed cell types, as Excel would store them. */
async function workbookBytes(rows: ExcelJS.CellValue[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Data');
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe('readXlsx', () => {
  it('reads the header and rows, turning numbers, dates, booleans and formulas into text', async () => {
    const bytes = await workbookBytes([
      ['Code', 'Amount', 'Joined', 'Active', 'Total'],
      ['AA', 1250.5, new Date(Date.UTC(2026, 10, 3)), true, { formula: 'B2*2', result: 2501 }],
      [null, null, null, null, null],
      ['BB', 7, new Date(Date.UTC(2026, 0, 31, 8, 30)), false, { richText: [{ text: 'ok' }] }],
    ]);
    const sheet = await readXlsx(bytes);
    expect(sheet.columns).toEqual(['Code', 'Amount', 'Joined', 'Active', 'Total']);
    // The empty row is skipped, like a blank CSV line.
    expect(sheet.rows).toEqual([
      { Code: 'AA', Amount: '1250.5', Joined: '2026-11-03', Active: 'true', Total: '2501' },
      {
        Code: 'BB',
        Amount: '7',
        Joined: '2026-01-31T08:30:00.000Z',
        Active: 'false',
        Total: 'ok',
      },
    ]);
  });

  it('refuses a file that is not a workbook, a repeated header and a workbook with no rows', async () => {
    await expect(readXlsx(Buffer.from('not a zip'))).rejects.toMatchObject({
      code: 'unreadable_file',
    });
    await expect(
      readXlsx(
        await workbookBytes([
          ['a', 'a'],
          ['1', '2'],
        ]),
      ),
    ).rejects.toThrow(/appears twice/);
    await expect(readXlsx(await workbookBytes([]))).rejects.toBeInstanceOf(SheetError);
  });
});

describe('buildXlsx and buildCsv', () => {
  const columns = ['Code', 'Name', 'Qty'];
  const rows = [
    { Code: 'AA', Name: 'North, "main"', Qty: 3 },
    { Code: 'BB', Name: '=HYPERLINK("http://x")', Qty: null },
  ];

  it('round-trips an export through the reader', async () => {
    const sheet = await readXlsx(await buildXlsx('Branch', columns, rows));
    expect(sheet.columns).toEqual(columns);
    expect(sheet.rows[0]).toEqual({ Code: 'AA', Name: 'North, "main"', Qty: '3' });
    expect(sheet.rows[1]?.Qty).toBe('');
  });

  it('writes CSV that parses back, and stops a formula from running in a spreadsheet', () => {
    const csv = buildCsv(columns, rows);
    expect(csv.startsWith('﻿')).toBe(true);
    const sheet = parseCsv(csv);
    expect(sheet.rows[0]).toEqual({ Code: 'AA', Name: 'North, "main"', Qty: '3' });
    expect(sheet.rows[1]?.Name).toBe(`'=HYPERLINK("http://x")`);
  });
});
