/**
 * Formula definitions (PLAN 3.7 `formula`, `formula_version`; SPEC 2.10).
 *
 * Purpose: the one description of a formula's purpose, input schema, return type and test
 * cases, used by the API to check requests and by the web admin screen to check its form.
 * The engine itself lives in @fibrex/formula and takes its type lists from here.
 *
 * Depends on: zod. Used by: packages/formula, apps/api kernel/formulas, apps/web.
 */
import { z } from 'zod';

export const FORMULA_PURPOSES = [
  'pay_component',
  'billing_rate',
  'fine',
  'interest',
  'eligibility',
  'alert',
  'allocation',
  'risk',
] as const;
export type FormulaPurpose = (typeof FORMULA_PURPOSES)[number];

/** Types an input can have. A date is text in the form YYYY-MM-DD. */
export const FORMULA_INPUT_TYPES = [
  'decimal',
  'int',
  'bool',
  'string',
  'date',
  'list<decimal>',
  'list<int>',
  'list<string>',
] as const;
export type FormulaInputType = (typeof FORMULA_INPUT_TYPES)[number];

export const FORMULA_RETURN_TYPES = ['decimal', 'int', 'bool', 'string'] as const;
export type FormulaReturnType = (typeof FORMULA_RETURN_TYPES)[number];

export const FORMULA_VERSION_STATUSES = ['draft', 'active', 'retired'] as const;

export const formulaKeySchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_.]{0,59}$/, 'lower-case letters, digits, _ and .');

/** Input names: lower-case words joined by _, as they appear in the expression. */
export const formulaInputNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,59}$/);

export const formulaInputFieldSchema = z.strictObject({
  type: z.enum(FORMULA_INPUT_TYPES),
  description: z.string().max(500).optional(),
  default: z.unknown().optional(),
});

export const formulaInputSchemaSchema = z
  .record(formulaInputNameSchema, formulaInputFieldSchema)
  .refine((schema) => Object.keys(schema).length <= 50, 'at most 50 inputs');
export type FormulaInputSchema = z.infer<typeof formulaInputSchemaSchema>;

export const formulaTestCaseSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  inputs: z.record(z.string(), z.unknown()),
  expected: z.union([z.string().max(1000), z.boolean()]),
});
export type FormulaTestCase = z.infer<typeof formulaTestCaseSchema>;

export const formulaTestCasesSchema = z.array(formulaTestCaseSchema).max(100);
