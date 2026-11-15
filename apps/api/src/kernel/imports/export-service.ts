/**
 * Export service: bulk export of any record type to CSV or Excel (row 2.8b).
 *
 * Purpose: the mirror of the import engine. It asks the same target (./import-targets) for
 * its fields and for rows, so every built-in type that registers a target and every custom
 * record type can be exported with no extra code. The columns are the target's fields, headed
 * by their labels, so an exported file can be edited and imported back through the wizard.
 *
 * Steps of `run`, all in the caller's transaction (so a failure leaves nothing behind):
 *   1. Check `integration.export_job.create` AND the target's own read permission, so an
 *      export is never a way to read what the record type's own screens would hide.
 *   2. Page through the target (200 at a time) up to MAX_EXPORT_ROWS. A bigger set is refused
 *      with a message to filter, because the file is built in memory.
 *   3. Build the CSV or .xlsx, store the bytes, and insert a `file_object` for them.
 *   4. Insert the `export_job` (who, what, filters, row count, file). It is audited like any
 *      row, which is the record that data left the system. The file is downloaded through the
 *      normal audited `/files/{id}/download-url` (only its creator may, unless attached).
 *
 * Depends on: kernel/db, kernel/permissions, adapters/storage, ./import-targets, ./xlsx-sheet,
 * @fibrex/shared. Used by: ./import-router, src/main.ts.
 */
import { createHash, randomUUID } from 'node:crypto';
import { buildCsv, MAX_EXPORT_ROWS, type ImportValue } from '@fibrex/shared';
import type { StorageAdapter } from '../../adapters/storage/interface.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { Db } from '../db/prisma.js';
import { currentUnit } from '../db/unit-of-work.js';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
} from '../http/errors.js';
import type { PermissionService } from '../permissions/permission-service.js';
import type { ImportTargets } from './import-targets.js';
import { buildXlsx } from './xlsx-sheet.js';

export type ExportJobRow = NonNullable<Awaited<ReturnType<Db['exportJob']['findFirst']>>>;
export type ExportFormat = 'csv' | 'xlsx';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PAGE = 200;

export interface ExportServiceDeps {
  storage: StorageAdapter;
  permissions: PermissionService;
  targets: ImportTargets;
}

export class ExportService {
  private readonly deps: ExportServiceDeps;

  constructor(deps: ExportServiceDeps) {
    this.deps = deps;
  }

  async run(input: {
    entityKey: string;
    format: ExportFormat;
    filters: Record<string, string>;
    companyId?: string;
  }): Promise<ExportJobRow> {
    const { db, context } = currentUnit();
    await this.deps.permissions.require('integration.export_job.create');
    const target = await this.deps.targets.resolve(input.entityKey);
    if (target.readPermission === undefined || target.exportRows === undefined) {
      // This kind of record cannot be exported (its owner has not allowed it).
      throw new NotFoundError();
    }
    await this.deps.permissions.require(target.readPermission);

    const companyId =
      input.companyId ?? (context.companyIds.length === 1 ? context.companyIds[0] : undefined);
    if (companyId === undefined) {
      throw new BadRequestError('company_required', 'State which company this export is for.');
    }
    if (!context.companyIds.includes(companyId)) {
      throw new ForbiddenError('You do not have access to this company');
    }

    // Step 2: gather the rows.
    const fields = await target.fields();
    const rows: Record<string, ImportValue | null>[] = [];
    for (let page = 1; ; page += 1) {
      const result = await target.exportRows(input.filters, page, PAGE);
      if (result.total > MAX_EXPORT_ROWS) {
        throw new UnprocessableError(
          'export_too_large',
          `${String(result.total)} rows match; an export holds at most ${String(MAX_EXPORT_ROWS)}. Add a filter.`,
        );
      }
      rows.push(...result.rows);
      if (result.rows.length < PAGE || rows.length >= result.total) break;
    }

    // Step 3: build and store the file. Column headings are the field labels; cells are
    // looked up by field key.
    const columns = fields.map((field) => field.label);
    const labelled = rows.map((row) => {
      const out: Record<string, ImportValue | null> = {};
      for (const field of fields) out[field.label] = row[field.key] ?? null;
      return out;
    });
    const bytes =
      input.format === 'csv'
        ? Buffer.from(buildCsv(columns, labelled), 'utf8')
        : await buildXlsx(target.label, columns, labelled);
    const mimeType = input.format === 'csv' ? 'text/csv' : XLSX_MIME;
    const objectKey = `${context.tenantId}/${companyId}/exports/${randomUUID()}`;
    await this.deps.storage.store(objectKey, bytes, mimeType);
    const stamp = new Date().toISOString().slice(0, 10);
    const file = await db.fileObject.create({
      data: {
        tenantId: context.tenantId,
        companyId,
        bucket: this.deps.storage.bucket,
        objectKey,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sizeBytes: BigInt(bytes.length),
        mimeType,
        originalName: `${input.entityKey.replace(/\./g, '-')}-${stamp}.${input.format}`,
      },
      select: { id: true },
    });

    // Step 4: the record of the export.
    return db.exportJob.create({
      data: {
        tenantId: context.tenantId,
        companyId,
        entityKey: input.entityKey,
        format: input.format,
        filters: input.filters as Prisma.InputJsonValue,
        status: 'completed',
        rowCount: rows.length,
        fileObjectId: file.id,
      },
    });
  }

  async get(id: string): Promise<ExportJobRow> {
    await this.deps.permissions.require('integration.export_job.read');
    const job = await currentUnit().db.exportJob.findFirst({ where: { id, deletedAt: null } });
    if (job === null) throw new NotFoundError();
    return job;
  }

  async list(options: { entityKey?: string; page: number; pageSize: number }) {
    await this.deps.permissions.require('integration.export_job.read');
    const { db } = currentUnit();
    const where = {
      deletedAt: null,
      ...(options.entityKey === undefined ? {} : { entityKey: options.entityKey }),
    };
    const [items, total] = await Promise.all([
      db.exportJob.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: (options.page - 1) * options.pageSize,
        take: options.pageSize,
      }),
      db.exportJob.count({ where }),
    ]);
    return { items, total, page: options.page, pageSize: options.pageSize };
  }
}
