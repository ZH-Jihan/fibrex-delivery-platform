/**
 * Sync engine (phase 4 row 4.3; PLAN 3.11 and 5.13, phase 4 plan sections 2, 4, 5 and 9).
 *
 * Purpose: one sync run reads a platform's daily report, keeps it as a raw snapshot, and
 * stores the dated per-person figures in `performance.daily_performance`. Every trigger
 * goes through `run()`: the 04:00 scheduled job, "Run now", "Re-import range" and an
 * uploaded day's Excel file. The queue (./sync-queue.ts) calls it in the background as the
 * person who asked (or as the system for the scheduled job).
 *
 * The steps of one run, and why:
 *   1. Open the run (own transaction) so a run that fails later is still in the run log.
 *   2. Read the grid, outside any transaction (a sheet read can be slow). The scheduled and
 *      manual runs read through the source provider of the source's adapter kind
 *      (./source-providers.ts); an upload reads the uploaded .xlsx. A source that cannot be
 *      read fails the run; the queue retries it, and admins are alerted after the last try.
 *   3. In ONE transaction, with a per-source advisory lock so two runs of the same source
 *      never interleave:
 *      a. Keep the raw snapshot (`files.raw_input`) BEFORE anything is parsed, so even a
 *         sheet whose layout changed is kept. The same bytes for the same source and date
 *         are stored once; later runs point at the earlier snapshot (`snapshot_reused`).
 *      b. Refuse an empty sheet and a changed layout (run failed, `layout_changed`, alert).
 *      c. A reset sheet (people listed, every day block zero) stores nothing: the figures
 *         already stored are real and a reset must never replace them (DECISIONS 4.1).
 *      d. Otherwise store EVERY filled day block the sheet holds, not only yesterday's, so
 *         a missed morning is caught up by the next run. A re-import keeps only the dates of
 *         its range.
 *      e. Match the sheet's Public ID (the Falcon ID) to the party identifier of the
 *         platform's identifier type, as held on each date. Unmatched IDs are still stored
 *         (party_id NULL) and listed in `performance.unmatched_identifier`.
 *      f. Idempotent per date: when the figures (and the matched person) of a person-date
 *         equal the current row, nothing is written. When they differ, the current row is
 *         retired (`is_current` false, the only change the table allows) and a new row is
 *         inserted, so the history of every re-import is kept.
 *      g. Finish the run (counts, status), mark earlier runs of the same source and date as
 *         superseded, and raise an alert event for admins when something went wrong.
 *
 * What counts as "the figures" of a person-date: the day block values (orders, working
 * minutes, late minutes and every block metric) and the matched person. The fixed columns
 * (zone, schedule, pending amount ...) are kept on the row under `metrics._fields` as read
 * when the row was written, but are not compared: Pending Amount changes every day and would
 * otherwise rewrite every past date each morning. The raw snapshot keeps every reading.
 *
 * Depends on: @fibrex/shared (mapping), kernel/db, kernel/context, kernel/crypto, kernel/events
 * (outbox), adapters/storage, modules/party (PartyService.identifierHolders, via its index),
 * ./report-adapter.ts, ./snoonu-parser.ts, ./source-providers.ts. Used by: ./sync-queue.ts,
 * ./sync-router.ts, ./index.ts, test/integration/performance-sync.test.ts.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  SNOONU_DEFAULT_MAPPING,
  sheetColumnMappingSchema,
  type SheetColumnMapping,
} from '@fibrex/shared';
import type { StorageAdapter } from '../../adapters/storage/interface.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { runWithContext, type RequestContext } from '../../kernel/context/request-context.js';
import type { SecretBox } from '../../kernel/crypto/secret-box.js';
import type { Db } from '../../kernel/db/prisma.js';
import { currentUnit, type DbContext, type UnitOfWork } from '../../kernel/db/unit-of-work.js';
import type { EventOutbox } from '../../kernel/events/outbox.js';
import { NotFoundError, UnprocessableError } from '../../kernel/http/errors.js';
import type { Logger } from '../../kernel/observability/logger.js';
import { normaliseSecretValue, type PartyService } from '../party/index.js';
import { addDays } from './cycle.js';
import {
  excelFileSource,
  ReportSourceError,
  type ClientReportAdapter,
  type ParsedDay,
  type ParsedReport,
  type ReportSource,
  type SheetGrid,
} from './report-adapter.js';
import { snoonuReportAdapter } from './snoonu-parser.js';
import type { ReportSourceProviders } from './source-providers.js';

/** Event raised when a run could not use the report (read by the seeded admin rule). */
export const SYNC_PROBLEM_EVENT = 'performance.sync_problem';

/** SecretBox context of `sync_source.config_encrypted`. */
export const SYNC_SOURCE_SECRET_CONTEXT = 'performance.sync_source';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export type SyncTrigger = 'scheduled' | 'manual' | 'reimport' | 'upload';
export type SyncStatus = 'succeeded' | 'partial' | 'failed';

/** Why a run could not use the report; each one alerts admins. */
export type SyncProblem =
  'source_unreachable' | 'source_not_configured' | 'source_empty' | 'layout_changed';

export interface SyncRequest {
  syncSourceId: string;
  trigger: SyncTrigger;
  /**
   * The date the report is read on, "YYYY-MM-DD" (an upload: the day the file was
   * downloaded). Default: today in the source's time zone. The report holds complete figures
   * up to the day before.
   */
  readOn?: string;
  /** Re-import: only these dates are stored. */
  range?: { from: string; to: string };
  /** Upload: the uploaded .xlsx file (`files.file_object`). */
  fileObjectId?: string;
}

/** Which try this is; admins are alerted about an unreachable source only on the last. */
export interface SyncAttempt {
  attempt: number;
  maxAttempts: number;
}

export interface SyncOutcome {
  runId: string;
  status: SyncStatus;
  problem: SyncProblem | null;
  /** Person-dates written as a new current row. */
  stored: number;
  /** Person-dates whose figures equalled the current row (nothing written). */
  unchanged: number;
  /** Earlier current rows retired by this run. */
  retired: number;
  matched: number;
  unmatched: number;
  errors: number;
  resetDetected: boolean;
  /** True when admins were alerted. */
  alerted: boolean;
}

/** Thrown for a failure worth trying again (the queue retries the job). */
export class SyncRetryableError extends Error {
  readonly outcome: SyncOutcome;

  constructor(message: string, outcome: SyncOutcome) {
    super(message);
    this.name = 'SyncRetryableError';
    this.outcome = outcome;
  }
}

/** Adapters by platform code (`client_platform.code`). */
const ADAPTERS: ReadonlyMap<string, ClientReportAdapter> = new Map([
  [snoonuReportAdapter.platformCode, snoonuReportAdapter],
]);

/** The mapping used until an administrator saves a `column_mapping` for the source. */
const DEFAULT_MAPPINGS: ReadonlyMap<string, SheetColumnMapping> = new Map([
  ['snoonu', SNOONU_DEFAULT_MAPPING],
]);

/** The platform's standard mapping (used while a source has no saved column mapping). */
export function defaultMappingFor(platformCode: string): SheetColumnMapping {
  return DEFAULT_MAPPINGS.get(platformCode) ?? SNOONU_DEFAULT_MAPPING;
}

/**
 * The party identifier type the platform's sheet id is (DECISIONS 4.1: Snoonu Public ID =
 * Falcon ID). Other platforms follow the `<code>_id` identifier types (talabat_id ...).
 */
export function identifierTypeFor(platformCode: string): string {
  return platformCode === 'snoonu' ? 'falcon_id' : `${platformCode}_id`;
}

/** The calendar date at `at` in a time zone, "YYYY-MM-DD" (Asia/Qatar for Snoonu). */
export function dateInZone(timeZone: string, at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

const toDay = (text: string) => new Date(`${text}T00:00:00.000Z`);
const fromDay = (value: Date) => value.toISOString().slice(0, 10);

/** JSON with sorted keys, so two equal figure sets compare equal as text. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}

/** The compared part of a stored row's metrics (reserved `_` keys are not figures). */
function blockFigures(metrics: unknown): Record<string, unknown> {
  if (metrics === null || typeof metrics !== 'object' || Array.isArray(metrics)) return {};
  return Object.fromEntries(
    Object.entries(metrics as Record<string, unknown>).filter(([k]) => !k.startsWith('_')),
  );
}

/** The snapshot of a read grid: dates tagged so a later re-parse gets dates back. */
function serialiseGrid(grid: SheetGrid): Buffer {
  const rows = grid.rows.map((row) =>
    row.map((cell) => (cell instanceof Date ? { $date: cell.toISOString() } : cell)),
  );
  return Buffer.from(JSON.stringify({ tab: grid.tab, rows }), 'utf8');
}

/** True when no cell from the first data row on holds anything. */
function gridIsEmpty(grid: SheetGrid, firstDataRow: number): boolean {
  return grid.rows
    .slice(firstDataRow - 1)
    .every((row) => row.every((c) => c === null || (typeof c === 'string' && c.trim() === '')));
}

interface RunSetup {
  runId: string;
  syncSourceId: string;
  companyId: string;
  sourceName: string;
  adapterKind: string;
  platformId: string;
  platformCode: string;
  cycleStartDay: number;
  readOn: string;
  mapping: SheetColumnMapping;
  config: Record<string, unknown> | null;
  upload: { fileObjectId: string; objectKey: string; sha256: string; name: string } | null;
}

interface ReadProblem {
  problem: SyncProblem;
  code: string;
  message: string;
  retryable: boolean;
}

export interface SyncServiceDeps {
  uow: UnitOfWork;
  storage: StorageAdapter;
  parties: Pick<PartyService, 'identifierHolders'>;
  providers: ReportSourceProviders;
  outbox: Pick<EventOutbox, 'record'>;
  box: SecretBox;
  logger: Logger;
  now?: () => Date;
}

export class SyncService {
  readonly #deps: SyncServiceDeps;

  constructor(deps: SyncServiceDeps) {
    this.#deps = deps;
  }

  /**
   * Checks a request before it is queued (inside the caller's unit of work), so "Run now"
   * on a deleted source or an upload of a missing file fails at once with a clear error.
   */
  async validateRequest(request: SyncRequest): Promise<void> {
    const { db } = currentUnit();
    const source = await db.syncSource.findFirst({
      where: { id: request.syncSourceId, deletedAt: null },
      select: { adapterKind: true, active: true, companyId: true },
    });
    if (source === null) throw new NotFoundError();
    if (!source.active) {
      throw new UnprocessableError('source_inactive', 'This sync source is switched off.');
    }
    if (request.trigger === 'upload') {
      const file = await db.fileObject.findFirst({
        where: { id: request.fileObjectId ?? '', companyId: source.companyId },
        select: { mimeType: true },
      });
      if (file === null) {
        throw new UnprocessableError('unknown_file', 'This file does not exist.');
      }
      if (file.mimeType !== XLSX_MIME) {
        throw new UnprocessableError('not_xlsx', 'Upload the report as an Excel (.xlsx) file.');
      }
    } else if (source.adapterKind === 'excel') {
      throw new UnprocessableError(
        'upload_only',
        "This source is read from uploaded files only: upload the day's Excel file.",
      );
    }
  }

  /**
   * One run. The job runs outside any HTTP request, so the run happens inside a request
   * context rebuilt from the job (same person, tenant and company as the request that
   * queued it, or no person for the scheduled job), exactly as the import commit does
   * (row 3.14): audit rows then name that person.
   */
  async run(context: DbContext, request: SyncRequest, attempt: SyncAttempt): Promise<SyncOutcome> {
    const requestContext: RequestContext = {
      requestId: `sync-${randomUUID()}`,
      startedAt: Date.now(),
      ip: context.ip,
      principal:
        context.userId === undefined
          ? undefined
          : { kind: 'user', userId: context.userId, tenantId: context.tenantId },
      companyIds: context.companyIds,
      ...(context.roleKeys === undefined ? {} : { roleKeys: context.roleKeys }),
    };
    return runWithContext(requestContext, () => this.#run(context, request, attempt));
  }

  async #run(context: DbContext, request: SyncRequest, attempt: SyncAttempt): Promise<SyncOutcome> {
    const { uow } = this.#deps;
    // Step 1: open the run in its own transaction.
    const setup = await uow.runAs(context, () => this.#openRun(request));

    // Step 2: read the grid (no transaction open).
    let grid: SheetGrid | undefined;
    let snapshot: Buffer | undefined;
    let readProblem: ReadProblem | undefined;
    try {
      const read = await this.#read(setup, context);
      grid = read.grid;
      snapshot = read.snapshot;
    } catch (err) {
      readProblem = readProblemOf(err, setup);
    }

    if (readProblem !== undefined || grid === undefined || snapshot === undefined) {
      const problem = readProblem ?? {
        problem: 'source_unreachable' as const,
        code: 'source_unreachable',
        message: 'The report could not be read.',
        retryable: true,
      };
      // Alert on the last try only: an earlier failure is retried by the queue.
      const last = !problem.retryable || attempt.attempt >= attempt.maxAttempts;
      const outcome = await uow.runAs(context, () =>
        this.#failRun(setup, problem.problem, [{ code: problem.code, message: problem.message }], {
          alert: last,
          layoutChanged: false,
        }),
      );
      if (problem.retryable) throw new SyncRetryableError(problem.message, outcome);
      return outcome;
    }

    // Step 3: everything else in one transaction.
    try {
      const readGrid = grid;
      const readSnapshot = snapshot;
      return await uow.runAs(context, () => this.#store(setup, request, readGrid, readSnapshot));
    } catch (err) {
      // An unexpected failure (database, storage): the run is marked failed and the error
      // goes back to the queue, which tries again; admins hear about it on the last try.
      this.#deps.logger.error({ err, runId: setup.runId }, 'performance sync run failed');
      const last = attempt.attempt >= attempt.maxAttempts;
      await uow.runAs(context, () =>
        this.#failRun(
          setup,
          'source_unreachable',
          [{ code: 'internal_error', message: 'The run stopped on an internal error.' }],
          { alert: last, layoutChanged: false },
        ),
      );
      throw err;
    }
  }

  async #openRun(request: SyncRequest): Promise<RunSetup> {
    const { db, context } = currentUnit();
    const source = await db.syncSource.findFirst({
      where: { id: request.syncSourceId, deletedAt: null },
      include: { clientPlatform: true },
    });
    if (source === null) throw new NotFoundError();
    const readOn = request.readOn ?? dateInZone(source.timeZone, this.#deps.now?.() ?? new Date());

    // The newest saved mapping of the source, else the platform's standard mapping.
    const saved = await db.columnMapping.findFirst({
      where: { syncSourceId: source.id, deletedAt: null, validFrom: { lte: new Date() } },
      orderBy: { mappingVersion: 'desc' },
    });
    const parsedMapping = saved === null ? null : sheetColumnMappingSchema.safeParse(saved.mapping);
    const mapping =
      parsedMapping?.success === true
        ? parsedMapping.data
        : defaultMappingFor(source.clientPlatform.code);

    let config: Record<string, unknown> | null = null;
    if (source.configEncrypted !== null) {
      const opened = this.#deps.box.open(source.configEncrypted, SYNC_SOURCE_SECRET_CONTEXT);
      config = JSON.parse(opened.toString('utf8')) as Record<string, unknown>;
    }

    let upload: RunSetup['upload'] = null;
    if (request.trigger === 'upload') {
      const file = await db.fileObject.findFirst({
        where: { id: request.fileObjectId ?? '', companyId: source.companyId },
      });
      if (file === null) throw new NotFoundError();
      upload = {
        fileObjectId: file.id,
        objectKey: file.objectKey,
        sha256: file.sha256,
        name: file.originalName,
      };
    }

    const run = await db.syncRun.create({
      data: {
        tenantId: context.tenantId,
        companyId: source.companyId,
        syncSourceId: source.id,
        businessDate: toDay(readOn),
        trigger: request.trigger,
        ...(request.range === undefined
          ? {}
          : { rangeFrom: toDay(request.range.from), rangeTo: toDay(request.range.to) }),
      },
      select: { id: true },
    });
    return {
      runId: run.id,
      syncSourceId: source.id,
      companyId: source.companyId,
      sourceName: source.name,
      adapterKind: source.adapterKind,
      platformId: source.clientPlatformId,
      platformCode: source.clientPlatform.code,
      cycleStartDay: source.clientPlatform.cycleStartDay,
      readOn,
      mapping,
      config,
      upload,
    };
  }

  /** Reads the report: the uploaded file, or the source's reader. */
  async #read(setup: RunSetup, context: DbContext): Promise<{ grid: SheetGrid; snapshot: Buffer }> {
    let source: ReportSource;
    let bytes: Buffer | undefined;
    if (setup.upload !== null) {
      const stored = await this.#deps.storage.read(setup.upload.objectKey);
      if (stored === null) {
        throw new ReportSourceError('unreadable_file', 'The uploaded file is not in storage.');
      }
      bytes = stored;
      source = excelFileSource(stored);
    } else {
      const provider = this.#deps.providers.get(setup.adapterKind);
      if (provider === undefined) throw new NoProviderError(setup.adapterKind);
      source = provider.open({
        syncSourceId: setup.syncSourceId,
        adapterKind: setup.adapterKind,
        config: setup.config,
        context,
      });
    }
    const grid = await source.read(setup.mapping.tab);
    // An upload's snapshot is the file itself; a sheet read is kept as its grid.
    return { grid, snapshot: bytes ?? serialiseGrid(grid) };
  }

  /** Step 3 (inside the run's transaction). */
  async #store(
    setup: RunSetup,
    request: SyncRequest,
    grid: SheetGrid,
    snapshot: Buffer,
  ): Promise<SyncOutcome> {
    const { db } = currentUnit();
    // Two runs of one source never interleave: the second waits for the first to commit.
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`performance.sync:${request.syncSourceId}`}))`;

    // 3a. The raw snapshot, before anything is parsed.
    await this.#keepSnapshot(db, setup, request.syncSourceId, snapshot);

    // 3b. Empty sheet, changed layout.
    if (gridIsEmpty(grid, setup.mapping.firstDataRow)) {
      return this.#failRun(
        setup,
        'source_empty',
        [{ code: 'source_empty', message: `The tab "${grid.tab}" has no rows.` }],
        { alert: true, layoutChanged: false },
      );
    }
    const adapter = ADAPTERS.get(setup.platformCode);
    if (adapter === undefined) {
      return this.#failRun(
        setup,
        'source_not_configured',
        [
          {
            code: 'no_adapter',
            message: `No report layout is known for platform "${setup.platformCode}".`,
          },
        ],
        { alert: true, layoutChanged: false },
      );
    }
    const parsed = adapter.parse(grid, {
      mapping: setup.mapping,
      cycleStartDay: setup.cycleStartDay,
      readOn: setup.readOn,
    });
    if (!parsed.ok) {
      return this.#failRun(
        setup,
        'layout_changed',
        parsed.problems.map((p) => ({
          code: p.code,
          message: p.column === undefined ? p.message : `${p.message} (column ${p.column})`,
        })),
        { alert: true, layoutChanged: true },
      );
    }
    const report = parsed.report;
    if (report.people.length === 0 && report.rowErrors.length === 0) {
      return this.#failRun(
        setup,
        'source_empty',
        [{ code: 'source_empty', message: 'The report lists nobody.' }],
        { alert: true, layoutChanged: false },
      );
    }
    return this.#storeFigures(db, setup, request, report);
  }

  async #keepSnapshot(
    db: Db,
    setup: RunSetup,
    syncSourceId: string,
    snapshot: Buffer,
  ): Promise<void> {
    const { context } = currentUnit();
    const sha256 = setup.upload?.sha256 ?? createHash('sha256').update(snapshot).digest('hex');
    const earlier = await db.syncRun.findFirst({
      where: {
        syncSourceId,
        businessDate: toDay(setup.readOn),
        snapshotSha256: sha256,
        snapshotReused: false,
        id: { not: setup.runId },
      },
      select: { rawInputId: true },
    });
    if (earlier?.rawInputId != null) {
      await db.syncRun.update({
        where: { id: setup.runId },
        data: { rawInputId: earlier.rawInputId, snapshotSha256: sha256, snapshotReused: true },
      });
      return;
    }
    let fileObjectId = setup.upload?.fileObjectId;
    if (fileObjectId === undefined) {
      // Stored inside the transaction: if it rolls back, the bytes stay in storage with no
      // row pointing at them (harmless), and the retry stores them again.
      const month = setup.readOn.slice(0, 7);
      const objectKey = `${context.tenantId}/${setup.companyId}/${month}/${randomUUID()}`;
      await this.#deps.storage.store(objectKey, snapshot, 'application/json');
      const file = await db.fileObject.create({
        data: {
          tenantId: context.tenantId,
          companyId: setup.companyId,
          bucket: this.#deps.storage.bucket,
          objectKey,
          sha256,
          sizeBytes: BigInt(snapshot.length),
          mimeType: 'application/json',
          originalName: `${setup.platformCode}-report-${setup.readOn}.json`,
        },
        select: { id: true },
      });
      fileObjectId = file.id;
    }
    const raw = await db.rawInput.create({
      data: {
        tenantId: context.tenantId,
        companyId: setup.companyId,
        kind: setup.upload === null ? 'sheet_snapshot' : 'excel_upload',
        source: `performance.sync_source:${syncSourceId}`,
        sha256,
        fileObjectId,
        meta: {
          runId: setup.runId,
          readOn: setup.readOn,
          tab: setup.mapping.tab,
          ...(setup.upload === null ? {} : { originalName: setup.upload.name }),
        },
      },
      select: { id: true },
    });
    await db.syncRun.update({
      where: { id: setup.runId },
      data: { rawInputId: raw.id, snapshotSha256: sha256 },
    });
  }

  /** 3c to 3g: the figures of a parsed report. */
  async #storeFigures(
    db: Db,
    setup: RunSetup,
    request: SyncRequest,
    report: ParsedReport,
  ): Promise<SyncOutcome> {
    const { context } = currentUnit();
    const errors: { rowNo: number | null; code: string; message: string }[] = report.rowErrors.map(
      (e) => ({ rowNo: e.row, code: e.code, message: e.message }),
    );

    // 3c. A reset sheet: keep what is stored.
    if (report.resetDetected) {
      errors.push({
        rowNo: null,
        code: 'reset_detected',
        message:
          'Every day block is zero: the sheet was reset for a new cycle. Stored figures were kept.',
      });
      return this.#finishRun(db, setup, {
        status: errors.length > 1 ? 'partial' : 'succeeded',
        rowsRead: report.people.length,
        matched: 0,
        unmatched: 0,
        errors,
        counts: { stored: 0, unchanged: 0, retired: 0 },
        resetDetected: true,
      });
    }

    // 3d. Which dates this run stores.
    let dates = report.filledDates;
    if (request.range !== undefined) {
      const { from, to } = request.range;
      dates = dates.filter((d) => d >= from && d <= to);
      const missing: string[] = [];
      for (let d = from; d <= to && d <= report.dataThrough; d = addDays(d, 1)) {
        if (!report.filledDates.includes(d)) missing.push(d);
      }
      if (missing.length > 0) {
        errors.push({
          rowNo: null,
          code: 'date_not_in_sheet',
          message: `The report holds no figures for ${missing.join(', ')}; nothing was re-imported for ${missing.length === 1 ? 'that date' : 'those dates'}.`,
        });
      }
    }
    const dateSet = new Set(dates);

    // 3e. Who held each sheet id on each date.
    const idType = identifierTypeFor(setup.platformCode);
    const firstDate = dates[0] ?? report.dataThrough;
    const lastDate = dates.at(-1) ?? report.dataThrough;
    const holders = await this.#deps.parties.identifierHolders(
      setup.companyId,
      idType,
      report.people.map((p) => p.identifier),
      firstDate < report.dataThrough ? firstDate : report.dataThrough,
      lastDate > report.dataThrough ? lastDate : report.dataThrough,
    );
    const holderOn = (identifier: string, date: string): string | null => {
      const value = normaliseSecretValue(identifier);
      const found = holders.find(
        (h) =>
          h.value === value && h.validFrom <= date && (h.validTo === null || h.validTo >= date),
      );
      return found?.partyId ?? null;
    };

    // 3f. Compare with the current rows of those dates.
    const current =
      dates.length === 0
        ? []
        : await db.dailyPerformance.findMany({
            where: {
              clientPlatformId: setup.platformId,
              isCurrent: true,
              businessDate: { in: dates.map(toDay) },
            },
            select: {
              id: true,
              businessDate: true,
              externalId: true,
              partyId: true,
              ordersCompleted: true,
              workingMinutes: true,
              lateMinutes: true,
              metrics: true,
            },
          });
    const currentByExternal = new Map(
      current.map((r) => [`${r.externalId}|${fromDay(r.businessDate)}`, r]),
    );
    const currentByParty = new Map(
      current
        .filter((r) => r.partyId !== null)
        .map((r) => [`${r.partyId ?? ''}|${fromDay(r.businessDate)}`, r]),
    );

    const retire: { id: string; businessDate: Date }[] = [];
    const inserts: Prisma.DailyPerformanceCreateManyInput[] = [];
    const claimed = new Map<string, string>(); // party|date -> external id in this run
    let unchanged = 0;
    const matchedIds = new Set<string>();
    const unmatchedSeen = new Map<string, SeenUnmatched>();

    for (const person of report.people) {
      const days = person.days.filter((d) => dateSet.has(d.date));
      // A person with no stored date this run is still matched (or queued) as of the
      // newest date the sheet covers.
      if (days.length === 0) {
        if (holderOn(person.identifier, report.dataThrough) === null) {
          noteUnmatched(unmatchedSeen, person, report.dataThrough);
        } else {
          matchedIds.add(person.identifier);
        }
      }
      for (const day of days) {
        let partyId = holderOn(person.identifier, day.date);
        if (partyId === null) {
          noteUnmatched(unmatchedSeen, person, day.date);
        } else {
          matchedIds.add(person.identifier);
          // One current row per person per date (database rule): a person reached through
          // two sheet ids on the same date keeps the first, and the second row is stored
          // unmatched and reported, never silently merged.
          const key = `${partyId}|${day.date}`;
          const otherInRun = claimed.get(key);
          const otherStored = currentByParty.get(key);
          if (
            (otherInRun !== undefined && otherInRun !== person.identifier) ||
            (otherStored !== undefined && otherStored.externalId !== person.identifier)
          ) {
            errors.push({
              rowNo: person.row,
              code: 'party_has_other_id',
              message: `Public ID ${person.identifier}: this person already has figures for ${day.date} under another ID; stored without a person.`,
            });
            partyId = null;
          } else {
            claimed.set(key, person.identifier);
          }
        }

        const metrics = { ...day.metrics, _fields: person.fields, _extra: person.extra };
        const existing = currentByExternal.get(`${person.identifier}|${day.date}`);
        if (existing !== undefined && sameFigures(existing, partyId, day)) {
          unchanged += 1;
          continue;
        }
        if (existing !== undefined) {
          retire.push({ id: existing.id, businessDate: existing.businessDate });
        }
        inserts.push({
          tenantId: context.tenantId,
          companyId: setup.companyId,
          syncRunId: setup.runId,
          clientPlatformId: setup.platformId,
          businessDate: toDay(day.date),
          partyId,
          externalId: person.identifier,
          ordersCompleted: day.ordersCompleted,
          workingMinutes: day.workingMinutes,
          lateMinutes: day.lateMinutes,
          metrics: metrics,
        });
      }
    }

    // Retire first: the partial unique index allows one current row per id and date.
    for (const row of retire) {
      await db.dailyPerformance.update({
        where: { id_businessDate: { id: row.id, businessDate: row.businessDate } },
        data: { isCurrent: false },
      });
    }
    if (inserts.length > 0) await db.dailyPerformance.createMany({ data: inserts });

    // The unmatched queue: new ids are opened, known ones get their seen dates widened. The
    // sheet's own details (name, phone, driver or rider, plate, zone) are kept so the queue
    // screen can say who this is; a newer sync overwrites them, but a blank cell never wipes
    // what an earlier sync read (COALESCE). Rows already closed (linked, created, ignored)
    // keep their status.
    for (const [externalId, seen] of unmatchedSeen) {
      await db.$executeRaw`
        INSERT INTO performance.unmatched_identifier
          (tenant_id, company_id, client_platform_id, external_id, first_seen, last_seen,
           sheet_name, sheet_phone, sheet_profession, sheet_plate, sheet_zone)
        VALUES (${context.tenantId}::uuid, ${setup.companyId}::uuid, ${setup.platformId}::uuid,
                ${externalId}, ${seen.first}::date, ${seen.last}::date,
                ${seen.details.name}, ${seen.details.phone}, ${seen.details.profession},
                ${seen.details.plate}, ${seen.details.zone})
        ON CONFLICT (client_platform_id, external_id) WHERE deleted_at IS NULL
        DO UPDATE SET first_seen = LEAST(performance.unmatched_identifier.first_seen, EXCLUDED.first_seen),
                      last_seen = GREATEST(performance.unmatched_identifier.last_seen, EXCLUDED.last_seen),
                      sheet_name = COALESCE(EXCLUDED.sheet_name, performance.unmatched_identifier.sheet_name),
                      sheet_phone = COALESCE(EXCLUDED.sheet_phone, performance.unmatched_identifier.sheet_phone),
                      sheet_profession = COALESCE(EXCLUDED.sheet_profession, performance.unmatched_identifier.sheet_profession),
                      sheet_plate = COALESCE(EXCLUDED.sheet_plate, performance.unmatched_identifier.sheet_plate),
                      sheet_zone = COALESCE(EXCLUDED.sheet_zone, performance.unmatched_identifier.sheet_zone)`;
    }

    const hasRowProblems = errors.some((e) => e.code !== 'date_not_in_sheet');
    return this.#finishRun(db, setup, {
      status: hasRowProblems ? 'partial' : 'succeeded',
      rowsRead: report.people.length,
      matched: matchedIds.size,
      unmatched: unmatchedSeen.size,
      errors,
      counts: { stored: inserts.length, unchanged, retired: retire.length },
      resetDetected: false,
      ...(dates.length === 0 ? {} : { range: { from: firstDate, to: lastDate } }),
    });
  }

  /** 3g. Ends the run: counts, errors, superseded earlier runs. */
  async #finishRun(
    db: Db,
    setup: RunSetup,
    result: {
      status: SyncStatus;
      rowsRead: number;
      matched: number;
      unmatched: number;
      errors: { rowNo: number | null; code: string; message: string }[];
      counts: { stored: number; unchanged: number; retired: number };
      resetDetected: boolean;
      range?: { from: string; to: string };
    },
  ): Promise<SyncOutcome> {
    await this.#writeErrors(db, setup, result.errors);
    const run = await db.syncRun.findFirst({
      where: { id: setup.runId },
      select: { rangeFrom: true },
    });
    await db.syncRun.update({
      where: { id: setup.runId },
      data: {
        status: result.status,
        rowsRead: result.rowsRead,
        matched: result.matched,
        unmatched: result.unmatched,
        errorsCount: result.errors.length,
        finishedAt: new Date(),
        // A re-import keeps the range it was asked for; another run records the dates it
        // covered, so the run list shows what each run stored.
        ...(run?.rangeFrom === null && result.range !== undefined
          ? { rangeFrom: toDay(result.range.from), rangeTo: toDay(result.range.to) }
          : {}),
      },
    });
    // Earlier finished runs of the same source and date are superseded by this one.
    await db.syncRun.updateMany({
      where: {
        syncSourceId: setup.syncSourceId,
        businessDate: toDay(setup.readOn),
        id: { not: setup.runId },
        status: { in: ['succeeded', 'partial'] },
        supersededByRunId: null,
      },
      data: { supersededByRunId: setup.runId },
    });
    return {
      runId: setup.runId,
      status: result.status,
      problem: null,
      ...result.counts,
      matched: result.matched,
      unmatched: result.unmatched,
      errors: result.errors.length,
      resetDetected: result.resetDetected,
      alerted: false,
    };
  }

  /** Ends a run that could not use the report, and alerts admins when asked to. */
  async #failRun(
    setup: RunSetup,
    problem: SyncProblem,
    errors: { code: string; message: string }[],
    options: { alert: boolean; layoutChanged: boolean },
  ): Promise<SyncOutcome> {
    const { db } = currentUnit();
    await this.#writeErrors(
      db,
      setup,
      errors.map((e) => ({ rowNo: null, ...e })),
    );
    await db.syncRun.update({
      where: { id: setup.runId },
      data: {
        status: 'failed',
        errorsCount: errors.length,
        layoutChanged: options.layoutChanged,
        finishedAt: new Date(),
      },
    });
    if (options.alert) {
      await this.#deps.outbox.record({
        eventType: SYNC_PROBLEM_EVENT,
        companyId: setup.companyId,
        aggregateType: 'performance.sync_run',
        aggregateId: setup.runId,
        payload: {
          runId: setup.runId,
          sourceName: setup.sourceName,
          platformCode: setup.platformCode,
          businessDate: setup.readOn,
          problem,
          message: errors.map((e) => e.message).join(' '),
        },
      });
    }
    return {
      runId: setup.runId,
      status: 'failed',
      problem,
      stored: 0,
      unchanged: 0,
      retired: 0,
      matched: 0,
      unmatched: 0,
      errors: errors.length,
      resetDetected: false,
      alerted: options.alert,
    };
  }

  async #writeErrors(
    db: Db,
    setup: RunSetup,
    errors: { rowNo: number | null; code: string; message: string }[],
  ): Promise<void> {
    if (errors.length === 0) return;
    const { context } = currentUnit();
    await db.syncRunError.createMany({
      data: errors.map((e) => ({
        tenantId: context.tenantId,
        companyId: setup.companyId,
        syncRunId: setup.runId,
        rowNo: e.rowNo,
        code: e.code,
        message: e.message.slice(0, 2000),
      })),
    });
  }
}

/** No reader is installed for the source's adapter kind (a set-up problem, not retried). */
class NoProviderError extends Error {
  readonly adapterKind: string;

  constructor(adapterKind: string) {
    super(`No reader is installed for sources of kind "${adapterKind}".`);
    this.adapterKind = adapterKind;
  }
}

/** What a read failure means for the run. */
function readProblemOf(err: unknown, setup: RunSetup): ReadProblem {
  if (err instanceof NoProviderError) {
    return {
      problem: 'source_not_configured',
      code: 'no_reader',
      message: `${err.message} Upload the day's Excel file instead.`,
      retryable: false,
    };
  }
  if (err instanceof ReportSourceError) {
    // A missing tab means the workbook changed; an unreadable upload will not get better.
    if (err.code === 'missing_tab') {
      return { problem: 'layout_changed', code: err.code, message: err.message, retryable: false };
    }
    // Row 4.4: no connection or a revoked grant is a set-up problem that only an admin can
    // fix (reconnect Google), so it is not retried and the alert goes out at once. The
    // reader's message already says to reconnect and that the day's Excel upload works.
    if (err.code === 'not_connected' || err.code === 'access_revoked') {
      return {
        problem: 'source_not_configured',
        code: err.code,
        message: err.message,
        retryable: false,
      };
    }
    return {
      problem: 'source_unreachable',
      code: err.code,
      message: err.message,
      retryable: setup.upload === null && (err.retryable ?? true),
    };
  }
  return {
    problem: 'source_unreachable',
    code: 'source_unreachable',
    message: `The report of "${setup.sourceName}" could not be read: ${err instanceof Error ? err.message : String(err)}`,
    retryable: setup.upload === null,
  };
}

/** What one run saw of an unmatched sheet id: dates and the sheet row's own details. */
interface SeenUnmatched {
  first: string;
  last: string;
  details: {
    name: string | null;
    phone: string | null;
    profession: string | null;
    plate: string | null;
    zone: string | null;
  };
}

/** Text of a sheet field by mapping key (blank = null), cut to what the column holds. */
function sheetText(
  fields: Record<string, string | number | null>,
  key: string,
  max: number,
): string | null {
  const value = fields[key];
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text.slice(0, max);
}

function noteUnmatched(
  seen: Map<string, SeenUnmatched>,
  person: { identifier: string; fields: Record<string, string | number | null> },
  date: string,
): void {
  const identifier = person.identifier;
  const known = seen.get(identifier);
  if (known === undefined) {
    seen.set(identifier, {
      first: date,
      last: date,
      details: {
        name: sheetText(person.fields, 'name', 200),
        phone: sheetText(person.fields, 'contact_number', 50),
        profession: sheetText(person.fields, 'vehicle_type', 100),
        plate: sheetText(person.fields, 'plate_number', 50),
        zone: sheetText(person.fields, 'zone', 100),
      },
    });
    return;
  }
  if (date < known.first) known.first = date;
  if (date > known.last) known.last = date;
}

/** True when a stored row already holds these figures for the same person. */
function sameFigures(
  row: {
    partyId: string | null;
    ordersCompleted: number | null;
    workingMinutes: number | null;
    lateMinutes: number | null;
    metrics: unknown;
  },
  partyId: string | null,
  day: ParsedDay,
): boolean {
  return (
    row.partyId === partyId &&
    row.ordersCompleted === day.ordersCompleted &&
    row.workingMinutes === day.workingMinutes &&
    row.lateMinutes === day.lateMinutes &&
    stableJson(blockFigures(row.metrics)) === stableJson(day.metrics)
  );
}
