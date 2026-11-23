/**
 * Snoonu FDB report check service (phase 4 row 4.9).
 *
 * Purpose: reads the `FDB Report` tab of a platform's report workbook (through the sync
 * source's read-only reader, or an uploaded Excel copy), compares it with our employees and
 * their current documents, and stores the run and its differences for staff to review. It
 * never changes an employee, a document or a status, and never writes to the sheet.
 *
 * A run has three steps, like a sync run, so the network read never holds a transaction open:
 *   1. prepare (transaction): load the source, its sealed reader settings, the uploaded file.
 *   2. read (no transaction): the grid of the FDB tab.
 *   3. store (transaction): parse, match Falcon IDs through the party module (the same lookup as
 *      the daily sync), load our side, compare, and insert the run and its differences.
 *
 * Review carry-over: a difference a person already marked reviewed or ignored in the previous
 * run, with the same two values, keeps that mark, so the list does not ask the same question
 * every day. If either value changes, it is a new open difference.
 *
 * Depends on: ./fdb-parser.ts, ./fdb-compare.ts, ./source-providers.ts, ./report-adapter.ts,
 * ./sync-service.ts (id type, date helper), ../party (identifier lookup), adapters/storage,
 * kernel/db, kernel/crypto. Used by: ./fdb-router.ts, ./index.ts, src/main.ts.
 */
import { createHash } from 'node:crypto';
import type { SecretBox } from '../../kernel/crypto/secret-box.js';
import type { StorageAdapter } from '../../adapters/storage/interface.js';
import { currentUnit, type UnitOfWork } from '../../kernel/db/unit-of-work.js';
import type { DbContext } from '../../kernel/db/unit-of-work.js';
import { NotFoundError, UnprocessableError } from '../../kernel/http/errors.js';
import type { Logger } from '../../kernel/observability/logger.js';
import { holderOn, type PartyService } from '../party/index.js';
import { compareFdb, differenceKey, FDB_COMPARED_DOCS, type FdbOurPerson } from './fdb-compare.js';
import { FDB_TAB, parseFdbReport } from './fdb-parser.js';
import {
  excelFileSource,
  ReportSourceError,
  type ReportSource,
  type SheetGrid,
} from './report-adapter.js';
import type { ReportSourceProviders } from './source-providers.js';
import {
  dateInZone,
  identifierTypeFor,
  SYNC_SOURCE_SECRET_CONTEXT,
  XLSX_MIME,
} from './sync-service.js';

export interface FdbRunRequest {
  syncSourceId: string;
  /** An uploaded Excel copy of the workbook; absent: read through the source's reader. */
  fileObjectId?: string | undefined;
}

export interface FdbRunSetup {
  context: DbContext;
  companyId: string;
  clientPlatformId: string;
  platformCode: string;
  syncSourceId: string;
  adapterKind: string;
  config: Record<string, unknown> | null;
  businessDate: string;
  upload: { fileObjectId: string; objectKey: string } | null;
}

export interface FdbRunResult {
  checkId: string;
  businessDate: string;
  rowsRead: number;
  matched: number;
  unmatched: number;
  differences: number;
  /** Differences that kept a reviewed or ignored mark from the previous run. */
  carriedOver: number;
  /** Fields found by position because Snoonu's header text could not be read. */
  positionalColumns: string[];
}

export interface FdbServiceDeps {
  uow: UnitOfWork;
  storage: StorageAdapter;
  parties: Pick<PartyService, 'identifierHolders'>;
  providers: ReportSourceProviders;
  box: SecretBox;
  logger: Logger;
  now?: () => Date;
}

const toDay = (text: string) => new Date(`${text}T00:00:00.000Z`);
const fromDay = (value: Date | null) => (value === null ? null : value.toISOString().slice(0, 10));

export class FdbService {
  readonly #deps: FdbServiceDeps;

  constructor(deps: FdbServiceDeps) {
    this.#deps = deps;
  }

  /** Runs the whole check (steps 1 to 3). The caller checks the permission. */
  async run(request: FdbRunRequest): Promise<FdbRunResult> {
    const { uow } = this.#deps;
    const setup = await uow.run(() => this.#prepare(request));
    const grid = await this.#read(setup);
    return uow.run(() => this.#store(setup, grid));
  }

  /** Step 1. */
  async #prepare(request: FdbRunRequest): Promise<FdbRunSetup> {
    const { db, context } = currentUnit();
    const source = await db.syncSource.findFirst({
      where: { id: request.syncSourceId, deletedAt: null },
      include: { clientPlatform: true },
    });
    if (source === null) throw new NotFoundError();
    if (!source.active) {
      throw new UnprocessableError('source_inactive', 'This sync source is switched off.');
    }
    let upload: FdbRunSetup['upload'] = null;
    if (request.fileObjectId !== undefined) {
      const file = await db.fileObject.findFirst({
        where: { id: request.fileObjectId, companyId: source.companyId },
      });
      if (file === null) throw new UnprocessableError('unknown_file', 'This file does not exist.');
      if (file.mimeType !== XLSX_MIME) {
        throw new UnprocessableError('not_xlsx', 'Upload the report as an Excel (.xlsx) file.');
      }
      upload = { fileObjectId: file.id, objectKey: file.objectKey };
    } else if (source.adapterKind === 'excel') {
      throw new UnprocessableError(
        'upload_only',
        'This source is read from uploaded files only: upload the Excel copy of the report.',
      );
    }
    let config: Record<string, unknown> | null = null;
    if (source.configEncrypted !== null) {
      const opened = this.#deps.box.open(source.configEncrypted, SYNC_SOURCE_SECRET_CONTEXT);
      config = JSON.parse(opened.toString('utf8')) as Record<string, unknown>;
    }
    return {
      context,
      companyId: source.companyId,
      clientPlatformId: source.clientPlatformId,
      platformCode: source.clientPlatform.code,
      syncSourceId: source.id,
      adapterKind: source.adapterKind,
      config,
      businessDate: dateInZone(source.timeZone, this.#deps.now?.() ?? new Date()),
      upload,
    };
  }

  /** Step 2: the grid of the FDB tab, outside any transaction. */
  async #read(setup: FdbRunSetup): Promise<SheetGrid> {
    let source: ReportSource;
    if (setup.upload !== null) {
      const bytes = await this.#deps.storage.read(setup.upload.objectKey);
      if (bytes === null) {
        throw new UnprocessableError('unreadable_file', 'The uploaded file is not in storage.');
      }
      source = excelFileSource(bytes);
    } else {
      const provider = this.#deps.providers.get(setup.adapterKind);
      if (provider === undefined) {
        throw new UnprocessableError(
          'no_reader',
          `No reader is installed for sources of kind "${setup.adapterKind}".`,
        );
      }
      source = provider.open({
        syncSourceId: setup.syncSourceId,
        adapterKind: setup.adapterKind,
        config: setup.config,
        context: setup.context,
      });
    }
    try {
      return await source.read(FDB_TAB);
    } catch (err) {
      if (err instanceof ReportSourceError) {
        throw new UnprocessableError(`fdb_${err.code}`, err.message);
      }
      throw err;
    }
  }

  /** Step 3 (inside one transaction). */
  async #store(setup: FdbRunSetup, grid: SheetGrid): Promise<FdbRunResult> {
    const { db, context } = currentUnit();
    const parsed = parseFdbReport(grid);
    if (!parsed.ok) throw new UnprocessableError('fdb_layout_changed', parsed.message);
    const { report } = parsed;
    const idType = identifierTypeFor(setup.platformCode);
    const date = setup.businessDate;

    // 3a. Who holds each Falcon ID today (the same lookup and normaliser as the daily sync).
    const holders = await this.#deps.parties.identifierHolders(
      setup.companyId,
      idType,
      report.rows.map((r) => r.identifier),
      date,
      date,
    );
    const holderOfId = (identifier: string) => holderOn(holders, identifier, date);
    const matchedParties = [
      ...new Set(report.rows.map((r) => holderOfId(r.identifier)).filter((p) => p !== null)),
    ];

    // 3b. Our side: employee record and current document dates of the matched people.
    const employees = await db.employee.findMany({
      where: { companyId: setup.companyId, deletedAt: null, partyId: { in: matchedParties } },
      select: { partyId: true, statusCode: true, party: { select: { displayName: true } } },
    });
    const parties = await db.party.findMany({
      where: { companyId: setup.companyId, id: { in: matchedParties } },
      select: { id: true, displayName: true },
    });
    const documents = await db.document.findMany({
      where: {
        companyId: setup.companyId,
        deletedAt: null,
        status: { not: 'replaced' },
        ownerType: 'party',
        ownerId: { in: matchedParties },
        documentType: { code: { in: [...FDB_COMPARED_DOCS] } },
      },
      select: { ownerId: true, expiryDate: true, documentType: { select: { code: true } } },
    });
    const ours = new Map<string, FdbOurPerson>();
    for (const p of parties) {
      ours.set(p.id, { partyId: p.id, displayName: p.displayName, statusCode: null, expiry: {} });
    }
    for (const e of employees) {
      const person = ours.get(e.partyId);
      if (person !== undefined) person.statusCode = e.statusCode;
    }
    for (const d of documents) {
      const person = ours.get(d.ownerId);
      const code = d.documentType?.code;
      const expiry = fromDay(d.expiryDate);
      if (person === undefined || code === undefined || expiry === null) continue;
      // Several current documents of one type should not exist; the later date wins if they do.
      const held = person.expiry[code];
      if (held === undefined || held === null || held < expiry) person.expiry[code] = expiry;
    }

    // 3c. Active employees holding a Falcon ID today, to find those the tab does not list.
    const active = await db.employee.findMany({
      where: {
        companyId: setup.companyId,
        deletedAt: null,
        statusCode: 'active',
        party: {
          deletedAt: null,
          identifiers: {
            some: {
              type: idType,
              deletedAt: null,
              validFrom: { lte: toDay(date) },
              OR: [{ validTo: null }, { validTo: { gte: toDay(date) } }],
            },
          },
        },
      },
      select: { partyId: true, statusCode: true, party: { select: { displayName: true } } },
    });
    const activeWithId: FdbOurPerson[] = active.map((e) => ({
      partyId: e.partyId,
      displayName: e.party.displayName,
      statusCode: e.statusCode,
      expiry: {},
    }));

    // 3d. Compare.
    const result = compareFdb({
      rows: report.rows,
      holderOf: holderOfId,
      ours,
      activeWithId,
    });

    // 3e. Keep the marks of the previous run's reviewed or ignored differences.
    const previous = await db.fdbCheck.findFirst({
      where: { companyId: setup.companyId, clientPlatformId: setup.clientPlatformId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    const marks = new Map<
      string,
      { status: string; note: string | null; at: Date | null; by: string | null }
    >();
    if (previous !== null) {
      const marked = await db.fdbDifference.findMany({
        where: {
          companyId: setup.companyId,
          fdbCheckId: previous.id,
          deletedAt: null,
          reviewStatus: { not: 'open' },
        },
      });
      for (const m of marked) {
        marks.set(
          differenceKey({
            kind: m.kind as never,
            field: m.field,
            partyId: m.partyId,
            externalId: m.externalId,
            displayName: m.displayName,
            oursValue: m.oursValue,
            theirsValue: m.theirsValue,
          }),
          { status: m.reviewStatus, note: m.reviewNote, at: m.reviewedAt, by: m.reviewedBy },
        );
      }
    }

    // 3f. Store the run (with the tab as parsed, the raw record) and its differences.
    const sha256 = createHash('sha256').update(JSON.stringify(report.rows)).digest('hex');
    const check = await db.fdbCheck.create({
      data: {
        tenantId: context.tenantId,
        companyId: setup.companyId,
        clientPlatformId: setup.clientPlatformId,
        syncSourceId: setup.syncSourceId,
        source: setup.upload === null ? 'sheet' : 'upload',
        fileObjectId: setup.upload?.fileObjectId ?? null,
        businessDate: toDay(date),
        snapshotSha256: sha256,
        rowsRead: report.rows.length,
        matched: result.matched,
        unmatched: result.unmatched,
        differencesCount: result.differences.length,
        rows: JSON.parse(JSON.stringify(report.rows)) as object,
      },
      select: { id: true },
    });
    let carriedOver = 0;
    if (result.differences.length > 0) {
      await db.fdbDifference.createMany({
        data: result.differences.map((d) => {
          const mark = marks.get(differenceKey(d));
          if (mark !== undefined) carriedOver += 1;
          return {
            tenantId: context.tenantId,
            companyId: setup.companyId,
            fdbCheckId: check.id,
            clientPlatformId: setup.clientPlatformId,
            kind: d.kind,
            field: d.field,
            partyId: d.partyId,
            externalId: d.externalId,
            displayName: d.displayName,
            oursValue: d.oursValue,
            theirsValue: d.theirsValue,
            ...(mark === undefined
              ? {}
              : {
                  reviewStatus: mark.status,
                  reviewNote: mark.note,
                  reviewedAt: mark.at,
                  reviewedBy: mark.by,
                }),
          };
        }),
      });
    }
    this.#deps.logger.info(
      { checkId: check.id, rows: report.rows.length, differences: result.differences.length },
      'fdb check stored',
    );
    return {
      checkId: check.id,
      businessDate: date,
      rowsRead: report.rows.length,
      matched: result.matched,
      unmatched: result.unmatched,
      differences: result.differences.length,
      carriedOver,
      positionalColumns: report.positional,
    };
  }
}
