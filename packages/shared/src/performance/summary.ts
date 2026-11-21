/**
 * Daily performance summary email: shared settings schema (phase 4 row 4.6b).
 *
 * Purpose: one definition of the company setting that says who gets the daily summary, at
 * what local time and whether it is on, used by the API (read, save, schedule) and the web
 * settings screen alike. The setting is a company row of `platform.setting`.
 * Depends on: zod. Used by: apps/api modules/performance (summary-service, summary-router),
 * apps/web performance screens.
 */
import { z } from 'zod';

/** `platform.setting` key (company scope) of the summary settings. */
export const SUMMARY_SETTINGS_KEY = 'performance.summary_email';

/** Send time as local "HH:MM" (24 hours) in the settings' time zone. */
const sendTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM, 24 hours');

const timeZone = z.string().refine(
  (zone) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Unknown time zone' },
);

export const summarySettingsSchema = z.strictObject({
  /** Who receives it. Empty = nobody (the summary is then not sent and says so on the screen). */
  recipients: z
    .array(z.email().max(254))
    .max(20)
    .refine((list) => new Set(list.map((e) => e.toLowerCase())).size === list.length, {
      message: 'Each address once',
    }),
  sendTime,
  timeZone,
  /** Off: the schedule sends nothing ("Send now" still works). */
  enabled: z.boolean(),
});
export type SummarySettings = z.infer<typeof summarySettingsSchema>;

/** The time of day and zone the owner chose (phase 4 plan): 07:00 in Qatar. */
export const DEFAULT_SUMMARY_SCHEDULE = { sendTime: '07:00', timeZone: 'Asia/Qatar' } as const;

/** What applies before a company saves its own settings: on, 07:00 Qatar, nobody listed. */
export const DEFAULT_SUMMARY_SETTINGS: SummarySettings = {
  recipients: [],
  ...DEFAULT_SUMMARY_SCHEDULE,
  enabled: true,
};

/** Why the "data incomplete" variant was sent. */
export const SUMMARY_INCOMPLETE_REASONS = ['no_run', 'failed', 'partial', 'no_figures'] as const;
export type SummaryIncompleteReason = (typeof SUMMARY_INCOMPLETE_REASONS)[number];

/** The words the incomplete notice uses for each reason (also shown on the settings screen). */
export const SUMMARY_REASON_TEXT: Record<SummaryIncompleteReason, string> = {
  no_run: 'No finished sync was found for this date.',
  failed: 'The last sync for this date failed.',
  partial: 'The last sync for this date was partial: some rows could not be read.',
  no_figures: 'The sync ran but the sheet has no figures for this date.',
};

export const summarySendNowSchema = z.strictObject({
  /** The date to summarise; default yesterday in the settings' time zone. */
  date: z.iso.date().optional(),
});
