/**
 * People documents: shared input schemas and the status rule (phase 3 row 3.2; PLAN 3.10,
 * SPEC 3.2).
 *
 * Purpose: the API and the document screens (row 3.3) validate the same way and colour a
 * document the same way.
 *
 * Rules checked here, and why:
 *   - A document is of a standard type (`documentTypeId`) or custom with a typed name
 *     (`customName`, "Add other document"), never both and never neither.
 *   - The number is free text of letters, digits, spaces, dashes and slashes. The API
 *     normalises it (spaces and dashes dropped, upper case), seals, hashes and masks it, and
 *     never stores or returns it in plain text (lists show the mask).
 *   - `status` is in no input: `deriveDocumentStatus` computes it from the expiry date.
 *   - Alert windows are days before expiry (0 to 365); null means the company default.
 *
 * Depends on: zod. Used by: ./index.ts (re-export), apps/api modules/people, apps/web
 * document screens (row 3.3).
 */
import { z } from 'zod';

export const DOCUMENT_OWNER_TYPES = ['party', 'vehicle', 'company'] as const;
export type DocumentOwnerType = (typeof DOCUMENT_OWNER_TYPES)[number];
export const documentOwnerTypeSchema = z.enum(DOCUMENT_OWNER_TYPES);

export const DOCUMENT_STATUSES = ['valid', 'expiring', 'expired', 'replaced'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/** Days before expiry that alert when a type has no windows of its own (owner, 2026-11-19). */
export const DEFAULT_ALERT_WINDOWS: readonly number[] = [14, 7];

const DAY_MS = 86_400_000;

/**
 * The status of a document on `today` (both "YYYY-MM-DD"):
 *   replaced  it was renewed (kept for history; nothing else matters);
 *   expired   the expiry date is before today (a document is still valid ON its expiry day);
 *   expiring  it expires within the largest alert window (today counts as 0 days);
 *   valid     otherwise, and always when it has no expiry date.
 */
export function deriveDocumentStatus(input: {
  expiryDate: string | null;
  today: string;
  alertWindows: readonly number[] | null;
  replaced: boolean;
}): DocumentStatus {
  if (input.replaced) return 'replaced';
  if (input.expiryDate === null) return 'valid';
  const daysLeft = Math.round(
    (Date.parse(`${input.expiryDate}T00:00:00Z`) - Date.parse(`${input.today}T00:00:00Z`)) / DAY_MS,
  );
  if (daysLeft < 0) return 'expired';
  const windows =
    input.alertWindows === null || input.alertWindows.length === 0
      ? DEFAULT_ALERT_WINDOWS
      : input.alertWindows;
  return daysLeft <= Math.max(...windows) ? 'expiring' : 'valid';
}

const isoDate = z.iso.date();
const typeCode = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,39}$/, 'lower-case letters, digits and underscores');
const lookupCode = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, 'lower-case letters, digits and underscores');

/** A document number as typed. */
export const documentNumberSchema = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[A-Za-z0-9/\s-]+$/, 'letters, digits, spaces, dashes and slashes only');

/** Name per language; English is required. */
export const documentTypeNameSchema = z
  .record(z.string().min(2).max(8), z.string().trim().min(1).max(120))
  .refine((names) => typeof names.en === 'string', {
    path: ['en'],
    message: 'An English name is required',
  });

export const alertWindowsSchema = z.array(z.number().int().min(0).max(365)).min(1).max(6);

export const documentTypeCreateSchema = z.strictObject({
  companyId: z.uuid().optional(),
  code: typeCode,
  name: documentTypeNameSchema,
  appliesTo: documentOwnerTypeSchema,
  hasExpiry: z.boolean().optional(),
  hasNumber: z.boolean().optional(),
  multiPage: z.boolean().optional(),
  alertWindows: alertWindowsSchema.nullable().optional(),
});
/** Code and owner kind are fixed once documents may use the type. */
export const documentTypeUpdateSchema = z
  .strictObject({
    name: documentTypeNameSchema,
    hasExpiry: z.boolean(),
    hasNumber: z.boolean(),
    multiPage: z.boolean(),
    alertWindows: alertWindowsSchema.nullable(),
  })
  .partial();
export type DocumentTypeCreateInput = z.infer<typeof documentTypeCreateSchema>;

const conditionExpr = z.string().trim().min(1).max(500);

export const documentRequirementCreateSchema = z.strictObject({
  companyId: z.uuid().optional(),
  documentTypeId: z.uuid(),
  /** A formula (true / false) over the employee, e.g. sponsorship == "outside". */
  conditionExpr: conditionExpr.nullable().optional(),
  /** Code of the `profession` lookup; empty = every profession. */
  appliesToProfession: lookupCode.nullable().optional(),
});
export const documentRequirementUpdateSchema = z
  .strictObject({
    conditionExpr: conditionExpr.nullable(),
    appliesToProfession: lookupCode.nullable(),
  })
  .partial();

const datesInOrder = (d: { issueDate?: string | null; expiryDate?: string | null }) =>
  d.issueDate == null || d.expiryDate == null || d.expiryDate >= d.issueDate;
const datesMessage = { path: ['expiryDate'], message: 'The expiry date is before the issue date' };

export const documentCreateSchema = z
  .strictObject({
    ownerType: documentOwnerTypeSchema,
    ownerId: z.uuid(),
    documentTypeId: z.uuid().optional(),
    /** "Add other document": a custom document with a typed name. */
    customName: z.string().trim().min(1).max(120).optional(),
    number: documentNumberSchema.optional(),
    issueDate: isoDate.nullable().optional(),
    expiryDate: isoDate.nullable().optional(),
  })
  .refine((d) => (d.documentTypeId === undefined) !== (d.customName === undefined), {
    path: ['documentTypeId'],
    message: 'Choose a document type or type a name for another document, not both',
  })
  .refine(datesInOrder, datesMessage);
export type DocumentCreateInput = z.infer<typeof documentCreateSchema>;

export const documentUpdateSchema = z
  .strictObject({
    customName: z.string().trim().min(1).max(120),
    /** null removes the number. */
    number: documentNumberSchema.nullable(),
    issueDate: isoDate.nullable(),
    expiryDate: isoDate.nullable(),
  })
  .partial()
  .refine(datesInOrder, datesMessage);

/** A renewal: the new document's details; owner and type come from the old one. */
export const documentRenewSchema = z
  .strictObject({
    number: documentNumberSchema.optional(),
    issueDate: isoDate.nullable().optional(),
    expiryDate: isoDate.nullable().optional(),
  })
  .refine(datesInOrder, datesMessage);

/** A scan of a document: a new page, or a new version of an existing page. */
export const documentFileSchema = z.strictObject({
  fileObjectId: z.uuid(),
  label: z.string().trim().min(1).max(120).optional(),
  /** The attachment (latest version) this file replaces; absent = a new page. */
  replacesAttachmentId: z.uuid().optional(),
});
