/**
 * Unmatched riders queue: shared request schemas and small helpers (phase 4 row 4.5b).
 *
 * Purpose: one definition of the bodies of link / create-employee / ignore, the list filters,
 * and the clean-up of the sheet's phone and driver-or-rider text, used by the API and the web
 * screen alike.
 * Depends on: zod. Used by: apps/api modules/performance (unmatched-router), apps/web performance screens.
 */
import { z } from 'zod';

const isoDate = z.iso.date();

export const UNMATCHED_STATUSES = ['open', 'linked', 'created', 'ignored'] as const;
export type UnmatchedStatus = (typeof UNMATCHED_STATUSES)[number];

export const unmatchedListQuerySchema = z.object({
  status: z.enum(UNMATCHED_STATUSES).optional(),
  /** A client platform id (`performance.client_platform`). */
  platform: z.uuid().optional(),
  /** Falcon ID, or part of the name or phone the sheet gave. */
  search: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/** Link to a person: an employee, or a party that holds no employee record yet. */
export const unmatchedLinkSchema = z
  .strictObject({
    employeeId: z.uuid().optional(),
    partyId: z.uuid().optional(),
    /** Defaults to the first date the id was seen in the sheet. */
    validFrom: isoDate.optional(),
  })
  .refine((b) => (b.employeeId === undefined) !== (b.partyId === undefined), {
    path: ['employeeId'],
    message: 'Give either an employee or a person, not both',
  });
export type UnmatchedLinkInput = z.infer<typeof unmatchedLinkSchema>;

/** Create an employee from the sheet row; every field is optional and overrides the sheet. */
export const unmatchedCreateEmployeeSchema = z.strictObject({
  displayName: z.string().trim().min(1).max(300).optional(),
  phone: z.string().trim().min(1).max(50).optional(),
  profession: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,39}$/)
    .optional(),
  joiningDate: isoDate.optional(),
  /** Go ahead although a person with the same phone exists. */
  acknowledgeDuplicates: z.boolean().optional(),
});
export type UnmatchedCreateEmployeeInput = z.infer<typeof unmatchedCreateEmployeeSchema>;

export const unmatchedIgnoreSchema = z.strictObject({
  reason: z.string().trim().min(2).max(500),
});

export const unmatchedCandidatesQuerySchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(15),
});

/**
 * The sheet's phone cell as an international number, or null when it cannot be read as one.
 * Qatar numbers (8 digits) get +974; "00974..." and "974..." and "+974..." are accepted.
 */
export function sheetPhoneToInternational(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  const compact = text.replace(/[\s()-]+/g, '');
  if (compact === '') return null;
  let digits: string;
  if (compact.startsWith('+')) digits = compact.slice(1);
  else if (compact.startsWith('00')) digits = compact.slice(2);
  else if (/^974\d{8}$/.test(compact)) digits = compact;
  else if (/^\d{8}$/.test(compact)) digits = `974${compact}`;
  else return null;
  return /^[1-9]\d{6,14}$/.test(digits) ? `+${digits}` : null;
}

/** "Driver / Rider" cell to a `profession` lookup code; null when it says neither. */
export function sheetProfessionCode(text: string | null | undefined): 'rider' | 'driver' | null {
  const value = (text ?? '').toLowerCase();
  const rider = /rider|bike|motor|scooter/.test(value);
  const driver = /driver|car|van|truck/.test(value);
  if (rider === driver) return null;
  return rider ? 'rider' : 'driver';
}
