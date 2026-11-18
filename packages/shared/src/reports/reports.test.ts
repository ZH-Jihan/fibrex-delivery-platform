// Tests for phase 2 row 2.13: report request shapes and filter checks.
import { describe, expect, it } from 'vitest';
import {
  checkReportFilters,
  reportExportSchema,
  reportRunSchema,
  savedReportFormSchema,
  type ReportFilterSpec,
} from './index.js';

const specs: ReportFilterSpec[] = [
  { key: 'name', label: 'Name', type: 'text' },
  { key: 'from', label: 'From', type: 'date' },
  { key: 'min', label: 'Minimum', type: 'number' },
  { key: 'open', label: 'Open', type: 'boolean' },
  {
    key: 'kind',
    label: 'Kind',
    type: 'select',
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ],
  },
];

describe('checkReportFilters', () => {
  it('keeps valid values and drops empty ones', () => {
    const result = checkReportFilters(specs, {
      name: ' Ali ',
      from: '2026-11-30',
      min: '-2.5',
      open: 'true',
      kind: 'b',
      other: '',
    });
    expect(result.problems).toEqual([]);
    expect(result.values).toEqual({
      name: 'Ali',
      from: '2026-11-30',
      min: '-2.5',
      open: 'true',
      kind: 'b',
    });
  });

  it('names every filter that is unknown or of the wrong kind', () => {
    const result = checkReportFilters(specs, {
      from: '30/11/2026',
      min: 'abc',
      open: 'yes',
      kind: 'z',
      nope: 'x',
    });
    expect(result.problems.map((p) => p.key).sort()).toEqual([
      'from',
      'kind',
      'min',
      'nope',
      'open',
    ]);
    expect(result.values).toEqual({});
  });

  it('refuses a date that does not exist', () => {
    expect(checkReportFilters(specs, { from: '2026-13-45' }).problems).toHaveLength(1);
  });
});

describe('report request schemas', () => {
  it('fills defaults for a run and refuses an oversized page', () => {
    expect(reportRunSchema.parse({})).toEqual({ filters: {}, page: 1, pageSize: 50 });
    expect(reportRunSchema.safeParse({ pageSize: 201 }).success).toBe(false);
    expect(reportRunSchema.safeParse({ extra: 1 }).success).toBe(false);
  });

  it('accepts only known export formats', () => {
    expect(reportExportSchema.safeParse({ format: 'pdf' }).success).toBe(true);
    expect(reportExportSchema.safeParse({ format: 'docx' }).success).toBe(false);
  });

  it('checks a saved report', () => {
    const ok = savedReportFormSchema.safeParse({
      reportKey: 'integration.export_log',
      name: ' Mine ',
    });
    expect(ok.success).toBe(true);
    expect(ok.success && ok.data.name).toBe('Mine');
    expect(savedReportFormSchema.safeParse({ reportKey: 'Bad Key', name: 'x' }).success).toBe(
      false,
    );
    expect(
      savedReportFormSchema.safeParse({ reportKey: 'a.b', name: 'x', sharedWith: ['nope'] })
        .success,
    ).toBe(false);
  });
});
