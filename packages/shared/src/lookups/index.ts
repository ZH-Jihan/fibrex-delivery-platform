/**
 * Lookup helpers shared by the API and the web app (phase 2 row 2.3).
 *
 * Purpose: one definition of what a lookup key and value code look like and how a label is
 * picked for a language, so the dropdowns, the admin screen and the API agree.
 * Depends on: zod. Used by: apps/api kernel/lookups, apps/web lookups screens.
 */
import { z } from 'zod';

/** Keys of lookup types: lower-case words joined by `_` (matches the database CHECK). */
export const lookupKeyPattern = /^[a-z][a-z0-9_]{0,49}$/;
/** Codes of lookup values (matches the database CHECK). Stored on records, so never changed. */
export const lookupCodePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/;

/** Labels per language, e.g. `{ en: 'Motorbike', bn: '...' }`. */
export type LookupLabels = Record<string, string>;

/** The language every value must have a label in; it is the fallback for the others. */
export const LOOKUP_FALLBACK_LANGUAGE = 'en';

/**
 * The label to show: the wanted language, else English, else any label, else the code.
 * Empty strings count as missing so a half-filled translation never shows a blank option.
 */
export function lookupLabel(labels: LookupLabels, language: string, code: string): string {
  const usable = (text: string | undefined): text is string =>
    text !== undefined && text.trim() !== '';
  const wanted = labels[language];
  if (usable(wanted)) return wanted;
  const fallback = labels[LOOKUP_FALLBACK_LANGUAGE];
  if (usable(fallback)) return fallback;
  const any = Object.values(labels).find(usable);
  return any ?? code;
}

/** Problem with a labels object, or null when it is fine: needs a non-empty English label. */
export function labelsProblem(labels: LookupLabels): string | null {
  const en = labels[LOOKUP_FALLBACK_LANGUAGE];
  if (en === undefined || en.trim() === '') return 'An English label is required.';
  return null;
}

/** Languages the admin screen offers a label box for (the app's interface languages). */
export const LOOKUP_LANGUAGES = ['en', 'bn', 'ur', 'hi', 'ne'] as const;

/** Form for a list: the key is fixed once created (modules look lists up by it). */
export const lookupTypeFormSchema = z.strictObject({
  key: z.string().trim().regex(lookupKeyPattern, { message: 'Lower-case letters, digits and _' }),
  name: z.string().trim().min(1).max(200),
  allowHierarchy: z.boolean().default(false),
});

/**
 * Form for a value: one label box per language (English required), flattened so the generic
 * form can show it. `lookupValueBody` turns the form values into the API body.
 */
export const lookupValueFormSchema = z.strictObject({
  code: z.string().trim().regex(lookupCodePattern, { message: 'Letters, digits, _ . -' }),
  labelEn: z.string().trim().min(1).max(200),
  labelBn: z.string().trim().max(200).default(''),
  labelUr: z.string().trim().max(200).default(''),
  labelHi: z.string().trim().max(200).default(''),
  labelNe: z.string().trim().max(200).default(''),
  sortOrder: z.coerce.number().int().min(-1_000_000).max(1_000_000).default(0),
  active: z.boolean().default(true),
  parentId: z.string().default(''),
});
export type LookupValueForm = z.infer<typeof lookupValueFormSchema>;

/** The `labels` object of a value from the form's label boxes (blank boxes are left out). */
export function labelsFromForm(form: LookupValueForm): LookupLabels {
  const all: LookupLabels = {
    en: form.labelEn,
    bn: form.labelBn,
    ur: form.labelUr,
    hi: form.labelHi,
    ne: form.labelNe,
  };
  return Object.fromEntries(Object.entries(all).filter(([, text]) => text.trim() !== ''));
}
