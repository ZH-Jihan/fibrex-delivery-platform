/**
 * Bulk scan upload: shared schemas and the person-suggestion rule (phase 3 row 3.7; SPEC 5.12,
 * PLAN 3.10 `bulk_upload`, `bulk_upload_item`).
 *
 * Purpose: staff drop many scans at once; each scan is read by OCR (row 3.6) and the system
 * suggests the person and the document type. The API and the review screen use the same rules.
 *
 * Rules, and why:
 *   - A suggestion is never a decision. An item becomes a document only when staff confirm it
 *     (the confirm body is an ordinary document body, so staff can change person, type, number
 *     and dates first); a rejected item keeps its reason.
 *   - A person is suggested only when exactly one candidate matches the holder name read from
 *     the scan (same word-set rule as the name check, `namesMatch`). Zero matches or several
 *     matches suggest nobody: guessing between two people with the same name would put a
 *     document on the wrong person.
 *   - At most `BULK_UPLOAD_MAX_FILES` scans per batch, so one request stays small.
 *
 * Depends on: zod, ./ocr.ts (namesMatch). Used by: apps/api modules/people (bulk upload router),
 * apps/web people/BulkUploadPage.tsx.
 */
import { z } from 'zod';
import { namesMatch } from './ocr.js';

export const BULK_UPLOAD_MAX_FILES = 50;
export const BULK_ITEM_STATUSES = ['pending', 'confirmed', 'rejected'] as const;
export type BulkItemStatus = (typeof BULK_ITEM_STATUSES)[number];
export const BULK_UPLOAD_STATUSES = ['open', 'completed'] as const;

/** Body of POST /bulk-uploads: files already uploaded through the files module. */
export const bulkUploadCreateSchema = z.strictObject({
  fileObjectIds: z
    .array(z.uuid())
    .min(1)
    .max(BULK_UPLOAD_MAX_FILES)
    .refine((ids) => new Set(ids).size === ids.length, 'Each file may be listed once'),
});
export type BulkUploadCreateInput = z.infer<typeof bulkUploadCreateSchema>;

/** Body of POST /bulk-uploads/{id}/items/{itemId}/reject. */
export const bulkItemRejectSchema = z.strictObject({
  reason: z.string().trim().min(1).max(500),
});

/** The one candidate whose name matches the holder name, or null (see the rules above). */
export function suggestPartyId(
  holderName: string | null,
  candidates: readonly { id: string; names: readonly string[] }[],
): string | null {
  if (holderName === null || holderName.trim() === '') return null;
  const matches = candidates.filter((c) => c.names.some((n) => namesMatch(holderName, n)));
  return matches.length === 1 ? (matches[0]?.id ?? null) : null;
}
