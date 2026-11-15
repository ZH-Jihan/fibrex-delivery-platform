/**
 * Generic import engine (phase 2 row 2.8a) against real PostgreSQL and Redis: a CSV sheet
 * becomes a raw input and a job, is previewed with per-row errors under a saved or written
 * mapping, committed all-or-nothing by a worker, and rolled back (soft delete). The target
 * is a small test target that writes branches, so rollback and failure are checked on real
 * rows; the custom-record target is covered by its own checks in the same file.
 *
 * Data is invented: tenant A, companies A1 and A2 from the fixture.
 */
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { MemoryStorageAdapter } from '../../src/adapters/storage/memory.js';
import { createPool, type Pool } from '../../src/kernel/db/pool.js';
import { createPrisma } from '../../src/kernel/db/prisma.js';
import { createRepository } from '../../src/kernel/db/repository.js';
import type { ImportMapping } from '@fibrex/shared';
import { UnitOfWork, type DbContext } from '../../src/kernel/db/unit-of-work.js';
import type { Db } from '../../src/kernel/db/prisma.js';
import { ForbiddenError, NotFoundError } from '../../src/kernel/http/errors.js';
import { ImportQueue } from '../../src/kernel/imports/import-queue.js';
import { ImportService } from '../../src/kernel/imports/import-service.js';
import { ImportTargets, type ImportTarget } from '../../src/kernel/imports/import-targets.js';
import { createLogger } from '../../src/kernel/observability/logger.js';
import type { PermissionService } from '../../src/kernel/permissions/permission-service.js';
import { createFixture, type Fixture } from './fixtures.js';
import { connectionUrl } from './global-setup.js';
import { connect, testDatabase } from './helpers.js';

let owner: pg.Client;
let pool: Pool;
let f: Fixture;
let uow: UnitOfWork;
let storage: MemoryStorageAdapter;
let service: ImportService;
let queue: ImportQueue;
let ctx: DbContext;
const denied = new Set<string>();

/** Imports branches: code and name required, the code must be 2 to 6 capital letters. */
const branchRepo = createRepository<NonNullable<Awaited<ReturnType<Db['branch']['findFirst']>>>>({
  model: 'branch',
  scope: 'company',
});
const branchTarget: ImportTarget = {
  key: 'test_branch',
  label: 'Branch',
  createPermission: 'platform.branch.create',
  fields: () =>
    Promise.resolve([
      { key: 'code', label: 'Code', required: true },
      { key: 'name', label: 'Name', required: true },
      { key: 'address', label: 'Address', required: false },
    ]),
  validate: (values) => {
    const issues = [];
    if (typeof values.code !== 'string' || !/^[A-Z]{2,6}$/.test(values.code)) {
      issues.push({ path: 'code', code: 'bad_code', message: 'Use 2 to 6 capital letters.' });
    }
    if (values.name === undefined) {
      issues.push({ path: 'name', code: 'required', message: 'The name is required.' });
    }
    return Promise.resolve(issues);
  },
  create: async (values, companyId) => {
    const row = await branchRepo.create({ ...values, companyId });
    return row.id;
  },
  remove: async (id, reason) => {
    const row = await branchRepo.get(id);
    await branchRepo.softDelete(id, row.version, reason);
  },
};

/** Puts a CSV in storage and a file_object row for it, as the signed upload would. */
async function upload(csv: string, mime = 'text/csv', companyId = f.companyA1): Promise<string> {
  const bytes = Buffer.from(csv, 'utf8');
  const key = `${f.tenantA}/${companyId}/test/${randomUUID()}`;
  storage.put(key, bytes);
  const row = await owner.query<{ id: string }>(
    `INSERT INTO files.file_object (tenant_id, company_id, bucket, object_key, sha256, size_bytes, mime_type, original_name)
     VALUES ($1, $2, 'memory', $3, $4, $5, $6, 'sheet.csv') RETURNING id`,
    [
      f.tenantA,
      companyId,
      key,
      createHash('sha256').update(bytes).digest('hex'),
      bytes.length,
      mime,
    ],
  );
  return row.rows[0]?.id ?? '';
}

const mapping: ImportMapping = {
  columnMap: { code: 'Code', name: 'Branch name' },
  transforms: { code: ['trim', 'upper'] },
};

const run = <T>(fn: () => Promise<T>) => uow.runAs(ctx, fn);

async function liveBranches(prefix: string): Promise<number> {
  const r = await owner.query<{ n: string }>(
    `SELECT count(*) AS n FROM platform.branch WHERE company_id = $1 AND code LIKE $2 AND deleted_at IS NULL`,
    [f.companyA1, `${prefix}%`],
  );
  return Number(r.rows[0]?.n);
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
  service = new ImportService({ uow, storage, permissions, targets });
  queue = new ImportQueue({
    redisUrl: inject('redisUrl'),
    service,
    logger: createLogger({ level: 'silent', pretty: false, serviceName: 'test' }),
  });
  ctx = { tenantId: f.tenantA, companyIds: [f.companyA1], userId: f.userA };
});

afterAll(async () => {
  await queue.close();
  await pool.end();
  await owner.end();
});

describe('upload', () => {
  it('keeps the sheet as a raw input and opens a job with its columns and row count', async () => {
    const fileId = await upload('Code,Branch name\nAA,North\nBB,South\n');
    const job = await run(() =>
      service.createJob({ entityKey: 'test_branch', fileObjectId: fileId }),
    );
    expect(job.status).toBe('uploaded');
    expect(job.stats).toMatchObject({ rowCount: 2, columns: ['Code', 'Branch name'] });
    const raw = await owner.query<{ kind: string; source: string; sha256: string }>(
      `SELECT kind, source, sha256 FROM files.raw_input WHERE id = $1`,
      [job.rawInputId],
    );
    expect(raw.rows[0]).toMatchObject({ kind: 'excel_upload', source: 'import:test_branch' });
    expect(raw.rows[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a file that is not a CSV, an unknown file and an unknown record type', async () => {
    const pdf = await upload('x', 'application/pdf');
    await expect(
      run(() => service.createJob({ entityKey: 'test_branch', fileObjectId: pdf })),
    ).rejects.toMatchObject({ issues: [{ code: 'not_a_csv' }] });
    await expect(
      run(() => service.createJob({ entityKey: 'test_branch', fileObjectId: randomUUID() })),
    ).rejects.toMatchObject({ issues: [{ code: 'unknown_file' }] });
    const ok = await upload('Code\nAA');
    await expect(
      run(() => service.createJob({ entityKey: 'nothing', fileObjectId: ok })),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('needs the target permission as well as the import permission', async () => {
    const fileId = await upload('Code\nAA');
    denied.add('platform.branch.create');
    try {
      await expect(
        run(() => service.createJob({ entityKey: 'test_branch', fileObjectId: fileId })),
      ).rejects.toBeInstanceOf(ForbiddenError);
    } finally {
      denied.delete('platform.branch.create');
    }
  });

  it('warns when the same file was already imported', async () => {
    const prefix = 'WA';
    const csv = `Code,Branch name\n${prefix}A,One\n`;
    const first = await run(async () => {
      const job = await service.createJob({
        entityKey: 'test_branch',
        fileObjectId: await upload(csv),
      });
      await service.preview(job.id, { mapping });
      await service.requestCommit(job.id, { skipInvalid: false });
      return job;
    });
    await queue.process({ tenantId: f.tenantA, companyId: f.companyA1, jobId: first.id });
    const second = await run(async () =>
      service.createJob({ entityKey: 'test_branch', fileObjectId: await upload(csv) }),
    );
    expect(JSON.stringify(second.stats)).toContain('already imported');
  });
});

describe('preview', () => {
  it('lists every row with its problems and counts good and bad rows', async () => {
    const csv = 'Code,Branch name,Address\n aa ,North,Street 1\nb1,South,\nCC,,\n';
    const job = await run(async () => {
      const created = await service.createJob({
        entityKey: 'test_branch',
        fileObjectId: await upload(csv),
      });
      return service.preview(created.id, { mapping });
    });
    expect(job.status).toBe('previewed');
    expect(job.previewNo).toBe(1);
    expect(job.stats).toMatchObject({ rowCount: 3, valid: 1, invalid: 2 });
    const all = await run(() => service.rows(job.id, { onlyErrors: false, page: 1, pageSize: 50 }));
    expect(all.total).toBe(3);
    expect(all.items[0]).toMatchObject({ rowNo: 1, normalised: { code: 'AA', name: 'North' } });
    const bad = await run(() => service.rows(job.id, { onlyErrors: true, page: 1, pageSize: 50 }));
    expect(bad.items.map((r) => r.rowNo)).toEqual([2, 3]);
    expect(JSON.stringify(bad.items[0]?.errors)).toContain('bad_code');
  });

  it('refuses a mapping that does not fit the file or leaves a required field unmapped', async () => {
    const created = await run(async () =>
      service.createJob({
        entityKey: 'test_branch',
        fileObjectId: await upload('Code,Branch name\nAA,x\n'),
      }),
    );
    const paths = async (m: unknown) => {
      try {
        await run(() => service.preview(created.id, { mapping: m as typeof mapping }));
        return [];
      } catch (err) {
        return (err as { issues: { code: string }[] }).issues.map((i) => i.code);
      }
    };
    expect(await paths({ columnMap: { code: 'Code' }, transforms: {} })).toEqual([
      'required_field_unmapped',
    ]);
    expect(
      await paths({
        columnMap: { code: 'Nope', name: 'Branch name', size: 'Code' },
        transforms: {},
      }),
    ).toEqual(['unknown_column', 'unknown_field']);
  });

  it('works from a saved mapping and keeps a snapshot of it on the job', async () => {
    const saved = await owner.query<{ id: string }>(
      `INSERT INTO integration.import_mapping (tenant_id, entity_key, name, column_map, transforms)
       VALUES ($1, 'test_branch', $2, $3, $4) RETURNING id`,
      [f.tenantA, `Standard ${randomUUID().slice(0, 6)}`, mapping.columnMap, mapping.transforms],
    );
    const mappingId = saved.rows[0]?.id ?? '';
    const job = await run(async () => {
      const created = await service.createJob({
        entityKey: 'test_branch',
        fileObjectId: await upload('Code,Branch name,Address\nAA,North,\n'),
      });
      return service.preview(created.id, { mappingId });
    });
    expect(job.mappingId).toBe(mappingId);
    expect(job.mapping).toMatchObject({ columnMap: { code: 'Code' } });
    await owner.query(
      `UPDATE integration.import_mapping SET column_map = '{"code":"X"}' WHERE id = $1`,
      [mappingId],
    );
    const after = await run(() => service.get(job.id));
    expect(after.mapping).toMatchObject({ columnMap: { code: 'Code' } });
  });

  it('keeps earlier previews: a second preview adds a numbered set', async () => {
    const job = await run(async () => {
      const created = await service.createJob({
        entityKey: 'test_branch',
        fileObjectId: await upload('Code,Branch name\nAA,North\n'),
      });
      await service.preview(created.id, { mapping });
      return service.preview(created.id, { mapping });
    });
    expect(job.previewNo).toBe(2);
    const n = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM integration.import_row WHERE import_job_id = $1`,
      [job.id],
    );
    expect(n.rows[0]?.n).toBe('2');
  });
});

describe('commit and rollback', () => {
  async function previewed(rows: string[]) {
    return run(async () => {
      const created = await service.createJob({
        entityKey: 'test_branch',
        fileObjectId: await upload(`Code,Branch name\n${rows.join('\n')}\n`),
      });
      return service.preview(created.id, { mapping });
    });
  }
  const ask = (id: string, skipInvalid = false) =>
    run(() => service.requestCommit(id, { skipInvalid }));
  const go = (id: string) =>
    queue.process({ tenantId: f.tenantA, companyId: f.companyA1, userId: f.userA, jobId: id });

  it('creates the good rows in the worker, records what it created, and rolls back by soft delete', async () => {
    const p = `K${randomUUID().slice(0, 2).toUpperCase().replace(/[0-9]/g, 'Q')}`;
    const job = await previewed([`${p}A,One`, `${p}B,Two`, 'bad1,Three']);
    // Rows with errors stop the commit unless the person chooses to skip them.
    await expect(ask(job.id)).rejects.toMatchObject({ code: 'import_rows_have_errors' });
    const queued = await ask(job.id, true);
    expect(queued.status).toBe('queued');

    const result = await go(job.id);
    expect(result).toMatchObject({ status: 'committed', created: 2 });
    expect(await liveBranches(p)).toBe(2);
    const results = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM integration.import_result WHERE import_job_id = $1`,
      [job.id],
    );
    expect(results.rows[0]?.n).toBe('2');
    const done = await run(() => service.get(job.id));
    expect(done.status).toBe('committed');
    expect(done.stats).toMatchObject({ created: 2, skipped: 1 });

    // A second delivery of the same queue message does nothing.
    expect(await go(job.id)).toMatchObject({ status: 'skipped', created: 0 });
    expect(await liveBranches(p)).toBe(2);

    // Rollback: exactly those rows are soft-deleted with the reason; nothing is erased.
    const rolled = await run(() => service.rollback(job.id, 'wrong file'));
    expect(rolled.status).toBe('rolled_back');
    expect(rolled.stats).toMatchObject({ rolledBack: 2 });
    expect(await liveBranches(p)).toBe(0);
    const gone = await owner.query<{ delete_reason: string }>(
      `SELECT delete_reason FROM platform.branch WHERE company_id = $1 AND code LIKE $2`,
      [f.companyA1, `${p}%`],
    );
    expect(gone.rows).toHaveLength(2);
    expect(gone.rows[0]?.delete_reason).toContain('wrong file');
    await expect(run(() => service.rollback(job.id, 'again'))).rejects.toMatchObject({
      code: 'import_wrong_status',
    });
  });

  it('is all or nothing: one row the target refuses undoes the whole commit', async () => {
    const p = `F${randomUUID().slice(0, 2).toUpperCase().replace(/[0-9]/g, 'Q')}`;
    // Same code twice passes the preview (each row is fine alone) but breaks the unique code.
    const job = await previewed([`${p}A,One`, `${p}B,Two`, `${p}B,Duplicate`]);
    await ask(job.id);
    const result = await go(job.id);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('Row 3');
    expect(await liveBranches(p)).toBe(0);
    const after = await run(() => service.get(job.id));
    expect(after.status).toBe('failed');
    expect(JSON.stringify(after.stats)).toContain('Row 3');
    const results = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM integration.import_result WHERE import_job_id = $1`,
      [job.id],
    );
    expect(results.rows[0]?.n).toBe('0');
  });

  it('cannot commit before a preview, nothing to import, or someone else’s job', async () => {
    const fresh = await run(async () =>
      service.createJob({
        entityKey: 'test_branch',
        fileObjectId: await upload('Code,Branch name\nb1,x\n'),
      }),
    );
    await expect(ask(fresh.id)).rejects.toMatchObject({ code: 'import_wrong_status' });
    const onlyBad = await run(() => service.preview(fresh.id, { mapping }));
    await expect(ask(onlyBad.id, true)).rejects.toMatchObject({ code: 'import_nothing_to_commit' });
    // Tenant B cannot see tenant A's job at all.
    const other: DbContext = { tenantId: f.tenantB, companyIds: [f.companyB1] };
    await expect(uow.runAs(other, () => service.get(fresh.id))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('runs through the queue and its worker', async () => {
    const p = `W${randomUUID().slice(0, 2).toUpperCase().replace(/[0-9]/g, 'Q')}`;
    const job = await previewed([`${p}A,One`]);
    await ask(job.id);
    queue.startWorker();
    await queue.enqueue({
      tenantId: f.tenantA,
      companyId: f.companyA1,
      userId: f.userA,
      jobId: job.id,
    });
    const deadline = Date.now() + 15_000;
    let status = '';
    while (Date.now() < deadline && status !== 'committed') {
      await new Promise((resolve) => setTimeout(resolve, 200));
      status = (await run(() => service.get(job.id))).status;
    }
    expect(status).toBe('committed');
    expect(await liveBranches(p)).toBe(1);
  });
});

describe('integrity', () => {
  it('keeps preview rows and results insert-only', async () => {
    const row = await owner.query<{ id: string }>(`SELECT id FROM integration.import_row LIMIT 1`);
    await expect(
      owner.query(`UPDATE integration.import_row SET errors = '[]' WHERE id = $1`, [
        row.rows[0]?.id,
      ]),
    ).rejects.toThrow();
    await expect(
      owner.query(`DELETE FROM integration.import_row WHERE id = $1`, [row.rows[0]?.id]),
    ).rejects.toThrow();
  });
});
