/**
 * Daily performance summary email (phase 4 row 4.6b).
 *
 * Purpose: once a day, for every company with an active client platform, send ONE email to
 * the addresses in the company setting `performance.summary_email` ("Performance summary
 * recipients", seeded with the owner address). The email carries yesterday's figures: people
 * with orders, total orders, total active hours, the 5 best and 5 weakest by orders, people
 * with zero orders and how many platform IDs are still unmatched. When the day's data cannot be
 * trusted (no finished sync, failed, partial, or no figures for the date) a clear "data
 * incomplete" email is sent instead, never half-figures.
 *
 * The text comes from two email templates (`performance.daily_summary` and
 * `performance.daily_summary_incomplete`, English, tenant data an admin can edit on the
 * Templates screen), rendered as plain text and handed to the messaging adapter.
 *
 * Schedule: the job ticks every few minutes and sends when the local clock in the company's
 * time zone has passed the send time (default 07:00 Asia/Qatar) and nothing was sent for the
 * date yet. A time or zone change is therefore just data; no scheduler to rewrite.
 *
 * Idempotency, and why it is built this way:
 *   1. The sent log (`performance.summary_log`) has a unique index on (company, date). The
 *      sender CLAIMS the date with INSERT ... ON CONFLICT DO NOTHING before it sends; if no
 *      row came back, someone else has it (a second tick, a second API instance, "Send now"
 *      after the schedule) and nothing is sent. Two senders racing block on the index until
 *      the first commits, then see the conflict.
 *   2. The emails go out BEFORE the transaction commits. If sending fails the claim rolls
 *      back, nothing is logged and the next tick tries again, so a summary is never lost. The
 *      price is a possible duplicate if the commit itself fails after a successful send.
 *   3. No recipients: nothing is claimed or sent, so adding an address later still sends it.
 *
 * Which sync counts: the last try of the first run of the platform read on the day after the
 * summary date or later (the 04:00 run reads "today"; the sheet holds complete figures up to
 * the day before). Only a succeeded run with figures for the date gives the full summary.
 *
 * Depends on: @fibrex/shared (settings, reasons), kernel/db, kernel/templates (resolve and
 * render), adapters/messaging, ./performance-reports.ts (loadFigures), ./summary-calc.ts.
 * Used by: ./summary-router.ts, ./index.ts, src/main.ts (the job), ./summary-seed.ts.
 */
import {
  DEFAULT_SUMMARY_SETTINGS,
  SUMMARY_REASON_TEXT,
  SUMMARY_SETTINGS_KEY,
  summarySettingsSchema,
  type SummaryIncompleteReason,
  type SummarySettings,
} from '@fibrex/shared';
import type { Prisma } from '../../generated/prisma/client.js';
import type { MessagingAdapter } from '../../adapters/messaging/interface.js';
import type { Db, PrismaDb } from '../../kernel/db/prisma.js';
import { currentUnit, type UnitOfWork } from '../../kernel/db/unit-of-work.js';
import { UnprocessableError } from '../../kernel/http/errors.js';
import type { Logger } from '../../kernel/observability/logger.js';
import { renderText } from '../../kernel/templates/template-render.js';
import type { TemplateService } from '../../kernel/templates/template-service.js';
import { addDays } from './cycle.js';
import { isDayOffOn } from './day-off.js';
import { loadFigures, type ReportScope } from './performance-reports.js';
import { dueSummaryDate, localClock, summariseDay, type SummaryPerson } from './summary-calc.js';

export const SUMMARY_TEMPLATE_KEY = 'performance.daily_summary';
export const SUMMARY_INCOMPLETE_TEMPLATE_KEY = 'performance.daily_summary_incomplete';

export type SummaryTrigger = 'scheduled' | 'manual';

export type SummaryResult =
  | {
      status: 'sent';
      date: string;
      variant: 'full' | 'incomplete';
      reason: SummaryIncompleteReason | null;
      recipients: number;
    }
  | { status: 'already_sent'; date: string }
  | { status: 'no_recipients'; date: string };

export interface SummaryRunResult {
  companies: number;
  sent: number;
  skipped: number;
  failedCompanies: number;
}

export interface StoredSummarySettings extends SummarySettings {
  /** null until the company saves its own settings (the defaults apply). */
  version: number | null;
}

/** The company's summary settings, or the defaults (on, 07:00 Asia/Qatar, nobody listed). */
export async function readSummarySettings(
  db: Db,
  companyId: string,
): Promise<StoredSummarySettings> {
  const row = await db.setting.findFirst({
    where: { scope: 'company', companyId, key: SUMMARY_SETTINGS_KEY, deletedAt: null },
    orderBy: { validFrom: 'desc' },
  });
  if (row === null) return { ...DEFAULT_SUMMARY_SETTINGS, version: null };
  const parsed = summarySettingsSchema.safeParse(row.value);
  // A row edited by hand that no longer fits the schema falls back to the defaults.
  return parsed.success
    ? { ...parsed.data, version: row.version }
    : { ...DEFAULT_SUMMARY_SETTINGS, version: row.version };
}

/** Saves the company's summary settings (the audit trigger records the change). */
export async function writeSummarySettings(
  db: Db,
  companyId: string,
  settings: SummarySettings,
): Promise<StoredSummarySettings> {
  const value = settings as unknown as Prisma.InputJsonValue;
  const current = await db.setting.findFirst({
    where: { scope: 'company', companyId, key: SUMMARY_SETTINGS_KEY, deletedAt: null },
    orderBy: { validFrom: 'desc' },
  });
  const row =
    current === null
      ? await db.setting.create({
          data: {
            tenantId: currentUnit().context.tenantId,
            companyId,
            scope: 'company',
            key: SUMMARY_SETTINGS_KEY,
            value,
          },
        })
      : await db.setting.update({ where: { id: current.id }, data: { value } });
  return { ...settings, version: row.version };
}

export interface SummaryServiceDeps {
  uow: UnitOfWork;
  templates: Pick<TemplateService, 'resolve'>;
  messaging: MessagingAdapter;
  logger: Logger;
  /** Client for the SECURITY DEFINER company list; absent where only the routes are served. */
  prisma?: PrismaDb;
  /** Fixed clock for tests. */
  now?: () => Date;
}

const toDay = (text: string) => new Date(`${text}T00:00:00.000Z`);

/** What the day's data allows: the full summary, or why it is incomplete. */
type Composed =
  | { variant: 'full'; reason: null; data: Record<string, unknown> }
  | { variant: 'incomplete'; reason: SummaryIncompleteReason; data: Record<string, unknown> };

export class SummaryService {
  readonly #deps: SummaryServiceDeps;

  constructor(deps: SummaryServiceDeps) {
    this.#deps = deps;
  }

  now(): Date {
    return this.#deps.now?.() ?? new Date();
  }

  /** Newest log rows of the company, for the settings screen. Runs in the open unit. */
  async recent(db: Db, companyId: string, take = 10) {
    const rows = await db.summaryLog.findMany({
      where: { companyId },
      orderBy: [{ summaryDate: 'desc' }],
      take,
    });
    return rows.map((r) => ({
      date: r.summaryDate.toISOString().slice(0, 10),
      variant: r.variant as 'full' | 'incomplete',
      reason: r.reason as SummaryIncompleteReason | null,
      trigger: r.trigger as SummaryTrigger,
      recipients: r.recipients.length,
      sentAt: r.sentAt.toISOString(),
    }));
  }

  /** Yesterday in the settings' time zone: the default date of "Send now". */
  defaultDate(settings: SummarySettings): string {
    return addDays(localClock(settings.timeZone, this.now()).date, -1);
  }

  /**
   * Builds and sends the summary of one date for one company, in the OPEN unit of work (the
   * caller opened it for this company). Returns what happened; throws if sending fails, which
   * rolls the claim back (idempotency rule 2).
   */
  async sendFor(companyId: string, date: string, trigger: SummaryTrigger): Promise<SummaryResult> {
    const { db, context } = currentUnit();
    const settings = await readSummarySettings(db, companyId);
    // Idempotency rule 3.
    if (settings.recipients.length === 0) return { status: 'no_recipients', date };
    const done = await db.summaryLog.findFirst({ where: { companyId, summaryDate: toDay(date) } });
    if (done !== null) return { status: 'already_sent', date };

    const composed = await this.#compose(db, companyId, date);

    // Idempotency rule 1: claim the date before sending.
    const claimed = await db.$queryRaw<{ id: string }[]>`
      INSERT INTO performance.summary_log
        (tenant_id, company_id, summary_date, variant, reason, trigger, recipients)
      VALUES (${context.tenantId}::uuid, ${companyId}::uuid, ${date}::date, ${composed.variant},
              ${composed.reason}, ${trigger}, ${settings.recipients}::text[])
      ON CONFLICT (company_id, summary_date) DO NOTHING
      RETURNING id::text AS id`;
    if (claimed.length === 0) return { status: 'already_sent', date };

    const key =
      composed.variant === 'full' ? SUMMARY_TEMPLATE_KEY : SUMMARY_INCOMPLETE_TEMPLATE_KEY;
    const { version } = await this.#deps.templates.resolve(key, { language: 'en', companyId });
    // Plain text: the messaging adapter sends text, so nothing is HTML-escaped.
    const subject = renderText(version.subject ?? 'Performance summary', composed.data, false);
    const text = renderText(version.body, composed.data, false);
    // Idempotency rule 2: send before the commit.
    for (const to of settings.recipients) {
      await this.#deps.messaging.send({
        channel: 'email',
        to,
        purpose: 'notification',
        subject,
        text,
      });
    }
    return {
      status: 'sent',
      date,
      variant: composed.variant,
      reason: composed.reason,
      recipients: settings.recipients.length,
    };
  }

  /** Reads the day and decides full or incomplete. */
  async #compose(db: Db, companyId: string, date: string): Promise<Composed> {
    const company = await db.company.findFirst({
      where: { id: companyId },
      select: { legalName: true, tradeName: true },
    });
    const platform = await db.clientPlatform.findFirst({
      where: { companyId, deletedAt: null, status: 'active' },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    if (platform === null) {
      throw new UnprocessableError('no_platform', 'There is no active client platform yet.');
    }
    const unmatched = await db.unmatchedIdentifier.count({
      where: { companyId, clientPlatformId: platform.id, status: 'open', deletedAt: null },
    });
    const base = {
      companyName: company?.tradeName ?? company?.legalName ?? '',
      platformName: platform.name,
      date,
      unmatched,
    };

    // Which sync counts: see the file header.
    const run = await db.syncRun.findFirst({
      where: {
        companyId,
        deletedAt: null,
        businessDate: { gte: toDay(addDays(date, 1)) },
        syncSource: { clientPlatformId: platform.id },
      },
      // The first day that read the date, and that day's last try.
      orderBy: [{ businessDate: 'asc' }, { startedAt: 'desc' }],
      select: { status: true },
    });
    const incomplete = (reason: SummaryIncompleteReason): Composed => ({
      variant: 'incomplete',
      reason,
      data: { ...base, reason: SUMMARY_REASON_TEXT[reason], runStatus: run?.status ?? 'none' },
    });
    if (run === null) return incomplete('no_run');
    if (run.status === 'failed') return incomplete('failed');
    if (run.status === 'partial') return incomplete('partial');
    if (run.status !== 'succeeded') return incomplete('no_run');

    const scope: ReportScope = {
      platformId: platform.id,
      platformName: platform.name,
      companyId,
      from: date,
      to: date,
      cycle: null,
    };
    const loaded = await loadFigures(db, scope);
    // A date nobody has figures for is a reset or a missed day, never a day of zeros.
    if (loaded.reportedDates.length === 0) return incomplete('no_figures');
    const byParty = new Map(loaded.figures.map((f) => [f.partyId, f]));
    const people: SummaryPerson[] = [...loaded.people].map(([partyId, person]) => ({
      name: person.name,
      orders: byParty.get(partyId)?.orders ?? 0,
      workingMinutes: byParty.get(partyId)?.workingMinutes ?? 0,
      // Row 4.8d: the summarised date is `date`, so day off is checked against that date.
      dayOff: isDayOffOn(loaded.dayOffTexts.get(partyId) ?? null, date),
    }));
    const day = summariseDay(people);
    return { variant: 'full', reason: null, data: { ...base, ...day } };
  }

  // -------------------------------------------------------------------------------------
  // The scheduled job.
  // -------------------------------------------------------------------------------------

  /** One tick: sends what is due. Throws at the end if any company failed (it is logged). */
  async runDue(): Promise<SummaryRunResult> {
    const { uow, prisma, logger } = this.#deps;
    if (prisma === undefined) throw new Error('Performance summary: the job client is missing');
    const pairs = await prisma.$queryRaw<{ tenant_id: string; company_id: string }[]>`
      SELECT tenant_id::text AS tenant_id, company_id::text AS company_id
        FROM performance.summary_companies()`;
    const result: SummaryRunResult = {
      companies: pairs.length,
      sent: 0,
      skipped: 0,
      failedCompanies: 0,
    };
    for (const pair of pairs) {
      try {
        const done = await uow.runAs(
          { tenantId: pair.tenant_id, companyIds: [pair.company_id] },
          async () => {
            const { db } = currentUnit();
            const settings = await readSummarySettings(db, pair.company_id);
            if (!settings.enabled) return null;
            const date = dueSummaryDate(settings.sendTime, settings.timeZone, this.now());
            if (date === null) return null;
            return this.sendFor(pair.company_id, date, 'scheduled');
          },
        );
        if (done?.status === 'sent') result.sent += 1;
        else result.skipped += 1;
      } catch (err) {
        result.failedCompanies += 1;
        logger.error(
          { err, tenantId: pair.tenant_id, companyId: pair.company_id },
          'performance summary failed',
        );
      }
    }
    if (result.failedCompanies > 0) {
      throw new Error(
        `Performance summary: ${String(result.failedCompanies)} company run(s) failed`,
      );
    }
    return result;
  }
}
