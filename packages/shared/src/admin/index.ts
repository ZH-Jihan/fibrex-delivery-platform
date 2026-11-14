/**
 * Shared form schemas for user and role administration.
 * Purpose: the web forms validate with the same rules the API enforces (SPEC 6.2), so a
 * form never accepts what the server would refuse. The API keeps its own copies with
 * extra OpenAPI metadata; the rules here must match `user-admin-router.ts` and
 * `access-admin-router.ts`.
 * Depends on: zod. Used by: apps/web admin screens.
 */
import { z } from 'zod';

const displayName = z.string().trim().min(1).max(200);
const email = z.email().max(254);
const phone = z.string().regex(/^\+[1-9][0-9]{6,14}$/, {
  message: 'Use the international format, e.g. +97455512345',
});

export const userCreateSchema = z.strictObject({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9._-]{2,63}$/, {
      message: '3 to 64 letters, digits, dot, dash or underscore',
    }),
  displayName,
  email: email.optional(),
  phone: phone.optional(),
});

/** The username never changes after creation. */
export const userUpdateSchema = z.strictObject({
  displayName,
  email: email.optional(),
  phone: phone.optional(),
});

export const roleCreateSchema = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/, {
    message: 'Lower-case letters, digits and underscore, starting with a letter',
  }),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
  mfaRequired: z.boolean().optional(),
});

/** The key never changes after creation. */
export const roleUpdateSchema = roleCreateSchema.omit({ key: true });

/** The small form used by the People screen to create a party (the API accepts more fields). */
export const partyQuickCreateSchema = z.strictObject({
  kind: z.enum(['person', 'organisation']),
  displayName,
});

/** Branch forms (same rules as `kernel/platform/organisation-router.ts`). */
const branchFields = {
  code: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,20}$/, {
      message: 'Up to 20 letters, digits, dash or underscore',
    }),
  name: z.string().trim().min(1).max(200),
  address: z.string().trim().max(500).optional(),
  isHeadOffice: z.boolean().optional(),
};
export const branchCreateSchema = z.strictObject(branchFields);
export const branchUpdateSchema = z.strictObject(branchFields).partial();

/**
 * The company settings form. The working week is edited as seven tick boxes `day_sun` ...
 * `day_sat` (the screen turns them into the API's `workingWeek` list); the month arrives
 * from a drop-down as text, so it is converted here.
 */
export const companyFormSchema = z.strictObject({
  legalName: z.string().trim().min(1).max(300),
  tradeName: z.string().trim().min(1).max(300).optional(),
  countryCode: z.string().regex(/^[A-Z]{2}$/, { message: 'A two-letter country code, e.g. QA' }),
  timeZone: z.string().trim().min(1).max(64),
  fiscalYearStartMonth: z.coerce.number().int().min(1).max(12),
  status: z.enum(['active', 'inactive']),
  day_sun: z.boolean().optional(),
  day_mon: z.boolean().optional(),
  day_tue: z.boolean().optional(),
  day_wed: z.boolean().optional(),
  day_thu: z.boolean().optional(),
  day_fri: z.boolean().optional(),
  day_sat: z.boolean().optional(),
});
