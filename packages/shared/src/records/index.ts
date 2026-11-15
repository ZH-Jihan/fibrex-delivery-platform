/**
 * Custom records shared by the API and the web app (phase 2 row 2.5).
 *
 * Purpose: one definition of
 *   - the bodies of `POST` and `PATCH /records/{entityKey}` and of a record link,
 *   - how a change of some fields is merged into the stored data,
 *   - how list filters (`?f.colour=red`) become the containment test the database runs,
 * so the generated pages (row 2.6) and the server agree on every rule.
 *
 * Depends on: zod, ../entities. Used by: apps/api kernel/records, later the generated pages.
 */
import { z } from 'zod';
import {
  entityKeyPattern,
  stripAbsent,
  systemEntityKeyPattern,
  type RecordIssue,
  type RecordJsonSchema,
} from '../entities/index.js';

const recordData = z.record(z.string(), z.unknown());

/** Body of `POST /records/{entityKey}`. */
export const recordCreateSchema = z.strictObject({
  /** The field values, keyed by field key. */
  data: recordData,
  /** Needed only when the session spans several companies. */
  companyId: z.uuid().optional(),
  branchId: z.uuid().nullable().optional(),
  /** The person or organisation the record is about, when there is one. */
  partyId: z.uuid().nullable().optional(),
});
export type RecordCreate = z.infer<typeof recordCreateSchema>;

/** Body of `PATCH /records/{entityKey}/{id}`: `data` holds only the fields to change. */
export const recordUpdateSchema = z
  .strictObject({
    data: recordData,
    branchId: z.uuid().nullable(),
    partyId: z.uuid().nullable(),
  })
  .partial();
export type RecordUpdate = z.infer<typeof recordUpdateSchema>;

/** What a relation between two records is called, e.g. `inspected_vehicle`. */
export const relationKeyPattern = /^[a-z][a-z0-9_]{0,49}$/;

/** Body of `POST /records/{entityKey}/{id}/links`. */
export const recordLinkCreateSchema = z.strictObject({
  relationKey: z.string().trim().regex(relationKeyPattern, 'lower-case letters, digits and _'),
  /** Key of the target's record type: a custom key, or a built-in one such as `party.party`. */
  toEntityType: z
    .string()
    .trim()
    .refine((key) => entityKeyPattern.test(key) || systemEntityKeyPattern.test(key), {
      message: 'This is not a record type key.',
    }),
  toId: z.uuid(),
});
export type RecordLinkCreate = z.infer<typeof recordLinkCreateSchema>;

/**
 * The data to store after a change: the sent fields replace the stored ones, and a field
 * sent as "not filled in" (null, empty text, empty list) is removed. Fields not sent stay.
 */
export function mergeRecordData(
  current: Record<string, unknown>,
  changes: Record<string, unknown>,
): Record<string, unknown> {
  return stripAbsent({ ...current, ...changes });
}

/** Query-string prefix of a filter on a field value: `?f.<fieldKey>=<value>`. */
export const RECORD_FILTER_PREFIX = 'f.';

export type DataFilterResult =
  { ok: true; contains: Record<string, unknown> } | { ok: false; issues: RecordIssue[] };

/**
 * Turns field filters into one object the record data must contain (`data @> contains`),
 * which is the test the GIN index serves. Every filter is an exact match:
 *   - text, date, decimal, dropdown and references: the value as written (a decimal is
 *     stored as text, so `12.50` does not match `12.5`);
 *   - whole number: the number; yes/no: `true` or `false`;
 *   - multi-select: records whose list includes the given choice.
 * A filter on a field the record type does not have, or with a value of the wrong kind, is
 * reported instead of being ignored: a silently dropped filter would list too much.
 */
export function buildDataFilter(
  schema: RecordJsonSchema,
  filters: Record<string, unknown>,
): DataFilterResult {
  const contains: Record<string, unknown> = {};
  const issues: RecordIssue[] = [];
  const bad = (key: string, code: string, message: string) => {
    issues.push({ path: `${RECORD_FILTER_PREFIX}${key}`, code, message });
  };
  for (const [key, raw] of Object.entries(filters)) {
    const property = Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined;
    if (property === undefined) {
      bad(key, 'unknown_field', 'This field does not exist.');
      continue;
    }
    if (typeof raw !== 'string' || raw === '') {
      bad(key, 'invalid_filter', 'Give one value to filter by.');
      continue;
    }
    switch (property.type) {
      case 'string':
        contains[key] = raw;
        break;
      case 'integer':
        if (!/^-?\d{1,15}$/.test(raw)) bad(key, 'invalid_filter', 'A whole number is expected.');
        else contains[key] = Number(raw);
        break;
      case 'boolean':
        if (raw !== 'true' && raw !== 'false') bad(key, 'invalid_filter', 'Use true or false.');
        else contains[key] = raw === 'true';
        break;
      case 'array':
        contains[key] = [raw];
        break;
    }
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, contains };
}
