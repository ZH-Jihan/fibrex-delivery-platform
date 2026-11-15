import { describe, expect, it } from 'vitest';
import { normaliseRow, parseCsv, SheetError, type ImportMapping } from './index.js';

describe('parseCsv', () => {
  it('reads quoted values, doubled quotes, line breaks in quotes, BOM and CRLF', () => {
    const text = '﻿name,note\r\n"Asha, K","said ""hi"""\r\nBen,"two\nlines"\r\n';
    const sheet = parseCsv(text);
    expect(sheet.columns).toEqual(['name', 'note']);
    expect(sheet.rows).toEqual([
      { name: 'Asha, K', note: 'said "hi"' },
      { name: 'Ben', note: 'two\nlines' },
    ]);
  });

  it('detects semicolons, skips blank lines, pads short rows', () => {
    const sheet = parseCsv('a;b;c\n1;2\n\n3;4;5');
    expect(sheet.rows).toEqual([
      { a: '1', b: '2', c: '' },
      { a: '3', b: '4', c: '5' },
    ]);
  });

  it('refuses an empty file, a repeated header and an unclosed quote', () => {
    expect(() => parseCsv('')).toThrow(SheetError);
    expect(() => parseCsv('a,a\n1,2')).toThrow(/appears twice/);
    expect(() => parseCsv('a,b\n"1,2')).toThrow(/never closed/);
  });
});

describe('normaliseRow', () => {
  const mapping: ImportMapping = {
    columnMap: { name: 'Name', age: 'Age', joined: 'Joined', active: 'Active', city: 'City' },
    transforms: {
      name: ['trim', 'upper'],
      age: ['number'],
      joined: [{ op: 'date', format: 'DMY' }],
      active: ['boolean'],
      city: [
        { op: 'map', values: { Doha: 'DOH' } },
        { op: 'default', value: 'UNK' },
      ],
    },
  };

  it('applies the clean-ups in order and leaves empty cells out', () => {
    const { values, issues } = normaliseRow(
      { Name: '  asha ', Age: '1,250', Joined: '05/03/2024', Active: 'Yes', City: 'Doha' },
      mapping,
    );
    expect(issues).toEqual([]);
    expect(values).toEqual({
      name: 'ASHA',
      age: 1250,
      joined: '2024-03-05',
      active: true,
      city: 'DOH',
    });
    const blank = normaliseRow({ Name: '', Age: '', Joined: '', Active: '', City: '' }, mapping);
    expect(blank.values).toEqual({ city: 'UNK' });
  });

  it('reports each bad cell with its field instead of throwing', () => {
    const { values, issues } = normaliseRow(
      { Name: 'x', Age: 'abc', Joined: '31/02/2024', Active: 'maybe', City: '' },
      mapping,
    );
    expect(issues.map((i) => [i.path, i.code])).toEqual([
      ['age', 'not_a_number'],
      ['joined', 'not_a_date'],
      ['active', 'not_a_boolean'],
    ]);
    expect(values.name).toBe('X');
  });
});
