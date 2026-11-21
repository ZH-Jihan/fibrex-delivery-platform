/**
 * Sync source form (phase 4 row 4.4): the shape the API accepts and the web form checks.
 *
 * A source is one platform report the sync engine reads: a Google Sheet (`sheet`) read on a
 * schedule, or `excel` (upload only, never scheduled). For a sheet the owner may paste the
 * whole browser URL; `spreadsheetIdOf` takes the id out of it, so the stored value is always
 * the bare id.
 *
 * Row 4.4b: a sheet source also says how the app signs in to Google (`authMode`):
 * `service_account` (the default: a mirror sheet shared as Viewer with the app's service
 * account, nothing expires) or `oauth` (the owner's consented Google account; an unpublished
 * app must reconnect every 7 days). Sources saved before 4.4b have no mode and are read with
 * `oauth`, which is how they were connected.
 *
 * Depends on: zod. Used by: apps/api modules/performance (sync source routes, Google
 * connection test), apps/web performance screens.
 */
import { z } from 'zod';

/** A Google spreadsheet id as it appears in `/spreadsheets/d/<id>/`. */
const SPREADSHEET_ID = /^[A-Za-z0-9_-]{20,120}$/;
const SPREADSHEET_URL = /\/spreadsheets\/d\/([A-Za-z0-9_-]{20,120})/;

/** The spreadsheet id from a bare id or a Google Sheets URL; null when it is neither. */
export function spreadsheetIdOf(input: string): string | null {
  const text = input.trim();
  if (SPREADSHEET_ID.test(text)) return text;
  return SPREADSHEET_URL.exec(text)?.[1] ?? null;
}

/** Five cron fields (minute hour day month weekday), digits and `* , - /` only. */
const CRON = /^([\d*,/-]+\s+){4}[\d*,/-]+$/;

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export const SYNC_SOURCE_KINDS = ['sheet', 'excel'] as const;

/** How the app signs in to Google to read a sheet (row 4.4b); the first is the default. */
export const GOOGLE_AUTH_MODES = ['service_account', 'oauth'] as const;
export type GoogleAuthMode = (typeof GOOGLE_AUTH_MODES)[number];
export const DEFAULT_GOOGLE_AUTH_MODE: GoogleAuthMode = 'service_account';

export const syncSourceFormSchema = z
  .object({
    clientPlatformId: z.uuid(),
    name: z.string().trim().min(1).max(120),
    adapterKind: z.enum(SYNC_SOURCE_KINDS),
    /** Spreadsheet id or URL; required for `sheet`, ignored for `excel`. */
    spreadsheet: z.string().trim().max(500).optional(),
    /** The tab that holds the daily report (Snoonu: "Daily Report"). */
    tab: z.string().trim().min(1).max(100).default('Daily Report'),
    /** How a `sheet` source signs in to Google; ignored for `excel`. */
    authMode: z.enum(GOOGLE_AUTH_MODES).default(DEFAULT_GOOGLE_AUTH_MODE),
    scheduleCron: z
      .string()
      .trim()
      .regex(CRON, 'Use five cron fields, for example "0 4 * * *" for 04:00 every day.')
      .default('0 4 * * *'),
    timeZone: z
      .string()
      .trim()
      .refine(isTimeZone, 'Unknown time zone; use a name such as Asia/Qatar.')
      .default('Asia/Qatar'),
    active: z.boolean().default(true),
  })
  .superRefine((form, ctx) => {
    if (form.adapterKind !== 'sheet') return;
    if (form.spreadsheet === undefined || spreadsheetIdOf(form.spreadsheet) === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['spreadsheet'],
        message: 'Paste the spreadsheet URL or its id (the part after /spreadsheets/d/).',
      });
    }
  });
export type SyncSourceForm = z.infer<typeof syncSourceFormSchema>;

/** "Test headers": which spreadsheet and tab to read row 3 (the header row) of. */
export const sheetHeaderTestSchema = z.object({
  spreadsheet: z
    .string()
    .trim()
    .refine((v) => spreadsheetIdOf(v) !== null, 'Paste the spreadsheet URL or its id.'),
  tab: z.string().trim().min(1).max(100).default('Daily Report'),
  authMode: z.enum(GOOGLE_AUTH_MODES).default(DEFAULT_GOOGLE_AUTH_MODE),
});
export type SheetHeaderTest = z.infer<typeof sheetHeaderTestSchema>;
