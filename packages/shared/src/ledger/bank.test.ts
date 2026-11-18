/**
 * Bank statement parsing (row 2.17a): dates, amounts and whole-sheet normalisation.
 * All values are invented.
 */
import { describe, expect, it } from 'vitest';
import {
  bankStatementMappingSchema,
  ibanInputSchema,
  maskIban,
  normaliseStatement,
  parseStatementAmount,
  parseStatementDate,
} from './bank.js';

const amount = (text: string) => parseStatementAmount(text)?.toFixed(4) ?? null;

describe('parseStatementDate', () => {
  it('reads the three orders and ignores a time', () => {
    expect(parseStatementDate('2026-11-03', 'ymd')).toBe('2026-11-03');
    expect(parseStatementDate('2026/1/3 10:15', 'ymd')).toBe('2026-01-03');
    expect(parseStatementDate('03/11/2026', 'dmy')).toBe('2026-11-03');
    expect(parseStatementDate('11.03.2026', 'mdy')).toBe('2026-11-03');
  });
  it('refuses impossible and wrongly ordered dates', () => {
    expect(parseStatementDate('2026-02-30', 'ymd')).toBeNull();
    expect(parseStatementDate('31/04/2026', 'dmy')).toBeNull();
    expect(parseStatementDate('03/11/2026', 'ymd')).toBeNull();
    expect(parseStatementDate('', 'ymd')).toBeNull();
  });
});

describe('parseStatementAmount', () => {
  it('reads common bank layouts', () => {
    expect(amount('1234.50')).toBe('1234.5000');
    expect(amount('1,234.50')).toBe('1234.5000');
    expect(amount('1.234,50')).toBe('1234.5000');
    expect(amount('1 234,50')).toBe('1234.5000');
    expect(amount('1,234')).toBe('1234.0000');
    expect(amount('1.234.567')).toBe('1234567.0000');
    expect(amount('12,50')).toBe('12.5000');
    expect(amount('+7')).toBe('7.0000');
  });
  it('reads negatives in three styles', () => {
    expect(amount('-45.10')).toBe('-45.1000');
    expect(amount('(45.10)')).toBe('-45.1000');
    expect(amount('45.10-')).toBe('-45.1000');
  });
  it('refuses text, empty values and more than four decimals', () => {
    expect(amount('abc')).toBeNull();
    expect(amount('')).toBeNull();
    expect(amount('1.23456')).toBeNull();
    expect(amount('12,34,5')).toBeNull();
    expect(amount('1e5')).toBeNull();
  });
});

describe('normaliseStatement', () => {
  const sheet = {
    columns: ['Date', 'Debit', 'Credit', 'Ref', 'Text'],
    rows: [
      { Date: '01/11/2026', Debit: '', Credit: '1,000.00', Ref: 'R1', Text: 'Client payment' },
      { Date: '05/11/2026', Debit: '250.25', Credit: '', Ref: '', Text: 'Fuel' },
    ],
  };
  const mapping = bankStatementMappingSchema.parse({
    dateColumn: 'Date',
    dateFormat: 'dmy',
    debitColumn: 'Debit',
    creditColumn: 'Credit',
    referenceColumn: 'Ref',
    descriptionColumn: 'Text',
  });

  it('signs lines, totals them and finds the period', () => {
    const result = normaliseStatement(sheet, mapping);
    expect(result.errors).toEqual([]);
    expect(result.lines.map((l) => l.amount)).toEqual(['1000.0000', '-250.2500']);
    expect(result.lines[1]?.reference).toBeNull();
    expect([result.periodFrom, result.periodTo]).toEqual(['2026-11-01', '2026-11-05']);
    expect([result.totalIn, result.totalOut]).toEqual(['1000.0000', '250.2500']);
  });

  it('reports every bad row and stores no line for it', () => {
    const bad = {
      columns: sheet.columns,
      rows: [
        { Date: '32/11/2026', Debit: '', Credit: '5', Ref: '', Text: '' },
        { Date: '01/11/2026', Debit: '1', Credit: '1', Ref: '', Text: '' },
        { Date: '01/11/2026', Debit: '', Credit: '0', Ref: '', Text: '' },
        { Date: '01/11/2026', Debit: 'x', Credit: '', Ref: '', Text: '' },
      ],
    };
    const result = normaliseStatement(bad, mapping);
    expect(result.errors.map((e) => e.row)).toEqual([1, 2, 3, 4]);
    expect(result.lines).toEqual([]);
  });

  it('names a mapped column the file does not have', () => {
    const result = normaliseStatement({ columns: ['Date'], rows: [] }, mapping);
    expect(result.errors[0]?.field).toBe('mapping');
  });

  it('needs one amount column or a debit and credit pair', () => {
    expect(bankStatementMappingSchema.safeParse({ dateColumn: 'D' }).success).toBe(false);
    expect(
      bankStatementMappingSchema.safeParse({ dateColumn: 'D', amountColumn: 'A', debitColumn: 'X' })
        .success,
    ).toBe(false);
    expect(
      bankStatementMappingSchema.safeParse({ dateColumn: 'D', amountColumn: 'A' }).success,
    ).toBe(true);
  });
});

describe('IBAN input', () => {
  it('normalises spaces and case and masks all but four characters', () => {
    const iban = ibanInputSchema.parse('qa58 dohb 0000 1234 5678 90ab cdef g');
    expect(iban).toBe('QA58DOHB00001234567890ABCDEFG');
    expect(maskIban(iban)).toBe('*************************DEFG');
    expect(ibanInputSchema.safeParse('12345').success).toBe(false);
  });
});
