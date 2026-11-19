/**
 * Document OCR: shared schemas and the flag rules (phase 3 row 3.6; SPEC 5.12, PLAN 3.10
 * `ocr_job`).
 *
 * Purpose: the API decides which warnings an OCR read gets, and the confirm panel in the web
 * app shows them, from one set of rules.
 *
 * Rules, and why:
 *   - OCR only pre-fills. Nothing it reads is saved as a document until a person confirms
 *     the values (the confirm body is a normal document body, so the person can correct
 *     every field first).
 *   - Each field has a confidence between 0 and 1. Any field below `OCR_LOW_CONFIDENCE`
 *     that has a value gets the `low_confidence` flag, so the person looks twice.
 *   - `name_mismatch`: the holder name on the scan does not match the person the scan is
 *     being added to (SPEC 5.12). Names are compared as sets of words, ignoring case,
 *     accents, punctuation and word order, because scans write "SURNAME GIVEN" while
 *     profiles often hold "Given Surname". One name having extra words (a middle name)
 *     still matches when all words of the shorter name are in the longer one.
 *   - `expired`: the expiry date read is before today.
 *   - `unreadable` and `cropped` come from the adapter's own quality check; `unreadable`
 *     is also set when the adapter returned no usable field at all.
 *   - `duplicate`: the number read is already held by a document in the company (decided by
 *     the API from the keyed hash, passed in here as a boolean).
 *
 * Depends on: zod. Used by: ./index.ts (re-export), apps/api modules/people (ocr router),
 * apps/web people/OcrScan.tsx.
 */
import { z } from 'zod';

export const OCR_FIELDS = [
  'documentType',
  'number',
  'holderName',
  'issueDate',
  'expiryDate',
] as const;
export type OcrFieldName = (typeof OCR_FIELDS)[number];

export const OCR_FLAGS = [
  'low_confidence',
  'name_mismatch',
  'expired',
  'unreadable',
  'cropped',
  'duplicate',
] as const;
export type OcrFlag = (typeof OCR_FLAGS)[number];

export const OCR_JOB_STATUSES = ['pending', 'completed', 'failed', 'confirmed'] as const;
export type OcrJobStatus = (typeof OCR_JOB_STATUSES)[number];

/** Below this a field is "low confidence" (shown in amber, flagged). */
export const OCR_LOW_CONFIDENCE = 0.6;

/** Body of POST /ocr/jobs: a file already uploaded through the files module, plus hints. */
export const ocrJobCreateSchema = z.strictObject({
  fileObjectId: z.uuid(),
  /** The person the scan is for (a party); enables the name check. */
  ownerId: z.uuid().optional(),
  /** The expected document type, when the person chose one before scanning. */
  documentTypeId: z.uuid().optional(),
});
export type OcrJobCreateInput = z.infer<typeof ocrJobCreateSchema>;

/** Lower case, accents and punctuation removed, split into words. */
export function nameWords(name: string): string[] {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 0);
}

/** True when every word of the shorter name is in the longer one (order ignored). */
export function namesMatch(a: string, b: string): boolean {
  const x = nameWords(a);
  const y = nameWords(b);
  if (x.length === 0 || y.length === 0) return false;
  const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
  const pool = new Set(longer);
  return shorter.every((w) => pool.has(w));
}

export interface OcrFieldReading {
  value: string | null;
  confidence: number;
}

/** The flags of one OCR read, in the order of OCR_FLAGS. */
export function deriveOcrFlags(input: {
  fields: Partial<Record<OcrFieldName, OcrFieldReading>>;
  /** Quality warnings from the adapter itself. */
  quality: readonly ('unreadable' | 'cropped')[];
  /** Names the person is known by (display name, names per language); empty = no check. */
  expectedNames: readonly string[];
  /** "YYYY-MM-DD". */
  today: string;
  duplicate: boolean;
}): OcrFlag[] {
  const flags = new Set<OcrFlag>();
  const read = Object.values(input.fields).filter((f) => f.value !== null && f.value !== '');
  if (read.some((f) => f.confidence < OCR_LOW_CONFIDENCE)) flags.add('low_confidence');

  const holder = input.fields.holderName?.value ?? null;
  if (
    holder !== null &&
    input.expectedNames.length > 0 &&
    !input.expectedNames.some((n) => namesMatch(holder, n))
  ) {
    flags.add('name_mismatch');
  }

  const expiry = input.fields.expiryDate?.value ?? null;
  if (expiry !== null && expiry < input.today) flags.add('expired');

  if (input.quality.includes('unreadable') || read.length === 0) flags.add('unreadable');
  if (input.quality.includes('cropped')) flags.add('cropped');
  if (input.duplicate) flags.add('duplicate');
  return OCR_FLAGS.filter((f) => flags.has(f));
}
