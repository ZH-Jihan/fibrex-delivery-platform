/**
 * Performance: the column mapping of a client platform's daily report sheet (phase 4 row 4.2;
 * SPEC 3.1, phase 4 plan sections 2 and 9).
 *
 * Purpose: Snoonu (and later Keeta, Talabat) may rename or reorder the columns of their
 * sheet. Which sheet header means which field is therefore data, stored as a versioned
 * `performance.column_mapping` row (SPEC 2.6), not code. A renamed column is fixed by adding
 * an alias here, from the mapping editor (row 4.5).
 *
 * Shape of a mapping, and why:
 *   - `fields`: the fixed per-person columns (Public ID, Name, Zone ...). Each has a list of
 *     header aliases. `column` (a letter) is a fallback used only when no header matches,
 *     because some columns of the real sheet have no header at all (Break start and Break
 *     End are blank in row 3 of the saved copy).
 *   - `metrics`: the columns repeated inside each day block (Assigned, Delivered ...). The
 *     key is the `metric_definition.key`.
 *   - Row numbers say where the header rows are. In the real sheet row 1 holds the day block
 *     titles ("1st of the month"), row 2 the metric names inside each block and the labels of
 *     Pending / Balance Amount, row 3 the fixed column headers, data from row 4.
 *   - Header text is compared after `normaliseHeader` (case, spaces and punctuation
 *     ignored), so "Late Log In By Min" and "late log-in by min" are the same header.
 *
 * Depends on: zod. Used by: apps/api modules/performance (parser, sync engine), the mapping
 * editor screen (row 4.5).
 */
import { z } from 'zod';

/** Fixed per-person fields a report sheet can carry. `public_id` is the match key. */
export const REPORT_FIELD_KEYS = [
  'public_id',
  'name',
  'company',
  'day_off',
  'schedule',
  'break_start',
  'break_end',
  'zone',
  'contact_number',
  'vehicle_type',
  'plate_number',
  'skill',
  'tags',
  'pending_amount',
  'balance_amount',
] as const;
export type ReportFieldKey = (typeof REPORT_FIELD_KEYS)[number];

/** How a fixed field's cell is read: as text, as a time of day (HH:MM), or as a number. */
export const REPORT_FIELD_TYPES = ['text', 'time', 'number'] as const;
export type ReportFieldType = (typeof REPORT_FIELD_TYPES)[number];

const aliasList = z.array(z.string().trim().min(1).max(100)).min(1).max(20);
const columnLetter = z.string().regex(/^[A-Z]{1,3}$/, 'Column must be a letter such as F');
const rowNumber = z.number().int().min(1).max(50);

export const reportFieldMappingSchema = z.object({
  aliases: aliasList,
  column: columnLetter.optional(),
  type: z.enum(REPORT_FIELD_TYPES).default('text'),
  required: z.boolean().default(false),
});
export type ReportFieldMapping = z.infer<typeof reportFieldMappingSchema>;

export const reportMetricMappingSchema = z.object({
  aliases: aliasList,
  required: z.boolean().default(false),
});

export const sheetColumnMappingSchema = z
  .object({
    /** Tab of the workbook that holds the daily report. */
    tab: z.string().trim().min(1).max(100),
    blockTitleRow: rowNumber,
    blockLabelRow: rowNumber,
    headerRow: rowNumber,
    firstDataRow: rowNumber,
    fields: z.partialRecord(z.enum(REPORT_FIELD_KEYS), reportFieldMappingSchema),
    metrics: z.record(
      z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, 'Metric keys are lower_snake_case'),
      reportMetricMappingSchema,
    ),
  })
  .refine((m) => m.firstDataRow > Math.max(m.headerRow, m.blockTitleRow, m.blockLabelRow), {
    message: 'Data must start below every header row',
    path: ['firstDataRow'],
  })
  .refine((m) => m.fields.public_id !== undefined, {
    message: 'The Public ID column is the match key and must be mapped',
    path: ['fields', 'public_id'],
  });
export type SheetColumnMapping = z.infer<typeof sheetColumnMappingSchema>;

/** Header text as compared: lower case, punctuation and repeated spaces removed. */
export function normaliseHeader(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, ' ')
    .trim();
}

/**
 * The mapping of Snoonu's Daily Report as it is today (saved copy, 2026-11-20). Stored as
 * version 1 of the source's `column_mapping`; administrators edit it from there.
 */
export const SNOONU_DEFAULT_MAPPING: SheetColumnMapping = sheetColumnMappingSchema.parse({
  tab: 'Daily Report',
  blockTitleRow: 1,
  blockLabelRow: 2,
  headerRow: 3,
  firstDataRow: 4,
  fields: {
    public_id: { aliases: ['Public ID', 'Falcon ID'], required: true },
    name: { aliases: ['Name'] },
    company: { aliases: ['Company'] },
    day_off: { aliases: ['Day OFF'] },
    schedule: { aliases: ['Schedule'] },
    break_start: { aliases: ['Break start'], column: 'F', type: 'time' },
    break_end: { aliases: ['Break End'], column: 'G', type: 'time' },
    zone: { aliases: ['Zone'] },
    contact_number: { aliases: ['Contact Number'] },
    vehicle_type: { aliases: ['Driver / Rider'] },
    plate_number: { aliases: ['Plate Number'] },
    skill: { aliases: ['Skill'] },
    tags: { aliases: ['Tags'] },
    pending_amount: { aliases: ['Pending Amount', 'Pending Amount -'], type: 'number' },
    balance_amount: { aliases: ['Balance Amount', 'Balance Amount +'], type: 'number' },
  },
  metrics: {
    assigned: { aliases: ['Assigned'] },
    // Orders are Delivered, not Assigned (phase 4 plan section 9).
    delivered: { aliases: ['Delivered'], required: true },
    acceptance_rate: { aliases: ['Acceptance Rate'] },
    working_hours: { aliases: ['Working Hours'], required: true },
    late_minutes: { aliases: ['Late Log In By Min', 'Late Login By Min'] },
    kms: { aliases: ['Kms'] },
    avg_km_per_order: { aliases: ['AVG KM per Order'] },
  },
});
