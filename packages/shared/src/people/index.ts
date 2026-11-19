/**
 * People: shared input schemas for employees, placements and employment periods (phase 3
 * row 3.1; PLAN 3.10, SPEC 3.2).
 *
 * Purpose: the API and the employee screens (row 3.3) validate the same way. An employee is
 * created either for a person who already exists as a party (`partyId`) or together with a
 * new person (`person`), never both: a person exists once (SPEC 2.8).
 *
 * Rules checked here, and why:
 *   - Phones are stored in international form, so "+974 5555 1234" and "+97455551234" are
 *     one number and duplicate checks can compare them exactly.
 *   - QID and passport numbers are free text (2 to 64 characters); the API normalises,
 *     encrypts, hashes and masks them (the party identifier vault) and never stores them
 *     in plain text.
 *   - A sponsor party is named only when the sponsorship is `outside`.
 *   - `statusCode` is not in any input: the status changes only through the state machine.
 *
 * Depends on: zod. Used by: apps/api modules/people, apps/web employee screens (row 3.3).
 */
import { z } from 'zod';

export const EMPLOYEE_SPONSORSHIPS = ['company', 'outside'] as const;
export const employeeSponsorshipSchema = z.enum(EMPLOYEE_SPONSORSHIPS);
export type EmployeeSponsorship = (typeof EMPLOYEE_SPONSORSHIPS)[number];

/** States the seeded `people.employee` machine starts with (administrators may add more). */
export const EMPLOYEE_STATUS_CODES = ['active', 'inactive', 'blocked', 'terminated'] as const;

const isoDate = z.iso.date();
const lookupCode = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, 'lower-case letters, digits and underscores');

/** A phone as typed; spaces, dashes and brackets are dropped before the check. */
export const phoneInputSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s()-]+/g, ''))
  .pipe(z.string().regex(/^\+[1-9][0-9]{6,14}$/, 'Use international form, e.g. +97455551234'));

/** A QID or passport number as typed (normalised and sealed by the API). */
export const identityNumberSchema = z.string().trim().min(2).max(64);

/** A new person created together with the employee. */
export const employeePersonSchema = z.strictObject({
  displayName: z.string().trim().min(1).max(300),
  /** Name per language, e.g. { en, ar, bn }. */
  names: z.record(z.string().min(2).max(8), z.string().trim().min(1).max(300)).optional(),
  dateOfBirth: isoDate.nullable().optional(),
  gender: z.enum(['female', 'male', 'other']).nullable().optional(),
  nationalityCode: z
    .string()
    .regex(/^[A-Z]{2}$/, 'a two-letter country code, e.g. QA')
    .nullable()
    .optional(),
  /** The first phone becomes the primary one. */
  phones: z.array(phoneInputSchema).max(5).optional(),
  whatsapp: phoneInputSchema.optional(),
  email: z.email().optional(),
  qid: identityNumberSchema.optional(),
  passport: identityNumberSchema.optional(),
});
export type EmployeePersonInput = z.infer<typeof employeePersonSchema>;

const placementFields = {
  validFrom: isoDate.optional(),
  validTo: isoDate.nullable().optional(),
  /** Code of the `profession` lookup (rider, driver ...). */
  profession: lookupCode,
  clientPlatformId: z.uuid().nullable().optional(),
  /** platform.org_unit of kind `zone`. */
  orgUnitId: z.uuid().nullable().optional(),
  /** platform.org_unit of kind `team`. */
  teamId: z.uuid().nullable().optional(),
  branchId: z.uuid().nullable().optional(),
};

export const employeePlacementCreateSchema = z
  .strictObject(placementFields)
  .refine((p) => p.validTo == null || p.validFrom === undefined || p.validTo >= p.validFrom, {
    path: ['validTo'],
    message: 'The end date is before the start date',
  });
export const employeePlacementUpdateSchema = z.strictObject(placementFields).partial();
export type EmployeePlacementInput = z.infer<typeof employeePlacementCreateSchema>;

export const employmentPeriodCreateSchema = z
  .strictObject({
    startDate: isoDate,
    endDate: isoDate.nullable().optional(),
    rehireEligible: z.boolean().optional(),
  })
  .refine((p) => p.endDate == null || p.endDate >= p.startDate, {
    path: ['endDate'],
    message: 'The end date is before the start date',
  });
export const employmentPeriodUpdateSchema = z
  .strictObject({
    startDate: isoDate,
    endDate: isoDate.nullable(),
    rehireEligible: z.boolean(),
  })
  .partial();

const employeeFields = {
  branchId: z.uuid().nullable().optional(),
  sponsorship: employeeSponsorshipSchema.optional(),
  sponsorPartyId: z.uuid().nullable().optional(),
  recruitingAgentPartyId: z.uuid().nullable().optional(),
  joiningDate: isoDate.nullable().optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
};

function sponsorRule(
  body: { sponsorship?: EmployeeSponsorship | undefined; sponsorPartyId?: string | null },
  ctx: z.RefinementCtx,
  // On create a missing sponsorship means "company"; on update it means "unchanged".
  missingMeansCompany: boolean,
): void {
  const company =
    body.sponsorship === 'company' || (missingMeansCompany && body.sponsorship === undefined);
  if (typeof body.sponsorPartyId === 'string' && company) {
    ctx.addIssue({
      code: 'custom',
      path: ['sponsorPartyId'],
      message: 'A sponsor is named only for an outside sponsorship',
    });
  }
}

export const employeeCreateSchema = z
  .strictObject({
    companyId: z.uuid().optional(),
    /** An existing person (party) becomes the employee ... */
    partyId: z.uuid().optional(),
    /** ... or a new person is created with the employee. */
    person: employeePersonSchema.optional(),
    ...employeeFields,
    /** The first placement (profession, platform, zone, team), from the joining date. */
    placement: employeePlacementCreateSchema.optional(),
    /** Go ahead although a person with the same phone exists (QID and passport never). */
    acknowledgeDuplicates: z.boolean().optional(),
  })
  .superRefine((body, ctx) => {
    if ((body.partyId === undefined) === (body.person === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['partyId'],
        message: 'Give either an existing person (partyId) or a new person, not both',
      });
    }
    sponsorRule(body, ctx, true);
  });
export type EmployeeCreateInput = z.infer<typeof employeeCreateSchema>;

export const employeeUpdateSchema = z
  .strictObject(employeeFields)
  .partial()
  .superRefine((body, ctx) => {
    sponsorRule(body, ctx, false);
  });
export type EmployeeUpdateInput = z.infer<typeof employeeUpdateSchema>;

/** Body of the duplicate check the create form runs before saving. */
export const employeeDuplicateCheckSchema = z.strictObject({
  companyId: z.uuid().optional(),
  qid: identityNumberSchema.optional(),
  passport: identityNumberSchema.optional(),
  phones: z.array(phoneInputSchema).max(6).optional(),
});
export type EmployeeDuplicateCheckInput = z.infer<typeof employeeDuplicateCheckSchema>;

export * from './documents.js';
export * from './employee-form.js';
