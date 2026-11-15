/**
 * Import service: the generic "load a sheet into any record type" engine (row 2.8a).
 *
 * Purpose: one engine for every importable kind of record, built-in or custom. A person
 * uploads a CSV sheet, maps its columns to fields (saved for next time), previews every row
 * with its problems, commits in a background job and, if it was a mistake, rolls the whole
 * import back. The engine never writes a record itself: it asks the target (./import-targets)
 * to, so the owning service's rules always apply.
 *
 * Life of a job (status in brackets):
 *   1. `createJob`  - the sheet is already in object storage (the normal signed upload). It
 *      is read, checked, and kept for ever as a `raw_input` (SPEC 2.12). [uploaded]
 *   2. `preview`    - applies the mapping to every row and asks the target to check each one.
 *      Every row, good or bad, is stored in `import_row` (insert-only). Can be repeated with
 *      another mapping; each preview is a new numbered set. [previewed]
 *   3. `requestCommit` - refuses while rows have errors unless the caller chose to skip
 *      them. Marks the job [queued]; the router then puts it on the queue.
 *   4. `runCommit`  - the worker. In ONE transaction it creates every good row and records
 *      the created ids in `import_result`. Any failure rolls the transaction back, so a
 *      commit either creates everything or nothing; the job is then [failed] and can be
 *      previewed again. Success: [committed].
 *   5. `rollback`   - soft-deletes exactly the records the commit created (audited, can be
 *      restored from the recycle bin). [rolled_back]
 *
 * Concurrency: every step that changes a job first locks its row (`FOR UPDATE`) and then
 * checks the status, so two people (or a retried queue job) cannot commit or roll back the
 * same job twice.
 *
 * Depends on: kernel/db, kernel/permissions, adapters/storage, ./import-targets,
 * @fibrex/shared (CSV and mapping). Used by: ./import-router, ./import-queue, src/main.ts.
 */
import { createHash } from 'node:crypto';
import {
  importMappingSchema,
  normaliseRow,
  parseCsv,
  SheetError,
  type ImportMapping,
  type RowIssue,
} from '@fibrex/shared';
import type { StorageAdapter } from '../../adapters/storage/interface.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { Db } from '../db/prisma.js';
import { currentUnit, type DbContext, type UnitOfWork } from '../db/unit-of-work.js';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
} from '../http/errors.js';
import type { PermissionService } from '../permissions/permission-service.js';
import type { ImportTargets } from './import-targets.js';
import { readXlsx } from './xlsx-sheet.js';

export type ImportJobRow = NonNullable<Awaited<ReturnType<Db['importJob']['findFirst']>>>;
export type ImportRowRow = NonNullable<Awaited<ReturnType<Db['importRow']['findFirst']>>>;

/** File types a sheet may have: CSV, plain text, what Excel calls a "CSV" upload, and .xlsx. */
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SHEET_MIME_TYPES = new Set(['text/csv', 'text/plain', 'application/vnd.ms-excel', XLSX_MIME]);
const ROW_CHUNK = 1000;

export interface ImportServiceDeps {
  uow: UnitOfWork;
  storage: StorageAdapter;
  permissions: PermissionService;
  targets: ImportTargets;
}

const json = (value: unknown) => value as Prisma.InputJsonValue;
const stats = (job: ImportJobRow) => job.stats as Record<string, unknown>;

export class ImportService {
  private readonly deps: ImportServiceDeps;

  constructor(deps: ImportServiceDeps) {
    this.deps = deps;
  }

  /** The company of a new job: the one named, or the caller's only one. */
  private companyFor(requested: string | undefined): string {
    const { context } = currentUnit();
    const companyId =
      requested ?? (context.companyIds.length === 1 ? context.companyIds[0] : undefined);
    if (companyId === undefined) {
      throw new BadRequestError('company_required', 'State which company this import is for.');
    }
    if (!context.companyIds.includes(companyId)) {
      throw new ForbiddenError('You do not have access to this company');
    }
    return companyId;
  }

  /** The job, locked for the rest of the transaction; 404 when missing or not visible. */
  private async lockJob(id: string): Promise<ImportJobRow> {
    const { db } = currentUnit();
    const locked = await db.$queryRaw<{ id: string }[]>`
      SELECT id FROM integration.import_job
      WHERE id = ${id}::uuid AND deleted_at IS NULL FOR UPDATE`;
    if (locked.length === 0) throw new NotFoundError();
    return db.importJob.findUniqueOrThrow({ where: { id } });
  }

  private requireStatus(job: ImportJobRow, allowed: string[], action: string): void {
    if (!allowed.includes(job.status)) {
      throw new UnprocessableError(
        'import_wrong_status',
        `This import is ${job.status}; it cannot be ${action} now.`,
      );
    }
  }

  /** Reads the job's sheet back from storage and parses it. */
  private async readSheet(job: ImportJobRow) {
    const { db } = currentUnit();
    const raw = await db.rawInput.findFirst({ where: { id: job.rawInputId } });
    const file =
      raw?.fileObjectId == null
        ? null
        : await db.fileObject.findFirst({ where: { id: raw.fileObjectId } });
    if (raw === null || file === null) throw new NotFoundError();
    const bytes = await this.deps.storage.read(file.objectKey);
    if (bytes === null) {
      throw new UnprocessableError('file_missing', 'The uploaded file is no longer in storage.');
    }
    if (createHash('sha256').update(bytes).digest('hex') !== raw.sha256) {
      throw new UnprocessableError('file_changed', 'The stored file no longer matches its record.');
    }
    return this.parse(bytes, file.mimeType);
  }

  /** CSV text or an .xlsx workbook (first sheet), by the file's declared type. */
  private async parse(bytes: Buffer, mimeType: string) {
    try {
      return mimeType === XLSX_MIME ? await readXlsx(bytes) : parseCsv(bytes.toString('utf8'));
    } catch (err) {
      if (err instanceof SheetError) {
        throw new ValidationError([{ path: 'file', code: err.code, message: err.message }]);
      }
      throw err;
    }
  }

  /** What a mapping screen needs: the target's name and the fields it can fill. */
  async describeTarget(entityKey: string) {
    const target = await this.deps.targets.resolve(entityKey);
    await this.deps.permissions.require(target.createPermission);
    return { key: target.key, label: target.label, fields: await target.fields() };
  }

  /** Step 1: keep the sheet as a raw input and open a job. */
  async createJob(input: { entityKey: string; fileObjectId: string; companyId?: string }) {
    const { db, context } = currentUnit();
    await this.deps.permissions.require('integration.import_job.create');
    const target = await this.deps.targets.resolve(input.entityKey);
    await this.deps.permissions.require(target.createPermission);
    const companyId = this.companyFor(input.companyId);

    const file = await db.fileObject.findFirst({
      where: { id: input.fileObjectId, companyId },
    });
    if (file === null) {
      throw new ValidationError([
        { path: 'fileObjectId', code: 'unknown_file', message: 'This file does not exist.' },
      ]);
    }
    if (!SHEET_MIME_TYPES.has(file.mimeType)) {
      throw new ValidationError([
        {
          path: 'fileObjectId',
          code: 'not_a_csv',
          message: 'Upload the sheet as a CSV or Excel (.xlsx) file.',
        },
      ]);
    }
    const bytes = await this.deps.storage.read(file.objectKey);
    if (bytes === null) {
      throw new ValidationError([
        { path: 'fileObjectId', code: 'file_missing', message: 'The file is not in storage.' },
      ]);
    }
    const sheet = await this.parse(bytes, file.mimeType);

    // The same bytes imported and committed before is probably a double upload: warn, do not block.
    const sha256 = file.sha256;
    const earlier = await db.importJob.findFirst({
      where: {
        entityKey: input.entityKey,
        status: 'committed',
        deletedAt: null,
        rawInput: { sha256 },
      },
      select: { id: true },
    });
    const raw = await db.rawInput.create({
      data: {
        tenantId: context.tenantId,
        companyId,
        kind: 'excel_upload',
        source: `import:${input.entityKey}`,
        sha256,
        fileObjectId: file.id,
        meta: { originalName: file.originalName, rows: sheet.rows.length },
      },
      select: { id: true },
    });
    return db.importJob.create({
      data: {
        tenantId: context.tenantId,
        companyId,
        entityKey: input.entityKey,
        rawInputId: raw.id,
        status: 'uploaded',
        stats: json({
          fileName: file.originalName,
          columns: sheet.columns,
          rowCount: sheet.rows.length,
          warnings:
            earlier === null
              ? []
              : [`This exact file was already imported (import ${earlier.id}).`],
        }),
      },
    });
  }

  /** Reads one job (404 when it is not visible to the caller). */
  async get(id: string): Promise<ImportJobRow> {
    await this.deps.permissions.require('integration.import_job.read');
    const job = await currentUnit().db.importJob.findFirst({ where: { id, deletedAt: null } });
    if (job === null) throw new NotFoundError();
    return job;
  }

  async list(options: { status?: string; entityKey?: string; page: number; pageSize: number }) {
    await this.deps.permissions.require('integration.import_job.read');
    const { db } = currentUnit();
    const where = {
      deletedAt: null,
      ...(options.status === undefined ? {} : { status: options.status }),
      ...(options.entityKey === undefined ? {} : { entityKey: options.entityKey }),
    };
    const [items, total] = await Promise.all([
      db.importJob.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: (options.page - 1) * options.pageSize,
        take: options.pageSize,
      }),
      db.importJob.count({ where }),
    ]);
    return { items, total, page: options.page, pageSize: options.pageSize };
  }

  /** The stored preview rows of the latest preview. */
  async rows(
    id: string,
    options: { onlyErrors: boolean; page: number; pageSize: number },
  ): Promise<{ items: ImportRowRow[]; total: number; page: number; pageSize: number }> {
    const job = await this.get(id);
    if (job.previewNo === 0) return { items: [], total: 0, ...pick(options) };
    const { db } = currentUnit();
    const where = {
      importJobId: id,
      previewNo: job.previewNo,
      ...(options.onlyErrors ? { NOT: { errors: { equals: [] } } } : {}),
    };
    const [items, total] = await Promise.all([
      db.importRow.findMany({
        where,
        orderBy: { rowNo: 'asc' },
        skip: (options.page - 1) * options.pageSize,
        take: options.pageSize,
      }),
      db.importRow.count({ where }),
    ]);
    return { items, total, ...pick(options) };
  }

  /**
   * Step 2: apply a mapping to every row and check each row with the target. Takes either
   * a saved mapping (`mappingId`) or one written out (`mapping`).
   */
  async preview(id: string, input: { mappingId?: string; mapping?: ImportMapping }) {
    await this.deps.permissions.require('integration.import_job.update');
    const { db, context } = currentUnit();
    const job = await this.lockJob(id);
    this.requireStatus(job, ['uploaded', 'previewed', 'failed'], 'previewed');
    const target = await this.deps.targets.resolve(job.entityKey);
    await this.deps.permissions.require(target.createPermission);

    // Which mapping: a saved one (must be for this record type) or the one sent.
    let mapping: ImportMapping;
    let mappingId: string | null = null;
    if (input.mappingId !== undefined) {
      const saved = await db.importMapping.findFirst({
        where: { id: input.mappingId, deletedAt: null },
      });
      if (saved?.entityKey !== job.entityKey) {
        throw new ValidationError([
          { path: 'mappingId', code: 'unknown_mapping', message: 'No such saved mapping.' },
        ]);
      }
      mapping = importMappingSchema.parse({
        columnMap: saved.columnMap,
        transforms: saved.transforms,
      });
      mappingId = saved.id;
    } else if (input.mapping !== undefined) {
      mapping = input.mapping;
    } else {
      throw new ValidationError([
        {
          path: 'mapping',
          code: 'required',
          message: 'Choose a saved mapping or map the columns.',
        },
      ]);
    }

    const sheet = await this.readSheet(job);
    await this.checkMapping(mapping, sheet.columns, target);

    // Normalise and check every row. Rows are checked one by one (the target may look things
    // up), but written in chunks.
    const previewNo = job.previewNo + 1;
    let valid = 0;
    let invalid = 0;
    let chunk: Prisma.ImportRowCreateManyInput[] = [];
    const flush = async () => {
      if (chunk.length > 0) await db.importRow.createMany({ data: chunk });
      chunk = [];
    };
    for (const [index, raw] of sheet.rows.entries()) {
      const { values, issues } = normaliseRow(raw, mapping);
      const problems: RowIssue[] = [...issues];
      // Fields that failed to normalise are skipped here: their problem is already listed.
      const failed = new Set(issues.map((issue) => issue.path));
      if (failed.size === 0) problems.push(...(await target.validate(values)));
      if (problems.length === 0) valid += 1;
      else invalid += 1;
      chunk.push({
        tenantId: context.tenantId,
        companyId: job.companyId,
        importJobId: job.id,
        previewNo,
        rowNo: index + 1,
        raw: json(raw),
        normalised: json(values),
        errors: json(problems),
      });
      if (chunk.length >= ROW_CHUNK) await flush();
    }
    await flush();

    return db.importJob.update({
      where: { id },
      data: {
        status: 'previewed',
        previewNo,
        mappingId,
        mapping: json(mapping),
        stats: json({ ...stats(job), valid, invalid, rowCount: sheet.rows.length, error: null }),
      },
    });
  }

  /** The mapping must name real fields and real columns, and fill every required field. */
  private async checkMapping(
    mapping: ImportMapping,
    columns: string[],
    target: Awaited<ReturnType<ImportTargets['resolve']>>,
  ) {
    const fields = await target.fields();
    const known = new Map(fields.map((field) => [field.key, field]));
    const issues: { path: string; code: string; message: string }[] = [];
    for (const [field, column] of Object.entries(mapping.columnMap)) {
      if (!known.has(field)) {
        issues.push({
          path: `columnMap.${field}`,
          code: 'unknown_field',
          message: `"${field}" is not a field of ${target.label}.`,
        });
      }
      if (!columns.includes(column)) {
        issues.push({
          path: `columnMap.${field}`,
          code: 'unknown_column',
          message: `The file has no column "${column}".`,
        });
      }
    }
    for (const field of fields) {
      if (field.required && mapping.columnMap[field.key] === undefined) {
        issues.push({
          path: `columnMap.${field.key}`,
          code: 'required_field_unmapped',
          message: `"${field.label}" is required: map a column to it.`,
        });
      }
    }
    if (issues.length > 0) throw new ValidationError(issues);
  }

  /** Step 3: mark the job for the worker. The router enqueues after this transaction commits. */
  async requestCommit(id: string, options: { skipInvalid: boolean }) {
    await this.deps.permissions.require('integration.import_job.commit');
    const { db } = currentUnit();
    const job = await this.lockJob(id);
    this.requireStatus(job, ['previewed'], 'committed');
    const target = await this.deps.targets.resolve(job.entityKey);
    await this.deps.permissions.require(target.createPermission);
    const { valid = 0, invalid = 0 } = stats(job) as { valid?: number; invalid?: number };
    if (invalid > 0 && !options.skipInvalid) {
      throw new UnprocessableError(
        'import_rows_have_errors',
        `${String(invalid)} rows have errors. Fix the file, or commit only the good rows.`,
      );
    }
    if (valid === 0) {
      throw new UnprocessableError('import_nothing_to_commit', 'There are no good rows to import.');
    }
    return db.importJob.update({
      where: { id },
      data: { status: 'queued', stats: json({ ...stats(job), skipInvalid: options.skipInvalid }) },
    });
  }

  /**
   * Step 4, run by the worker as the person who asked. Creates every good row of the latest
   * preview in one transaction; see the file header for why it is all or nothing.
   */
  async runCommit(
    context: DbContext,
    jobId: string,
  ): Promise<{ status: 'committed' | 'failed' | 'skipped'; created: number; error?: string }> {
    try {
      return await this.deps.uow.runAs(context, async (db) => {
        const job = await this.lockJob(jobId);
        // A retried or duplicated queue message finds the job already done and does nothing.
        if (job.status !== 'queued') return { status: 'skipped' as const, created: 0 };
        const target = await this.deps.targets.resolve(job.entityKey);
        const rows = await db.importRow.findMany({
          where: { importJobId: job.id, previewNo: job.previewNo, errors: { equals: [] } },
          orderBy: { rowNo: 'asc' },
        });
        const results: Prisma.ImportResultCreateManyInput[] = [];
        for (const row of rows) {
          try {
            const id = await target.create(row.normalised as Record<string, never>, job.companyId);
            results.push({
              tenantId: job.tenantId,
              companyId: job.companyId,
              importJobId: job.id,
              rowNo: row.rowNo,
              createdEntityId: id,
            });
          } catch (err) {
            // Name the row so the person can find it in the file, then undo everything.
            const message = err instanceof Error ? err.message : 'Unknown error';
            throw new CommitFailure(`Row ${String(row.rowNo)}: ${message}`);
          }
        }
        for (let i = 0; i < results.length; i += ROW_CHUNK) {
          await db.importResult.createMany({ data: results.slice(i, i + ROW_CHUNK) });
        }
        await db.importJob.update({
          where: { id: job.id },
          data: {
            status: 'committed',
            stats: json({
              ...stats(job),
              created: results.length,
              skipped: stats(job).invalid ?? 0,
              committedAt: new Date().toISOString(),
            }),
          },
        });
        return { status: 'committed' as const, created: results.length };
      });
    } catch (err) {
      // The transaction above rolled back, so nothing was created. Record why, in a new one.
      const error =
        err instanceof CommitFailure
          ? err.message
          : err instanceof Error
            ? err.message
            : 'The import failed.';
      await this.deps.uow.runAs(context, async (db) => {
        const job = await this.lockJob(jobId);
        if (job.status !== 'queued') return;
        await db.importJob.update({
          where: { id: jobId },
          data: { status: 'failed', stats: json({ ...stats(job), error }) },
        });
      });
      return { status: 'failed', created: 0, error };
    }
  }

  /** Step 5: soft-delete exactly what the commit created. */
  async rollback(id: string, reason: string) {
    await this.deps.permissions.require('integration.import_job.rollback');
    const { db } = currentUnit();
    const job = await this.lockJob(id);
    this.requireStatus(job, ['committed'], 'rolled back');
    const target = await this.deps.targets.resolve(job.entityKey);
    const results = await db.importResult.findMany({
      where: { importJobId: id },
      orderBy: { rowNo: 'asc' },
    });
    let removed = 0;
    let alreadyGone = 0;
    for (const result of results) {
      try {
        await target.remove(result.createdEntityId, `Import rolled back: ${reason}`);
        removed += 1;
      } catch (err) {
        // Deleted by someone since the import: nothing left to undo for this row.
        if (!(err instanceof NotFoundError)) throw err;
        alreadyGone += 1;
      }
    }
    return db.importJob.update({
      where: { id },
      data: {
        status: 'rolled_back',
        stats: json({ ...stats(job), rolledBack: removed, alreadyGone, rollbackReason: reason }),
      },
    });
  }
}

/** Internal: a row the target refused at commit time (aborts the commit transaction). */
class CommitFailure extends Error {}

function pick(options: { page: number; pageSize: number }) {
  return { page: options.page, pageSize: options.pageSize };
}
