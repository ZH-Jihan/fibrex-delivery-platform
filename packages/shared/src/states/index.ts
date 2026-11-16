/**
 * State machines (PLAN 3.7 `state_machine`, `state`, `state_transition`, `state_history`;
 * SPEC 2.10 "State machines").
 *
 * Purpose: the one description of a machine, its states and transitions, the body of a
 * "move this record" request, and the checks a move must pass that need no database
 * (required fields, reason, effective date). The API runs them before it changes a
 * record; the web screens use the schemas to check their forms.
 *
 * Rules of a move (business rules; the API adds the permission and the lookups):
 *   1. Every field the transition lists as required must be filled in on the record.
 *   2. When the transition needs a reason: a reason from its list when it has a list,
 *      otherwise a written note.
 *   3. The effective date is the day the new state counts from. It may be today or
 *      earlier (a status keyed late), never in the future, and never before the record's
 *      previous move, so the dated history stays in order.
 *
 * Depends on: zod, ../entities (labels, isAbsent). Used by: apps/api kernel/states, apps/web.
 */
import { z } from 'zod';
import { isAbsent, labelsSchema } from '../entities/index.js';

/** A custom record type key (`vehicle_request`) or a built-in type (`party.party`). */
export const stateEntityKeySchema = z
  .string()
  .trim()
  .regex(
    /^[a-z][a-z0-9_]{0,49}(\.[a-z][a-z0-9_]{0,49})?$/,
    'lower-case letters, digits and _ (built-in types: module.type)',
  );

export const stateCodeSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{0,49}$/, 'lower-case letters, digits and _');

export const STATE_CATEGORIES = ['open', 'active', 'closed'] as const;
export const stateCategorySchema = z.enum(STATE_CATEGORIES);
export type StateCategory = z.infer<typeof stateCategorySchema>;

/** `#rrggbb`, stored in lower case. */
export const stateColourSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^#[0-9a-f]{6}$/, 'a colour like #1f7a4d');

/** Labels by language; English is always there (the fallback of every other language). */
export const stateLabelsSchema = labelsSchema.refine(
  (labels) => (labels.en ?? '').trim() !== '',
  'the English label is required',
);

export const stateFieldKeySchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-zA-Z0-9_]{0,59}$/, 'a field key');

export const statePermissionKeySchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, 'a permission key like custom.vehicle.update');

export const stateRequiredFieldsSchema = z
  .array(stateFieldKeySchema)
  .max(50)
  .refine((list) => new Set(list).size === list.length, 'each field once');

/** The web form for a machine (also the API create body). */
export const stateMachineFormSchema = z.object({
  entityKey: stateEntityKeySchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
});

/** The web form for a state. A state cannot be both where records start and where they end. */
export const stateFormSchema = z
  .object({
    code: stateCodeSchema,
    labels: stateLabelsSchema,
    category: stateCategorySchema,
    isInitial: z.boolean(),
    isFinal: z.boolean(),
    colour: stateColourSchema.nullable().optional(),
    sortOrder: z.number().int().min(0).max(100_000).optional(),
  })
  .refine((s) => !(s.isInitial && s.isFinal), {
    path: ['isFinal'],
    message: 'A state cannot be both the first and a final state.',
  });

/** The web form for a transition. */
export const stateTransitionFormSchema = z
  .object({
    fromCode: stateCodeSchema,
    toCode: stateCodeSchema,
    permissionKey: statePermissionKeySchema.nullable().optional(),
    requiredFields: stateRequiredFieldsSchema,
    reasonRequired: z.boolean(),
    reasonLookupTypeId: z.uuid().nullable().optional(),
  })
  .refine((t) => t.fromCode !== t.toCode, {
    path: ['toCode'],
    message: 'A transition goes to a different state.',
  });

/** The body of `POST /transitions/{entityType}/{id}`. */
export const transitionRequestSchema = z.strictObject({
  toCode: stateCodeSchema,
  effectiveDate: z.iso.date().optional(),
  reasonId: z.uuid().optional(),
  note: z.string().trim().min(1).max(2000).optional(),
});
export type TransitionRequest = z.infer<typeof transitionRequestSchema>;

export interface StateIssue {
  path: string;
  code: string;
  message: string;
}

/** Rule 1: the required fields that are empty in `data`, in the order they were listed. */
export function missingRequiredFields(
  required: readonly string[],
  data: Readonly<Record<string, unknown>>,
): string[] {
  return required.filter((key) => isAbsent(data[key]));
}

export interface TransitionRule {
  requiredFields: readonly string[];
  reasonRequired: boolean;
  /** Whether the transition names a lookup list its reasons come from. */
  hasReasonList: boolean;
}

export interface TransitionFacts {
  /** The record's field values. */
  data: Readonly<Record<string, unknown>>;
  /** Today, `YYYY-MM-DD`. */
  today: string;
  /** Effective date of the record's previous move, when it has one. */
  lastEffectiveDate?: string | undefined;
}

/**
 * Rules 1 to 3 for one move. Returns every problem at once (an empty list means the move
 * may go ahead), so a screen can show them all next to their boxes. ISO dates compare
 * correctly as text.
 */
export function checkTransition(
  rule: TransitionRule,
  request: Pick<TransitionRequest, 'effectiveDate' | 'reasonId' | 'note'>,
  facts: TransitionFacts,
): StateIssue[] {
  const issues: StateIssue[] = [];
  // Rule 1.
  for (const key of missingRequiredFields(rule.requiredFields, facts.data)) {
    issues.push({
      path: `data.${key}`,
      code: 'required_for_transition',
      message: 'Fill this in before making this change.',
    });
  }
  // Rule 2.
  if (rule.reasonRequired) {
    if (rule.hasReasonList && request.reasonId === undefined) {
      issues.push({ path: 'reasonId', code: 'reason_required', message: 'Choose a reason.' });
    }
    if (!rule.hasReasonList && request.note === undefined) {
      issues.push({ path: 'note', code: 'reason_required', message: 'Write the reason.' });
    }
  }
  // Rule 3.
  const effective = request.effectiveDate ?? facts.today;
  if (effective > facts.today) {
    issues.push({
      path: 'effectiveDate',
      code: 'effective_date_future',
      message: 'The date cannot be in the future.',
    });
  } else if (facts.lastEffectiveDate !== undefined && effective < facts.lastEffectiveDate) {
    issues.push({
      path: 'effectiveDate',
      code: 'effective_date_before_previous',
      message: `The date cannot be before the previous change (${facts.lastEffectiveDate}).`,
    });
  }
  return issues;
}
