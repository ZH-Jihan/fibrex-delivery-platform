/**
 * Report shapes and filter checks (phase 2 row 2.13), shared by the API and the web page so
 * both accept exactly the same input.
 *
 * A report is defined in code by a module (columns, filters, a query). This file holds only
 * what both sides need to agree on: the column and filter descriptions, the request bodies
 * for running, exporting and saving, and `checkReportFilters`, which refuses a filter the
 * report does not declare or a value of the wrong kind before any query runs.
 *
 * Depends on: zod. Used by: apps/api kernel/reports, apps/web reports/ReportsPage.tsx.
 */
import { z } from 'zod';

export const REPORT_KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
export const REPORT_FORMATS = ['csv', 'xlsx', 'pdf'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];
export const MAX_REPORT_PAGE_SIZE = 200;

export type ReportColumnType = 'text' | 'number' | 'money' | 'date' | 'datetime' | 'boolean';
export interface ReportColumnSpec {
  key: string;
  label: string;
  type: ReportColumnType;
  /** True when the report may be sorted by this column. */
  sortable?: boolean;
}

export type ReportFilterType = 'text' | 'date' | 'number' | 'select' | 'boolean';
export interface ReportFilterSpec {
  key: string;
  label: string;
  type: ReportFilterType;
  /** Allowed values of a `select` filter. */
  options?: readonly { value: string; label: string }[];
  /**
   * A `select` whose choices come from a list endpoint (for example `/document-types`) instead
   * of fixed `options`. The screen shows the names; the filter value stays the record id.
   */
  lookup?: string;
}

/** One cell of a result row. Dates and times are ISO text; money is a decimal string. */
export type ReportCell = string | number | boolean | null;

/** Filter values are always text (query-string like); the report parses them. */
export const reportFiltersSchema = z
  .record(z.string().min(1).max(60), z.string().max(200))
  .default({});

const sortSchema = z.strictObject({
  key: z.string().min(1).max(60),
  direction: z.enum(['asc', 'desc']).default('asc'),
});

export const reportRunSchema = z.strictObject({
  filters: reportFiltersSchema,
  sort: sortSchema.optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(MAX_REPORT_PAGE_SIZE).default(50),
});

export const reportExportSchema = z.strictObject({
  format: z.enum(REPORT_FORMATS),
  filters: reportFiltersSchema,
  sort: sortSchema.optional(),
  /** Needed only when the caller has several companies. */
  companyId: z.uuid().optional(),
});

export const savedReportFormSchema = z.strictObject({
  reportKey: z.string().regex(REPORT_KEY, 'Not a report key'),
  name: z.string().trim().min(1).max(200),
  filters: reportFiltersSchema,
  /** Column keys to show, in order; empty means the report's own columns. */
  columns: z.array(z.string().min(1).max(60)).max(100).default([]),
  /** People who may open this saved report (they still need the report's own permission). */
  sharedWith: z.array(z.uuid()).max(100).default([]),
});

export interface ReportFilterProblem {
  key: string;
  message: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Checks filter values against what a report declares. Empty values are ignored. Returns the
 * cleaned values (empty ones dropped) and a list of problems; no problems means the values
 * are safe to hand to the report.
 */
export function checkReportFilters(
  specs: readonly ReportFilterSpec[],
  values: Record<string, string>,
): { values: Record<string, string>; problems: ReportFilterProblem[] } {
  const clean: Record<string, string> = {};
  const problems: ReportFilterProblem[] = [];
  for (const [key, raw] of Object.entries(values)) {
    const value = raw.trim();
    if (value === '') continue;
    const spec = specs.find((s) => s.key === key);
    if (spec === undefined) {
      problems.push({ key, message: 'This report has no such filter' });
      continue;
    }
    if (spec.type === 'date' && !(DATE.test(value) && !Number.isNaN(Date.parse(value)))) {
      problems.push({ key, message: 'Use a date like 2026-11-30' });
    } else if (spec.type === 'number' && !/^-?\d+(\.\d+)?$/.test(value)) {
      problems.push({ key, message: 'Enter a number' });
    } else if (spec.type === 'boolean' && value !== 'true' && value !== 'false') {
      problems.push({ key, message: 'Choose yes or no' });
    } else if (
      spec.type === 'select' &&
      spec.lookup === undefined &&
      !(spec.options ?? []).some((o) => o.value === value)
    ) {
      problems.push({ key, message: 'Choose one of the listed values' });
    } else {
      clean[key] = value;
    }
  }
  return { values: clean, problems };
}
