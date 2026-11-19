/**
 * Document expiry alerts: the settings schema and the alert rule (phase 3 row 3.4; SPEC 3.2,
 * PLAN 3.10 `expiry_alert_log`).
 *
 * Purpose: the daily expiry job (apps/api modules/people/expiry-service.ts) decides here which
 * alert windows of a document are due, and the alert settings screen (row 3.5) validates with
 * the same schema the API stores.
 *
 * Business rules (owner answers 2026-11-19, phase 3 plan section 8):
 *   - Emails go out only at the alert windows, by default 14 and 7 days before expiry. The
 *     company can change its default windows; a document type can override them
 *     (`document_type.alert_windows`).
 *   - No email on the expiry day or after. A window of 0 is the one exception: an
 *     administrator who sets 0 asks for "on the day" explicitly.
 *   - A window the job missed (the document was added late, or the job did not run) still
 *     alerts once, as long as the document has not reached its expiry day. Two windows due
 *     together are logged separately but the document is listed once in the email.
 *   - Expired documents are shown in the app only: one in-app alert the first time the job
 *     sees them expired (window `EXPIRED_WINDOW`), never an email.
 *   - The email goes to the company email list, a setting the admin edits (never code).
 *
 * Depends on: zod, ./documents.ts. Used by: ./index.ts (re-export), apps/api
 * modules/people (expiry service and router), apps/web alert settings (row 3.5).
 */
import { z } from 'zod';
import { alertWindowsSchema, DEFAULT_ALERT_WINDOWS } from './documents.js';

/** `platform.setting` key (company scope) of the alert settings. */
export const EXPIRY_SETTINGS_KEY = 'people.expiry_alerts';

/** The `expiry_alert_log.window_days` of the one in-app alert for an expired document. */
export const EXPIRED_WINDOW = -1;

export const expirySettingsSchema = z.strictObject({
  /** Who receives the consolidated email. Empty = no email (in-app alerts still run). */
  emails: z
    .array(z.email().max(254))
    .max(20)
    .refine((list) => new Set(list.map((e) => e.toLowerCase())).size === list.length, {
      message: 'Each address once',
    }),
  /** Default days before expiry that alert; a document type may override them. */
  windows: alertWindowsSchema.refine((w) => new Set(w).size === w.length, {
    message: 'Each window once',
  }),
});
export type ExpirySettings = z.infer<typeof expirySettingsSchema>;

/** Used until the company saves settings of its own. */
export const DEFAULT_EXPIRY_SETTINGS: ExpirySettings = {
  emails: [],
  windows: [...DEFAULT_ALERT_WINDOWS],
};

const DAY_MS = 86_400_000;

/** Whole days from `today` to `date` (both "YYYY-MM-DD"); negative once `date` has passed. */
export function daysUntil(date: string, today: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
}

/**
 * The windows to log for one document on this run, given its days left, the windows that
 * apply to it and the windows already logged for its current expiry date. `EXPIRED_WINDOW`
 * in the result means "first seen expired" (in-app only).
 */
export function dueExpiryWindows(input: {
  daysLeft: number;
  windows: readonly number[];
  alerted: readonly number[];
}): number[] {
  const { daysLeft, windows, alerted } = input;
  const done = new Set(alerted);
  if (daysLeft < 0) return done.has(EXPIRED_WINDOW) ? [] : [EXPIRED_WINDOW];
  return (
    windows
      .filter((w) => !done.has(w) && daysLeft <= w)
      // On the expiry day only an explicit window of 0 alerts (owner: no email on the day).
      .filter((w) => daysLeft > 0 || w === 0)
      .sort((a, b) => b - a)
  );
}
