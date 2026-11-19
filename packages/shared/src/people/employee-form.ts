/**
 * Employee form (phase 3 row 3.3a): the flat values the Employees screen collects, checked
 * once here, and the conversion into the API bodies of row 3.1.
 *
 * Purpose: the screen's form is flat (one text box per field) while the API body is nested
 * (`person`, `placement`). Keeping both the check and the conversion in shared code means
 * the screen and the tests agree on what is sent.
 *
 * Rules, and why:
 *   - Only the English name is required; Arabic and Bangla names are stored under `names`
 *     (`ar`, `bn`), the English one under `en`, so the person shows in any language.
 *   - Several phones are typed in one box separated by commas; the first becomes primary.
 *   - A sponsor party is named only for an outside sponsorship (same rule as the API).
 *   - QID and passport are sent as typed; the API normalises, seals and hashes them.
 *   - Editing never changes the person (done on the party screen) or the status (state
 *     machine); it changes sponsorship, sponsor, agent and joining date only.
 *
 * Depends on: zod, ./index.ts. Used by: apps/web people/EmployeesPage.
 */
import { z } from 'zod';
import {
  employeeCreateSchema,
  employeeUpdateSchema,
  phoneInputSchema,
  type EmployeeCreateInput,
  type EmployeeUpdateInput,
} from './index.js';

const text = (max: number) => z.string().trim().min(1).max(max).optional();

function splitPhones(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[,;]/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
}

export const employeeFormSchema = z
  .object({
    displayName: z.string().trim().min(1).max(300),
    nameAr: text(300),
    nameBn: text(300),
    /** Phones separated by commas; the first is the primary one. */
    phones: z.string().trim().min(1).optional(),
    qid: z.string().trim().min(2).max(64).optional(),
    passport: z.string().trim().min(2).max(64).optional(),
    nationalityCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}$/, 'a two-letter country code, e.g. QA')
      .optional(),
    sponsorship: z.enum(['company', 'outside']).optional(),
    sponsorPartyId: z.uuid().optional(),
    recruitingAgentPartyId: z.uuid().optional(),
    joiningDate: z.iso.date().optional(),
    /** Code of the `profession` lookup; starts the first placement when given. */
    profession: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,39}$/)
      .optional(),
    acknowledgeDuplicates: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.sponsorPartyId !== undefined && v.sponsorship !== 'outside') {
      ctx.addIssue({
        code: 'custom',
        path: ['sponsorPartyId'],
        message: 'A sponsor is named only for an outside sponsorship',
      });
    }
    for (const p of splitPhones(v.phones)) {
      if (!phoneInputSchema.safeParse(p).success) {
        ctx.addIssue({
          code: 'custom',
          path: ['phones'],
          message: 'Use international form, e.g. +97455551234',
        });
        break;
      }
    }
  });
export type EmployeeFormValues = z.infer<typeof employeeFormSchema>;

/** The edit form: only the employment fields (see the header). */
export const employeeEditFormSchema = z
  .object({
    sponsorship: z.enum(['company', 'outside']).optional(),
    sponsorPartyId: z.uuid().optional(),
    recruitingAgentPartyId: z.uuid().optional(),
    joiningDate: z.iso.date().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.sponsorPartyId !== undefined && v.sponsorship !== 'outside') {
      ctx.addIssue({
        code: 'custom',
        path: ['sponsorPartyId'],
        message: 'A sponsor is named only for an outside sponsorship',
      });
    }
  });
export type EmployeeEditFormValues = z.infer<typeof employeeEditFormSchema>;

/** Flat form values to the body of POST /employees (checked by the API schema again). */
export function employeeFormToCreate(values: EmployeeFormValues): EmployeeCreateInput {
  const names: Record<string, string> = { en: values.displayName };
  if (values.nameAr !== undefined) names.ar = values.nameAr;
  if (values.nameBn !== undefined) names.bn = values.nameBn;
  const phones = splitPhones(values.phones).map((p) => phoneInputSchema.parse(p));
  const body = {
    person: {
      displayName: values.displayName,
      names,
      ...(values.nationalityCode === undefined ? {} : { nationalityCode: values.nationalityCode }),
      ...(phones.length === 0 ? {} : { phones }),
      ...(values.qid === undefined ? {} : { qid: values.qid }),
      ...(values.passport === undefined ? {} : { passport: values.passport }),
    },
    sponsorship: values.sponsorship ?? 'company',
    ...(values.sponsorPartyId === undefined ? {} : { sponsorPartyId: values.sponsorPartyId }),
    ...(values.recruitingAgentPartyId === undefined
      ? {}
      : { recruitingAgentPartyId: values.recruitingAgentPartyId }),
    ...(values.joiningDate === undefined ? {} : { joiningDate: values.joiningDate }),
    ...(values.profession === undefined ? {} : { placement: { profession: values.profession } }),
    ...(values.acknowledgeDuplicates === true ? { acknowledgeDuplicates: true } : {}),
  };
  return employeeCreateSchema.parse(body);
}

/** Edit values to the body of PATCH /employees/{id}; a cleared box sends null. */
export function employeeEditToUpdate(values: EmployeeEditFormValues): EmployeeUpdateInput {
  return employeeUpdateSchema.parse({
    ...(values.sponsorship === undefined ? {} : { sponsorship: values.sponsorship }),
    sponsorPartyId: values.sponsorPartyId ?? null,
    recruitingAgentPartyId: values.recruitingAgentPartyId ?? null,
    joiningDate: values.joiningDate ?? null,
  });
}
