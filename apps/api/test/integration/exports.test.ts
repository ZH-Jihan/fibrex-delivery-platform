/**
 * Bulk export and Excel import (phase 2 row 2.8b) against real PostgreSQL: an .xlsx sheet is
 * imported through the same engine as CSV, and an export writes a file, a file_object and an
 * export_job. The target is a small branch target with `exportRows`, as in imports.test.ts.
 *
 * Data is invented: tenant A, companies A1 and A2 from the fixture.
 */
import { createHash, randomUUID } from 'node:crypto';
import { parseCsv, type ImportMapping } from '@fibrex/shared';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { MemoryStorageAdapter } from '../../src/adapters/storage/memory.js';
import { createPool, type Pool } from '../../src/kernel/db/pool.js';
import { createPrisma, type Db } from '../../src/kernel/db/prisma.js';
import { createRepository } from '../../src/kernel/db/repository.js';
import { UnitOfWork, type DbContext } from '../../src/kernel/db/unit-of-work.js';
import { ForbiddenError, NotFoundError } from '../../src/kernel/http/errors.js';
import { ExportService } from '../../src/kernel/imports/export-service.js';
import { ImportQueue } from '../../src/kernel/imports/import-queue.js';
import { ImportService } from '../../src/kernel/imports/import-service.js';
import { ImportTargets, type ImportTarget } from '../../src/kernel/imports/import-targets.js';
import { buildXlsx, readXlsx } from '../../src/kernel/imports/xlsx-sheet.js';
import { createLogger } from '../../src/kernel/observability/logger.js';
import type { PermissionService } from '../../src/kernel/permissions/permission-service.js';
import { createFixture, type Fixture } from './fixtures.js';
import { connectionUrl } from './global-setup.js';
import { connect, testDatabase } from './helpers.js';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

let owner: pg.Client;
let pool: Pool;
let f: Fixture;
let uow: UnitOfWork;
let storage: MemoryStorageAdapter;
let importService: ImportService;
let exportService: ExportService;
let queue: ImportQueue;
let ctx: DbContext;
const denied = new Set<string>();

type BranchRow = NonNullable<Awaited<ReturnType<Db['branch']['findFirst']>>>;
const branchRepo = createRepository<BranchRow>({ model: 'branch', scope: 'company' });
const branchTarget: ImportTarget = {
  key: 'test_branch',
  label: 'Branch',
  createPermission: 'platform.branch.create',
  readPermission: 'platform.branch.read',
  fields: () =>
    Promise.resolve([
      { key: 'code', label: 'Code', required: true },
      { key: 'name', label: 'Branch name', required: true },
    ]),
  validate: () => Promise.resolve([]),
  create: async (values, companyId) => (await branchRepo.create({ ...values, companyId })).id,
  remove: async (id, reason) => {
    const row = await branchRepo.get(id);
    await branchRepo.softDelete(id, row.version, reason);
  },
  // Filters by code prefix only, which is all this test target needs.
  exportRows: async (filters, page, pageSize) => {
    const result = await branchRepo.list({
      where: { code: { startsWith: filters.code ?? '' } },
      orderBy: [{ code: 'asc' }],
      page,
      pageSize,
    });
    return {
      rows: result.items.map((row) => ({ code: row.code, name: row.name })),
      total: result.total,
    };
  },
};

const run = <T>(fn: () => Promise<T>) => uow.runAs(ctx, fn);

async function uploadXlsx(bytes: Buffer): Promise<string> {
  const key = `${f.tenantA}/${f.companyA1}/test/${randomUUID()}`;
  storage.put(key, bytes);
  const row = await owner.query<{ id: string }>(
    `INSERT INTO files.file_object (tenant_id, company_id, bucket, object_key, sha256, size_bytes, mime_type, original_name)
     VALUES ($1, $2, 'memory', $3, $4, $5, $6, 'sheet.xlsx') RETURNING id`,
    [
      f.tenantA,
      f.companyA1,
      key,
      createHash('sha256').update(bytes).digest('hex'),
      bytes.length,
      XLSX,
    ],
  );
  return row.rows[0]?.id ?? '';
}

beforeAll(async () => {
  owner = await connect('owner');
  f = await createFixture(owner);
  const db = testDatabase();
  pool = createPool(connectionUrl(db, db.app), 4);
  uow = new UnitOfWork(createPrisma(pool));
  storage = new MemoryStorageAdapter();
  const targets = new ImportTargets(() => Promise.reject(new NotFoundError()));
  targets.register(branchTarget);
  const permissions = {
    require: (key: string) =>
      denied.has(key) ? Promise.reject(new ForbiddenError('no')) : Promise.resolve({}),
  } as unknown as PermissionService;
  importService = new ImportService({ uow, storage, permissions, targets });
  exportService = new ExportService({ storage, permissions, targets });
  queue = new ImportQueue({
    redisUrl: inject('redisUrl'),
    service: importService,
    logger: createLogger({ level: 'silent', pretty: false, serviceName: 'test' }),
  });
  ctx = { tenantId: f.tenantA, companyIds: [f.companyA1], userId: f.userA };
});

afterAll(async () => {
  await queue.close();
  await pool.end();
  await owner.end();
});

describe('Excel import', () => {
  it('previews and commits an .xlsx sheet like a CSV one', async () => {
    const p = 'XL';
    const bytes = await buildXlsx(
      'Branches',
      ['Code', 'Branch name'],
      [
        { Code: `${p}A`, 'Branch name': 'Excel one' },
        { Code: `${p}B`, 'Branch name': 'Excel two' },
      ],
    );
    const mapping: ImportMapping = {
      columnMap: { code: 'Code', name: 'Branch name' },
      transforms: {},
    };
    const job = await run(async () => {
      const created = await importService.createJob({
        entityKey: 'test_branch',
        fileObjectId: await uploadXlsx(bytes),
      });
      expect(created.stats).toMatchObject({ rowCount: 2, columns: ['Code', 'Branch name'] });
      await importService.preview(created.id, { mapping });
      await importService.requestCommit(created.id, { skipInvalid: false });
      return created;
    });
    const result = await queue.process({
      tenantId: f.tenantA,
      companyId: f.companyA1,
      userId: f.userA,
      jobId: job.id,
    });
    expect(result).toMatchObject({ status: 'committed', created: 2 });
  });

  it('refuses a damaged .xlsx with a message, not a crash', async () => {
    const fileId = await uploadXlsx(Buffer.from('PK\u0003\u0004 broken'));
    await expect(
      run(() => importService.createJob({ entityKey: 'test_branch', fileObjectId: fileId })),
    ).rejects.toMatchObject({ issues: [{ code: 'unreadable_file' }] });
  });
});

describe('bulk export', () => {
  it('writes a CSV file, a file_object and an export_job with the row count', async () => {
    const job = await run(() =>
      exportService.run({ entityKey: 'test_branch', format: 'csv', filters: { code: 'XL' } }),
    );
    expect(job).toMatchObject({ status: 'completed', format: 'csv', rowCount: 2 });
    const file = await owner.query<{ object_key: string; mime_type: string; created_by: string }>(
      `SELECT object_key, mime_type, created_by FROM files.file_object WHERE id = $1`,
      [job.fileObjectId],
    );
    expect(file.rows[0]).toMatchObject({ mime_type: 'text/csv', created_by: f.userA });
    const csv = (await storage.read(file.rows[0]?.object_key ?? ''))?.toString('utf8') ?? '';
    expect(parseCsv(csv).rows).toEqual([
      { Code: 'XLA', 'Branch name': 'Excel one' },
      { Code: 'XLB', 'Branch name': 'Excel two' },
    ]);
  });

  it('writes an Excel file that the import reader reads back', async () => {
    const job = await run(() =>
      exportService.run({ entityKey: 'test_branch', format: 'xlsx', filters: { code: 'XL' } }),
    );
    const file = await owner.query<{ object_key: string }>(
      `SELECT object_key FROM files.file_object WHERE id = $1`,
      [job.fileObjectId],
    );
    const sheet = await readXlsx(
      (await storage.read(file.rows[0]?.object_key ?? '')) ?? Buffer.alloc(0),
    );
    expect(sheet.columns).toEqual(['Code', 'Branch name']);
    expect(sheet.rows.map((row) => row.Code)).toEqual(['XLA', 'XLB']);
  });

  it('needs the export permission and the type read permission, and lists exports', async () => {
    for (const key of ['integration.export_job.create', 'platform.branch.read']) {
      denied.add(key);
      try {
        await expect(
          run(() => exportService.run({ entityKey: 'test_branch', format: 'csv', filters: {} })),
        ).rejects.toBeInstanceOf(ForbiddenError);
      } finally {
        denied.delete(key);
      }
    }
    const page = await run(() =>
      exportService.list({ entityKey: 'test_branch', page: 1, pageSize: 50 }),
    );
    expect(page.total).toBeGreaterThanOrEqual(2);
  });

  it('cannot export a record type that has no export, or one of another company', async () => {
    await expect(
      run(() => exportService.run({ entityKey: 'nothing', format: 'csv', filters: {} })),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      run(() =>
        exportService.run({
          entityKey: 'test_branch',
          format: 'csv',
          filters: {},
          companyId: f.companyA2,
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
