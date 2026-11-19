/**
 * Document expiry engine (phase 3 row 3.4; SPEC 3.2 "Document expiry engine", PLAN 3.10
 * `expiry_alert_log`).
 *
 * Purpose: once a day, for every company that holds documents with an expiry date:
 *   - bring each document's stored status up to date (valid -> expiring -> expired), so lists
 *     and reports that read `status` are right without recomputing it;
 *   - find the alert windows that are due (rule in @fibrex/shared `dueExpiryWindows`:
 *     14 and 7 days before by default, no email on the day or after, expired = in-app only);
 *   - send ONE consolidated email per company and run to the company email list (setting
 *     `people.expiry_alerts`, edited by the admin), listing employee, document, expiry date
 *     and days left;
 *   - announce `people.documents_expiring` on the event outbox, so the notification rules
 *     raise in-app alerts for the roles an administrator chose (data, not code).
 * It also serves the read side for the API: the expiring list and the expiry calendar.
 *
 * Idempotency, and why it is built this way:
 *   1. Each company runs in its own unit of work. The alert log rows are inserted with
 *      ON CONFLICT DO NOTHING against the unique (document, window, expiry date) index, and
 *      only the rows this run actually inserted are alerted. A second run the same day, a
 *      retry or a second API instance therefore finds nothing new and sends nothing.
 *   2. The email is sent BEFORE the transaction commits. If sending fails the transaction
 *      rolls back (no log rows), the job reports the failure and BullMQ retries it, so an
 *      alert is never lost. The price is a possible duplicate email if the commit itself
 *      fails after a successful send, which is the better failure for an expiry warning.
 *   3. One company's failure does not stop the others; the run throws at the end so the
 *      scheduler retries, and the companies that succeeded are skipped by rule 1.
 *
 * Depends on: @fibrex/shared (expiry rule, settings schema, status rule), kernel/db,
 * kernel/events (outbox writer type), adapters/messaging (interface), modules/party
 * (PartyService.names), ./dates.ts. Used by: ./index.ts, ./expiry-router.ts, src/main.ts
 * (daily job), test/integration/people-expiry.test.ts.
 */
import {
  DEFAULT_EXPIRY_SETTINGS,
  deriveDocumentStatus,
  daysUntil,
  dueExpiryWindows,
  EXPIRED_WINDOW,
  EXPIRY_SETTINGS_KEY,
  expirySettingsSchema,
  type DocumentStatus,
  type ExpirySettings,
} from '@fibrex/shared';
import type { Prisma } from '../../generated/prisma/client.js';
import type { MessagingAdapter } from '../../adapters/messaging/interface.js';
import type { Db, PrismaDb } from '../../kernel/db/prisma.js';
import { currentUnit, type UnitOfWork } from '../../kernel/db/unit-of-work.js';
import type { EventOutbox } from '../../kernel/events/outbox.js';
import type { Logger } from '../../kernel/observability/logger.js';
import type { PartyService } from '../party/index.js';
import { fromDate, toDate } from './dates.js';

/** Event raised once per company and run when something new is expiring or expired. */
export const EXPIRY_EVENT = 'people.documents_expiring';

/** One document as the expiring list, the calendar and the email show it. */
export interface ExpiryItem {
  documentId: string;
  companyId: string;
  ownerType: string;
  ownerId: string;
  ownerName: string;
  employeeCode: string | null;
  documentTypeId: string | null;
  documentName: string;
  expiryDate: string;
  daysLeft: number;
  status: DocumentStatus;
}

export interface ExpiryRunResult {
  companies: number;
  statusChanges: number;
  alertsLogged: number;
  emailsSent: number;
  failedCompanies: number;
}

// ---------------------------------------------------------------------------------------
// Settings: a company row of platform.setting (key people.expiry_alerts).
// ---------------------------------------------------------------------------------------

export interface StoredExpirySettings extends ExpirySettings {
  /** null until the company saves its own settings (the defaults apply). */
  version: number | null;
}

/** The company's alert settings, or the defaults (14 and 7 days, no email list). */
export async function readExpirySettings(db: Db, companyId: string): Promise<StoredExpirySettings> {
  const row = await db.setting.findFirst({
    where: { scope: 'company', companyId, key: EXPIRY_SETTINGS_KEY, deletedAt: null },
    orderBy: { validFrom: 'desc' },
  });
  if (row === null) return { ...DEFAULT_EXPIRY_SETTINGS, version: null };
  const parsed = expirySettingsSchema.safeParse(row.value);
  // A row that no longer fits the schema (edited by hand) falls back to the defaults
  // rather than stopping every alert of the company.
  return parsed.success
    ? { ...parsed.data, version: row.version }
    : { ...DEFAULT_EXPIRY_SETTINGS, version: row.version };
}

/** Saves the company's alert settings (the audit trigger records the change). */
export async function writeExpirySettings(
  db: Db,
  companyId: string,
  settings: ExpirySettings,
): Promise<StoredExpirySettings> {
  const value = settings as unknown as Prisma.InputJsonValue;
  const current = await db.setting.findFirst({
    where: { scope: 'company', companyId, key: EXPIRY_SETTINGS_KEY, deletedAt: null },
    orderBy: { validFrom: 'desc' },
  });
  const row =
    current === null
      ? await db.setting.create({
          data: {
            tenantId: currentUnit().context.tenantId,
            companyId,
            scope: 'company',
            key: EXPIRY_SETTINGS_KEY,
            value,
          },
        })
      : await db.setting.update({ where: { id: current.id }, data: { value } });
  return { ...settings, version: row.version };
}

// ---------------------------------------------------------------------------------------
// Reading: documents with an expiry date, with owner and type names.
// ---------------------------------------------------------------------------------------

type DocWithType = Prisma.DocumentGetPayload<{ include: { documentType: true } }>;

/** The windows that apply to a document: its type's own, else the company default. */
function windowsFor(doc: DocWithType, settings: ExpirySettings): readonly number[] {
  const own = doc.documentType?.alertWindows ?? [];
  return own.length > 0 ? own : settings.windows;
}

export class ExpiryService {
  readonly #deps: ExpiryServiceDeps;

  constructor(deps: ExpiryServiceDeps) {
    this.#deps = deps;
  }

  /** Today as "YYYY-MM-DD" (UTC, like the rest of the people module). */
  today(): string {
    return (this.#deps.now?.() ?? new Date()).toISOString().slice(0, 10);
  }

  /**
   * Current documents with an expiry date in [from, to] (from = null: no lower bound, so
   * expired documents are included), ordered by expiry date. Runs in the open unit of work.
   */
  async list(options: {
    from: string | null;
    to: string;
    ownerType?: string;
    today?: string;
  }): Promise<ExpiryItem[]> {
    const { db } = currentUnit();
    const today = options.today ?? this.today();
    const docs = await db.document.findMany({
      where: {
        deletedAt: null,
        status: { not: 'replaced' },
        expiryDate: {
          not: null,
          lte: toDate(options.to),
          ...(options.from === null ? {} : { gte: toDate(options.from) }),
        },
        ...(options.ownerType === undefined ? {} : { ownerType: options.ownerType }),
      },
      include: { documentType: true },
      orderBy: [{ expiryDate: 'asc' }, { id: 'asc' }],
    });
    const settings = new Map<string, ExpirySettings>();
    for (const companyId of new Set(docs.map((d) => d.companyId))) {
      settings.set(companyId, await readExpirySettings(db, companyId));
    }
    return this.#describe(db, docs, today, (doc) =>
      windowsFor(doc, settings.get(doc.companyId) ?? DEFAULT_EXPIRY_SETTINGS),
    );
  }

  /** Adds owner names, employee codes and type names. */
  async #describe(
    db: Db,
    docs: DocWithType[],
    today: string,
    windows: (doc: DocWithType) => readonly number[],
  ): Promise<ExpiryItem[]> {
    const partyIds = docs.filter((d) => d.ownerType === 'party').map((d) => d.ownerId);
    const names = await this.#deps.parties.names(partyIds);
    const employees = await db.employee.findMany({
      where: { partyId: { in: partyIds }, deletedAt: null },
      select: { partyId: true, employeeCode: true },
    });
    const codes = new Map(employees.map((e) => [e.partyId, e.employeeCode]));
    const companyIds = docs.filter((d) => d.ownerType === 'company').map((d) => d.ownerId);
    const companies = await db.company.findMany({
      where: { id: { in: companyIds } },
      select: { id: true, legalName: true, tradeName: true },
    });
    const companyNames = new Map(companies.map((c) => [c.id, c.tradeName ?? c.legalName]));

    return docs.map((doc) => {
      const expiryDate = fromDate(doc.expiryDate) ?? today;
      const ownerName =
        doc.ownerType === 'party'
          ? (names.get(doc.ownerId) ?? 'Unknown person')
          : doc.ownerType === 'company'
            ? (companyNames.get(doc.ownerId) ?? 'Company')
            : 'Vehicle';
      const typeName = doc.documentType?.name as Record<string, string> | undefined;
      return {
        documentId: doc.id,
        companyId: doc.companyId,
        ownerType: doc.ownerType,
        ownerId: doc.ownerId,
        ownerName,
        employeeCode: doc.ownerType === 'party' ? (codes.get(doc.ownerId) ?? null) : null,
        documentTypeId: doc.documentTypeId,
        documentName: typeName?.en ?? doc.customName ?? 'Document',
        expiryDate,
        daysLeft: daysUntil(expiryDate, today),
        status: deriveDocumentStatus({
          expiryDate,
          today,
          alertWindows: windows(doc),
          replaced: false,
        }),
      };
    });
  }

  // -------------------------------------------------------------------------------------
  // The daily job.
  // -------------------------------------------------------------------------------------

  /** Runs every company; throws at the end if any company failed (the scheduler retries). */
  async run(): Promise<ExpiryRunResult> {
    const { uow, job } = this.#deps;
    if (job === undefined) throw new Error('Document expiry: the job dependencies are missing');
    const { prisma, logger } = job;
    const today = this.today();
    const pairs = await prisma.$queryRaw<{ tenant_id: string; company_id: string }[]>`
      SELECT tenant_id::text AS tenant_id, company_id::text AS company_id
        FROM people.expiry_companies()`;
    const result: ExpiryRunResult = {
      companies: pairs.length,
      statusChanges: 0,
      alertsLogged: 0,
      emailsSent: 0,
      failedCompanies: 0,
    };
    for (const pair of pairs) {
      try {
        const done = await uow.runAs(
          { tenantId: pair.tenant_id, companyIds: [pair.company_id] },
          () => this.#runCompany(job, pair.company_id, today),
        );
        result.statusChanges += done.statusChanges;
        result.alertsLogged += done.alertsLogged;
        result.emailsSent += done.emailsSent;
      } catch (err) {
        result.failedCompanies += 1;
        logger.error(
          { err, tenantId: pair.tenant_id, companyId: pair.company_id },
          'document expiry run failed',
        );
      }
    }
    if (result.failedCompanies > 0) {
      throw new Error(`Document expiry: ${String(result.failedCompanies)} company run(s) failed`);
    }
    return result;
  }

  async #runCompany(
    job: ExpiryJobDeps,
    companyId: string,
    today: string,
  ): Promise<{ statusChanges: number; alertsLogged: number; emailsSent: number }> {
    const { db, context } = currentUnit();
    const settings = await readExpirySettings(db, companyId);
    const docs = await db.document.findMany({
      where: { companyId, deletedAt: null, status: { not: 'replaced' }, expiryDate: { not: null } },
      include: { documentType: true },
      orderBy: [{ expiryDate: 'asc' }, { id: 'asc' }],
    });
    const logs = await db.expiryAlertLog.findMany({
      where: { companyId, documentId: { in: docs.map((d) => d.id) } },
      select: { documentId: true, windowDays: true, expiryDate: true },
    });

    // Step 1: status refresh, and which windows are due per document.
    let statusChanges = 0;
    const due: { doc: DocWithType; expiry: string; windows: number[] }[] = [];
    for (const doc of docs) {
      const expiry = fromDate(doc.expiryDate) ?? today;
      const windows = windowsFor(doc, settings);
      const status = deriveDocumentStatus({
        expiryDate: expiry,
        today,
        alertWindows: windows,
        replaced: false,
      });
      if (status !== doc.status) {
        // The row trigger bumps the version and the audit trigger records the change.
        await db.document.update({ where: { id: doc.id }, data: { status } });
        statusChanges += 1;
      }
      // Only log rows for the CURRENT expiry date count: a corrected date alerts again.
      const alerted = logs
        .filter((l) => l.documentId === doc.id && fromDate(l.expiryDate) === expiry)
        .map((l) => l.windowDays);
      const windowsDue = dueExpiryWindows({ daysLeft: daysUntil(expiry, today), windows, alerted });
      if (windowsDue.length > 0) due.push({ doc, expiry, windows: windowsDue });
    }
    if (due.length === 0) return { statusChanges, alertsLogged: 0, emailsSent: 0 };

    // Step 2: claim the alerts. Only rows inserted now are alerted (idempotency rule 1).
    const willEmail = settings.emails.length > 0;
    const rows = due.flatMap((d) => d.windows.map((w) => ({ id: d.doc.id, w, e: d.expiry })));
    const inserted = await db.$queryRaw<{ document_id: string; window_days: number }[]>`
      INSERT INTO people.expiry_alert_log
        (tenant_id, company_id, document_id, window_days, expiry_date, alerted_on, channels)
      SELECT ${context.tenantId}::uuid, ${companyId}::uuid, t.d, t.w, t.e, ${today}::date,
             CASE WHEN t.w = ${EXPIRED_WINDOW}::int OR NOT ${willEmail}::boolean
                  THEN ARRAY['in_app']::text[] ELSE ARRAY['email', 'in_app']::text[] END
        FROM unnest(${rows.map((r) => r.id)}::uuid[], ${rows.map((r) => r.w)}::int[],
                    ${rows.map((r) => r.e)}::date[]) AS t(d, w, e)
      ON CONFLICT (document_id, window_days, expiry_date) DO NOTHING
      RETURNING document_id::text AS document_id, window_days`;
    if (inserted.length === 0) return { statusChanges, alertsLogged: 0, emailsSent: 0 };

    // Step 3: what to tell. A document is listed once even when two windows came due.
    const expiredIds = new Set(
      inserted.filter((r) => r.window_days === EXPIRED_WINDOW).map((r) => r.document_id),
    );
    const expiringIds = new Set(
      inserted.filter((r) => r.window_days !== EXPIRED_WINDOW).map((r) => r.document_id),
    );
    const items = await this.#describe(
      db,
      due.map((d) => d.doc).filter((d) => expiredIds.has(d.id) || expiringIds.has(d.id)),
      today,
      (doc) => windowsFor(doc, settings),
    );
    const expiring = items.filter((i) => expiringIds.has(i.documentId));
    const expired = items.filter((i) => expiredIds.has(i.documentId));

    // Step 4: in-app alerts through the outbox; the notification rules pick the roles.
    await job.outbox.record({
      eventType: EXPIRY_EVENT,
      companyId,
      aggregateType: 'people.document',
      payload: {
        date: today,
        expiringCount: expiring.length,
        expiredCount: expired.length,
        // Names and dates only: never document numbers (webhooks receive this payload).
        expiring: expiring.map(eventLine),
        expired: expired.map(eventLine),
      },
    });

    // Step 5: one consolidated email to the list, before the commit (idempotency rule 2).
    let emailsSent = 0;
    if (willEmail && expiring.length > 0) {
      const company = await db.company.findFirst({
        where: { id: companyId },
        select: { legalName: true, tradeName: true },
      });
      const companyName = company?.tradeName ?? company?.legalName ?? '';
      const message = consolidatedEmail(companyName, today, expiring);
      for (const to of settings.emails) {
        await job.messaging.send({ channel: 'email', to, purpose: 'notification', ...message });
        emailsSent += 1;
      }
    }
    return { statusChanges, alertsLogged: inserted.length, emailsSent };
  }
}

/** What the daily job needs beyond the read side (src/main.ts and the job test pass it). */
export interface ExpiryJobDeps {
  /** Client for the SECURITY DEFINER company list. */
  prisma: PrismaDb;
  messaging: MessagingAdapter;
  outbox: Pick<EventOutbox, 'record'>;
  logger: Logger;
}

export interface ExpiryServiceDeps {
  uow: UnitOfWork;
  parties: Pick<PartyService, 'names'>;
  /** Absent where only the lists are served; `run` then refuses. */
  job?: ExpiryJobDeps;
  /** Fixed clock for tests. */
  now?: () => Date;
}

const eventLine = (i: ExpiryItem) => ({
  documentId: i.documentId,
  owner: i.employeeCode === null ? i.ownerName : `${i.employeeCode} ${i.ownerName}`,
  document: i.documentName,
  expiryDate: i.expiryDate,
  daysLeft: i.daysLeft,
});

/** The plain-text table SPEC 3.2 asks for: employee, document, expiry date, days left. */
export function consolidatedEmail(
  companyName: string,
  today: string,
  items: readonly ExpiryItem[],
): { subject: string; text: string } {
  const header = ['Employee', 'Document', 'Expiry date', 'Days left'];
  const body = items.map((i) => [
    i.employeeCode === null ? i.ownerName : `${i.employeeCode} ${i.ownerName}`,
    i.documentName,
    i.expiryDate,
    String(i.daysLeft),
  ]);
  const widths = header.map((h, col) =>
    Math.max(h.length, ...body.map((r) => r[col]?.length ?? 0)),
  );
  const line = (cells: string[]) => cells.map((c, col) => c.padEnd(widths[col] ?? 0)).join('  ');
  const subject = `Documents expiring soon: ${String(items.length)}${companyName === '' ? '' : ` (${companyName})`}`;
  const text = [
    `Documents expiring soon${companyName === '' ? '' : ` at ${companyName}`}, as of ${today}.`,
    '',
    line(header),
    line(widths.map((w) => '-'.repeat(w))),
    ...body.map(line),
    '',
    'Open Fibrex to renew them. This list is sent at the alert windows set in the expiry settings.',
  ].join('\n');
  return { subject, text };
}
