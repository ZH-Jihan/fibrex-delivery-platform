/**
 * Audit trail against a real PostgreSQL, connected as the restricted app role:
 *   - the database trigger records create, update, delete and restore with a field diff,
 *     through the repository and through raw SQL alike, and redacts secrets;
 *   - who/where is stamped from the transaction context and cannot be forged;
 *   - audit rows are append-only and isolated per tenant and company;
 *   - the sealing job builds a gap-free hash chain, and verification notices a changed or
 *     removed row;
 *   - the audit and recycle-bin endpoints work through the real Express app.
 *
 * Authentication arrives in commit 7. Here a test-only middleware sets the principal from
 * an `X-Test-As` header, and the permission check records what it was asked.
 */
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type { Branch } from '../../src/generated/prisma/client.js';
import { createAuditRouter } from '../../src/kernel/audit/audit-router.js';
import {
  createAuditService,
  type AuditEntry,
  type AuditPage,
  type ChainVerification,
} from '../../src/kernel/audit/audit-service.js';
import { RecycleBin } from '../../src/kernel/audit/recycle-bin.js';
import { sealAuditLog } from '../../src/kernel/audit/sealing-job.js';
import { loadEnv } from '../../src/kernel/config/env.js';
import { requireContext } from '../../src/kernel/context/request-context.js';
import { createPool, type Pool } from '../../src/kernel/db/pool.js';
import { createPrisma, type PrismaDb } from '../../src/kernel/db/prisma.js';
import { createRepository } from '../../src/kernel/db/repository.js';
import { UnitOfWork, type DbContext } from '../../src/kernel/db/unit-of-work.js';
import { ForbiddenError } from '../../src/kernel/http/errors.js';
import { createLogger } from '../../src/kernel/observability/logger.js';
import { createRedis } from '../../src/kernel/redis/client.js';
import { createFixture, type Fixture } from './fixtures.js';
import { connectionUrl } from './global-setup.js';
import { connect, inContext, sqlState, SQLSTATE, testDatabase } from './helpers.js';

let owner: pg.Client;
let superUser: pg.Client;
let appClient: pg.Client;
let pool: Pool;
let prisma: PrismaDb;
let uow: UnitOfWork;
let redis: Redis;
let app: Express;
let f: Fixture;

const audit = createAuditService();
const recycleBin = new RecycleBin();
const branches = createRepository<Branch>({ model: 'branch', scope: 'company' });

const asked: string[] = [];
let denied: string | undefined;

const ctxA1 = (): DbContext => ({
  tenantId: f.tenantA,
  companyIds: [f.companyA1],
  userId: f.userA,
  requestId: 'req-audit-test',
  ip: '203.0.113.7',
  roleKeys: ['admin', 'hr.manager'],
});
const ctxA2 = (): DbContext => ({
  tenantId: f.tenantA,
  companyIds: [f.companyA2],
  userId: f.userA,
});
const ctxB = (): DbContext => ({ tenantId: f.tenantB, companyIds: [f.companyB1], userId: f.userB });

const code = () => `T-${randomUUID().slice(0, 8)}`;
type Diff = Record<string, { old: unknown; new: unknown }>;
const diffOf = (entry: AuditEntry | undefined): Diff => (entry?.diff ?? {}) as Diff;

/** Creates, renames, deletes and restores a branch as user A in company A1. */
async function branchLifecycle(): Promise<Branch> {
  return uow.runAs(ctxA1(), async () => {
    const created = await branches.create({ code: code(), name: 'Old name' });
    const updated = await branches.update(created.id, created.version, { name: 'New name' });
    const deleted = await branches.softDelete(updated.id, updated.version, 'Opened by mistake');
    return branches.restore(deleted.id, deleted.version);
  });
}

const historyOf = (id: string, ctx: DbContext = ctxA1()): Promise<AuditPage> =>
  uow.runAs(ctx, () => audit.history('platform.branch', id, 1, 50));

const verifyAs = (ctx: DbContext): Promise<ChainVerification> =>
  uow.runAs(ctx, () => audit.verify());

beforeAll(async () => {
  owner = await connect('owner');
  superUser = await connect('superUser');
  appClient = await connect('app');
  f = await createFixture(owner);
  const db = testDatabase();
  pool = createPool(connectionUrl(db, db.app), 2);
  prisma = createPrisma(pool);
  uow = new UnitOfWork(prisma);
  redis = createRedis(inject('redisUrl'), 'fibrex-test-audit');

  recycleBin.register<Branch>({
    entityType: 'platform.branch',
    moduleKey: 'platform',
    label: 'Branch',
    repository: branches,
    describe: (row) => `${row.code} ${row.name}`,
  });

  app = createApp({
    env: loadEnv({
      DATABASE_URL: 'postgresql://unused@localhost:1/x',
      REDIS_URL: 'redis://localhost:1',
      RATE_LIMIT_ANONYMOUS: '10000',
    }),
    logger: createLogger({ level: 'silent', pretty: false, serviceName: 'test' }),
    redis,
    readinessChecks: [],
    mountApi: (api, registry) => {
      // Stand-in for authentication (commit 7).
      api.use((req, _res, next) => {
        const ctx = requireContext();
        const as = req.get('X-Test-As');
        if (as === 'a1') {
          ctx.principal = { kind: 'user', userId: f.userA, tenantId: f.tenantA };
          ctx.companyIds = [f.companyA1];
          ctx.roleKeys = ['admin'];
        } else if (as === 'b') {
          ctx.principal = { kind: 'user', userId: f.userB, tenantId: f.tenantB };
          ctx.companyIds = [f.companyB1];
        }
        next();
      });
      api.use(
        createAuditRouter({
          uow,
          registry,
          audit,
          recycleBin,
          authorize: (permission) => {
            asked.push(permission);
            if (permission === denied) throw new ForbiddenError();
          },
        }),
      );
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  await pool.end();
  await redis.quit();
  await appClient.end();
  await superUser.end();
  await owner.end();
});

const read = (url: string, as = 'a1') => request(app).get(`/api/v1${url}`).set('X-Test-As', as);

describe('data-change trigger', () => {
  it('records create, update, delete and restore with a field diff (repository path)', async () => {
    const branch = await branchLifecycle();
    const history = await historyOf(branch.id);
    // Newest first.
    expect(history.items.map((e) => e.action)).toEqual(['restore', 'delete', 'update', 'create']);
    const [restored, deleted, updated, created] = history.items;

    expect(diffOf(created).name).toEqual({ old: null, new: 'Old name' });
    expect(diffOf(created).company_id).toEqual({ old: null, new: f.companyA1 });
    // Stamp columns are noise and never appear in a diff.
    expect(Object.keys(diffOf(created))).not.toEqual(
      expect.arrayContaining(['version', 'created_at', 'updated_at']),
    );

    expect(diffOf(updated)).toEqual({ name: { old: 'Old name', new: 'New name' } });

    expect(Object.keys(diffOf(deleted)).sort()).toEqual([
      'delete_reason',
      'deleted_at',
      'deleted_by',
    ]);
    expect(diffOf(deleted).delete_reason).toEqual({ old: null, new: 'Opened by mistake' });
    expect(deleted?.meta).toEqual({ reason: 'Opened by mistake' });

    expect(diffOf(restored).delete_reason).toEqual({ old: 'Opened by mistake', new: null });
    expect(diffOf(restored).deleted_at?.new).toBeNull();
  });

  it('stamps who, from where and in which request from the transaction context', async () => {
    const branch = await branchLifecycle();
    const history = await historyOf(branch.id);
    for (const entry of history.items) {
      expect(entry).toMatchObject({
        userId: f.userA,
        impersonatorId: null,
        requestId: 'req-audit-test',
        ip: '203.0.113.7',
        roleKeys: ['admin', 'hr.manager'],
        companyId: f.companyA1,
        moduleKey: 'platform',
        entityType: 'platform.branch',
        entityId: branch.id,
        seq: null,
      });
    }
  });

  it('records the same four actions for raw SQL that bypasses the repository', async () => {
    await inContext(
      appClient,
      { tenantId: f.tenantA, companyIds: [f.companyA1], userId: f.userA },
      async (c) => {
        const id = randomUUID();
        await c.query(
          `INSERT INTO platform.branch (id, tenant_id, company_id, code, name) VALUES ($1, $2, $3, $4, 'Raw')`,
          [id, f.tenantA, f.companyA1, code()],
        );
        await c.query(`UPDATE platform.branch SET name = 'Raw 2' WHERE id = $1`, [id]);
        await c.query(
          `UPDATE platform.branch SET deleted_at = now(), delete_reason = 'raw' WHERE id = $1`,
          [id],
        );
        await c.query(
          `UPDATE platform.branch SET deleted_at = NULL, delete_reason = NULL WHERE id = $1`,
          [id],
        );
        const r = await c.query<{ action: string; user_id: string; diff: Diff }>(
          `SELECT action, user_id, diff FROM audit.audit_log
            WHERE entity_type = 'platform.branch' AND entity_id = $1 ORDER BY at`,
          [id],
        );
        expect(r.rows.map((x) => x.action)).toEqual(['create', 'update', 'delete', 'restore']);
        expect(r.rows.every((x) => x.user_id === f.userA)).toBe(true);
        expect(r.rows[1]?.diff).toEqual({ name: { old: 'Raw', new: 'Raw 2' } });
      },
    );
  });

  it('writes no audit row for an update that changes nothing', async () => {
    await inContext(
      appClient,
      { tenantId: f.tenantA, companyIds: [f.companyA1], userId: f.userA },
      async (c) => {
        await c.query(`UPDATE platform.branch SET name = name WHERE id = $1`, [f.branchA1]);
        const r = await c.query(
          `SELECT 1 FROM audit.audit_log WHERE entity_id = $1 AND action = 'update'`,
          [f.branchA1],
        );
        expect(r.rowCount).toBe(0);
      },
    );
  });

  it('redacts secret values but still shows that they changed', async () => {
    await inContext(appClient, { tenantId: f.tenantA, userId: f.userA }, async (c) => {
      const id = randomUUID();
      await c.query(
        `INSERT INTO iam.credential (id, tenant_id, user_id, hash) VALUES ($1, $2, $3, 'synthetic-hash-1')`,
        [id, f.tenantA, f.userA],
      );
      await c.query(`UPDATE iam.credential SET hash = 'synthetic-hash-2' WHERE id = $1`, [id]);
      const r = await c.query<{ action: string; diff: Diff; company_id: string | null }>(
        `SELECT action, diff, company_id FROM audit.audit_log WHERE entity_id = $1 ORDER BY at`,
        [id],
      );
      expect(r.rows.map((x) => x.action)).toEqual(['create', 'update']);
      expect(r.rows[0]?.diff.hash).toEqual({ old: null, new: '[redacted]' });
      expect(r.rows[1]?.diff).toEqual({ hash: { old: '[redacted]', new: '[redacted]' } });
      expect(JSON.stringify(r.rows)).not.toContain('synthetic-hash');
      // A tenant-level table: the audit row belongs to no company.
      expect(r.rows[0]?.company_id).toBeNull();
    });
  });
});

describe('audit_log integrity', () => {
  it('ignores a forged user, sequence number and request on insert', async () => {
    await inContext(appClient, { tenantId: f.tenantA, userId: f.userA }, async (c) => {
      const r = await c.query<{ user_id: string; seq: string | null; request_id: string | null }>(
        `INSERT INTO audit.audit_log (tenant_id, module_key, entity_type, action, user_id, seq, request_id)
         VALUES ($1, 'iam', 'iam.session', 'login', $2, 999, 'forged')
         RETURNING user_id, seq, request_id`,
        [f.tenantA, f.userB],
      );
      expect(r.rows[0]).toEqual({ user_id: f.userA, seq: null, request_id: null });
    });
  });

  it('refuses a backdated row', async () => {
    await inContext(appClient, { tenantId: f.tenantA, userId: f.userA }, async (c) => {
      expect(
        await sqlState(
          c.query(
            `INSERT INTO audit.audit_log (tenant_id, module_key, entity_type, action, at)
             VALUES ($1, 'iam', 'iam.session', 'login', clock_timestamp() - interval '1 hour')`,
            [f.tenantA],
          ),
        ),
      ).toBe(SQLSTATE.checkViolation);
    });
  });

  it('is append-only for the app role and for the owner role', async () => {
    await inContext(appClient, { tenantId: f.tenantA }, async (c) => {
      expect(await sqlState(c.query(`UPDATE audit.audit_log SET action = 'x1'`))).toBe(
        SQLSTATE.insufficientPrivilege,
      );
    });
    await inContext(appClient, { tenantId: f.tenantA }, async (c) => {
      expect(await sqlState(c.query(`DELETE FROM audit.audit_log`))).toBe(
        SQLSTATE.insufficientPrivilege,
      );
    });
    await inContext(owner, {}, async (c) => {
      expect(
        await sqlState(
          c.query(`UPDATE audit.audit_log SET action = 'x1' WHERE tenant_id = $1`, [f.tenantA]),
        ),
      ).toBe(SQLSTATE.insufficientPrivilege);
    });
    await inContext(owner, {}, async (c) => {
      // Even numbering a row is refused when anything else changes with it.
      expect(
        await sqlState(
          c.query(
            `UPDATE audit.audit_log SET seq = 1, action = 'x1' WHERE tenant_id = $1 AND seq IS NULL`,
            [f.tenantA],
          ),
        ),
      ).toBe(SQLSTATE.insufficientPrivilege);
    });
    await inContext(owner, {}, async (c) => {
      expect(
        await sqlState(c.query(`DELETE FROM audit.audit_log WHERE tenant_id = $1`, [f.tenantA])),
      ).toBe(SQLSTATE.insufficientPrivilege);
    });
  });

  it('the app role cannot write seals', async () => {
    await inContext(appClient, { tenantId: f.tenantA }, async (c) => {
      expect(
        await sqlState(
          c.query(
            `INSERT INTO audit.audit_seal (tenant_id, from_seq, to_seq, prev_hash, hash)
             VALUES ($1, 1, 1, sha256(''), sha256(''))`,
            [f.tenantA],
          ),
        ),
      ).toBe(SQLSTATE.insufficientPrivilege);
    });
  });

  it('isolates audit rows per tenant and per company', async () => {
    const branch = await branchLifecycle();
    expect((await historyOf(branch.id)).total).toBe(4);
    // Another tenant, and another company of the same tenant, see nothing of it.
    expect((await historyOf(branch.id, ctxB())).total).toBe(0);
    expect((await historyOf(branch.id, ctxA2())).total).toBe(0);

    // Tenant-level rows (here: the user account created by the fixture) are visible from
    // any company of that tenant, but never from another tenant.
    const userRows = (ctx: DbContext) =>
      uow.runAs(ctx, () => audit.history('iam.user_account', f.userA, 1, 10));
    expect((await userRows(ctxA2())).total).toBe(1);
    expect((await userRows(ctxB())).total).toBe(0);
  });
});

describe('AuditService.record', () => {
  it('writes a semantic event in the caller’s transaction', async () => {
    const sessionId = randomUUID();
    await uow.runAs(ctxA1(), () =>
      audit.record({
        action: 'login',
        moduleKey: 'iam',
        entityType: 'iam.session',
        entityId: sessionId,
        meta: { method: 'password' },
      }),
    );
    const page = await uow.runAs(ctxA1(), () =>
      audit.list({ action: 'login', entityId: sessionId }, 1, 10),
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      userId: f.userA,
      companyId: null,
      meta: { method: 'password' },
      ip: '203.0.113.7',
    });
  });

  it('rolls back with the transaction it belongs to', async () => {
    const sessionId = randomUUID();
    await expect(
      uow.runAs(ctxA1(), async () => {
        await audit.record({
          action: 'login',
          moduleKey: 'iam',
          entityType: 'iam.session',
          entityId: sessionId,
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const page = await uow.runAs(ctxA1(), () => audit.list({ entityId: sessionId }, 1, 10));
    expect(page.total).toBe(0);
  });
});

describe('hash-chain sealing', () => {
  const seals = (tenantId: string) =>
    owner.query<{ from_seq: string; to_seq: string; prev_hash: Buffer; hash: Buffer }>(
      `SELECT from_seq, to_seq, prev_hash, hash FROM audit.audit_seal
        WHERE tenant_id = $1 ORDER BY from_seq`,
      [tenantId],
    );

  it('numbers rows gap-free and links every seal to the previous one', async () => {
    await branchLifecycle();
    // A small batch, so tenant A needs several seals.
    const sealed = await sealAuditLog(prisma, 3);
    expect(sealed.filter((s) => s.tenantId === f.tenantA).length).toBeGreaterThan(1);

    const rows = await owner.query<{ seq: string | null }>(
      `SELECT seq FROM audit.audit_log WHERE tenant_id = $1 ORDER BY seq`,
      [f.tenantA],
    );
    expect(rows.rows.map((r) => Number(r.seq))).toEqual(rows.rows.map((_, i) => i + 1));

    const chain = (await seals(f.tenantA)).rows;
    expect(chain[0]?.prev_hash.equals(Buffer.alloc(32))).toBe(true);
    expect(Number(chain[0]?.from_seq)).toBe(1);
    for (let i = 1; i < chain.length; i += 1) {
      expect(chain[i]?.prev_hash.equals(chain[i - 1]?.hash ?? Buffer.alloc(0))).toBe(true);
      expect(Number(chain[i]?.from_seq)).toBe(Number(chain[i - 1]?.to_seq) + 1);
    }
    expect(Number(chain.at(-1)?.to_seq)).toBe(rows.rows.length);

    const result = await verifyAs(ctxA1());
    expect(result).toMatchObject({ ok: true, unsealedRows: 0, failure: null });
    expect(result.sealsChecked).toBe(chain.length);
    expect(result.rowsChecked).toBe(rows.rows.length);
  });

  it('continues the chain when new rows arrive, and does nothing when none did', async () => {
    const before = (await seals(f.tenantA)).rows;
    expect((await sealAuditLog(prisma)).filter((s) => s.tenantId === f.tenantA)).toEqual([]);

    await branchLifecycle();
    expect((await verifyAs(ctxA1())).unsealedRows).toBe(4);
    const sealed = (await sealAuditLog(prisma)).filter((s) => s.tenantId === f.tenantA);
    const last = Number(before.at(-1)?.to_seq);
    expect(sealed).toEqual([{ tenantId: f.tenantA, fromSeq: last + 1, toSeq: last + 4 }]);
    expect(await verifyAs(ctxA1())).toMatchObject({ ok: true, unsealedRows: 0 });
  });

  it('two sealing runs at once do not number a row twice', async () => {
    await branchLifecycle();
    await Promise.all([sealAuditLog(prisma, 2), sealAuditLog(prisma, 2)]);
    const dup = await owner.query(
      `SELECT seq FROM audit.audit_log WHERE tenant_id = $1 GROUP BY seq HAVING count(*) > 1`,
      [f.tenantA],
    );
    expect(dup.rowCount).toBe(0);
    expect(await verifyAs(ctxA1())).toMatchObject({ ok: true, unsealedRows: 0 });
  });

  it('verification notices a changed row and a removed row', async () => {
    // Tenant B is used so the damage does not disturb the other tests.
    await sealAuditLog(prisma);
    expect(await verifyAs(ctxB())).toMatchObject({ ok: true });

    // Only a superuser that switches the triggers off can do this at all.
    const tamper = async (sql: string, params: unknown[]) => {
      await superUser.query('BEGIN');
      await superUser.query(`SET LOCAL session_replication_role = replica`);
      await superUser.query(sql, params);
      await superUser.query('COMMIT');
    };

    await tamper(
      `UPDATE audit.audit_log SET meta = '{"edited": true}' WHERE tenant_id = $1 AND seq = 2`,
      [f.tenantB],
    );
    const changed = await verifyAs(ctxB());
    expect(changed).toMatchObject({ ok: false, failedFromSeq: 1 });
    expect(changed.failure).toMatch(/changed/);
    expect(changed.failedSealId).not.toBeNull();

    await tamper(`UPDATE audit.audit_log SET meta = NULL WHERE tenant_id = $1 AND seq = 2`, [
      f.tenantB,
    ]);
    expect(await verifyAs(ctxB())).toMatchObject({ ok: true });

    await tamper(`DELETE FROM audit.audit_log WHERE tenant_id = $1 AND seq = 2`, [f.tenantB]);
    const removed = await verifyAs(ctxB());
    expect(removed.ok).toBe(false);
    expect(removed.failure).toMatch(/missing/);
  });
});

describe('audit endpoints', () => {
  it('GET /audit-log filters and pages, newest first', async () => {
    const branch = await branchLifecycle();
    asked.length = 0;
    const res = await read(
      `/audit-log?entityType=platform.branch&entityId=${branch.id}&pageSize=3`,
    );
    expect(res.status).toBe(200);
    const page = res.body as AuditPage;
    expect(page.total).toBe(4);
    expect(page.items.map((e) => e.action)).toEqual(['restore', 'delete', 'update']);
    expect(asked).toEqual(['audit.log.read']);

    const updates = await read(`/audit-log?entityId=${branch.id}&action=update&module=platform`);
    expect((updates.body as AuditPage).items.map((e) => e.action)).toEqual(['update']);

    const byUser = await read(`/audit-log?entityId=${branch.id}&userId=${f.userB}`);
    expect((byUser.body as AuditPage).total).toBe(0);

    const future = await read(`/audit-log?entityId=${branch.id}&from=2999-01-01T00:00:00Z`);
    expect((future.body as AuditPage).total).toBe(0);

    // Another tenant sees nothing of it.
    const other = await read(`/audit-log?entityId=${branch.id}`, 'b');
    expect((other.body as AuditPage).total).toBe(0);
  });

  it('GET /history returns every change of one record', async () => {
    const branch = await branchLifecycle();
    const res = await read(`/history/platform.branch/${branch.id}`);
    expect(res.status).toBe(200);
    expect((res.body as AuditPage).items.map((e) => e.action)).toEqual([
      'restore',
      'delete',
      'update',
      'create',
    ]);
    expect((await read(`/history/not-a-type/${branch.id}`)).status).toBe(400);
  });

  it('GET /audit-log/export returns CSV and logs the export', async () => {
    const branch = await branchLifecycle();
    const res = await read(`/audit-log/export?entityId=${branch.id}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.text.trim().split('\r\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain('"at","seq","userId"');
    expect(lines[1]).toContain('"restore"');

    const logged = await owner.query<{ row_count: number; format: string; user_id: string }>(
      `SELECT row_count, format, user_id FROM audit.export_log
        WHERE tenant_id = $1 AND filters ->> 'entityId' = $2`,
      [f.tenantA, branch.id],
    );
    expect(logged.rows).toEqual([{ row_count: 4, format: 'csv', user_id: f.userA }]);
    const event = await read(`/audit-log?action=export&entityType=audit.audit_log&pageSize=1`);
    expect((event.body as AuditPage).items[0]?.meta).toMatchObject({ rowCount: 4, format: 'csv' });
  });

  it('GET /audit-log/verify reports the state of the chain', async () => {
    await sealAuditLog(prisma);
    const res = await read('/audit-log/verify');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, unsealedRows: 0, failure: null });
  });

  it('refuses when the permission layer says no, and rejects anonymous callers', async () => {
    denied = 'audit.log.export';
    try {
      expect((await read('/audit-log/export')).status).toBe(403);
    } finally {
      denied = undefined;
    }
    expect((await request(app).get('/api/v1/audit-log')).status).toBe(401);
  });

  it('documents its routes in the OpenAPI document', async () => {
    const res = await request(app).get('/api/v1/openapi.json');
    const paths = Object.keys((res.body as { paths: Record<string, unknown> }).paths);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/audit-log',
        '/audit-log/export',
        '/audit-log/verify',
        '/history/{entityType}/{entityId}',
        '/recycle-bin',
        '/recycle-bin/{entityType}/{id}/restore',
      ]),
    );
  });
});

describe('recycle bin', () => {
  interface Bin {
    types: { entityType: string; moduleKey: string; label: string; count: number }[];
    items: { id: string; description: string; deletedBy: string; deleteReason: string }[];
    total: number;
  }

  async function deletedBranch(): Promise<Branch> {
    return uow.runAs(ctxA1(), async () => {
      const created = await branches.create({ code: code(), name: 'Bin me' });
      return branches.softDelete(created.id, created.version, 'Duplicate');
    });
  }

  it('lists deleted records per type with who deleted them and why', async () => {
    const branch = await deletedBranch();
    asked.length = 0;

    const summary = (await read('/recycle-bin?module=platform')).body as Bin;
    expect(asked).toEqual(['recycle_bin.view']);
    expect(summary.types).toHaveLength(1);
    expect(summary.types[0]).toMatchObject({ entityType: 'platform.branch', label: 'Branch' });
    expect(summary.types[0]?.count).toBeGreaterThan(0);
    expect(summary.items).toEqual([]);
    expect(((await read('/recycle-bin?module=iam')).body as Bin).types).toEqual([]);

    const listed = (await read('/recycle-bin?entityType=platform.branch')).body as Bin;
    const item = listed.items.find((i) => i.id === branch.id);
    expect(item).toMatchObject({
      description: `${branch.code} Bin me`,
      deletedBy: f.userA,
      deleteReason: 'Duplicate',
    });

    // Another tenant does not see it; an unknown type is 404.
    const other = (await read('/recycle-bin?entityType=platform.branch', 'b')).body as Bin;
    expect(other.items.find((i) => i.id === branch.id)).toBeUndefined();
    expect((await read('/recycle-bin?entityType=platform.nothing')).status).toBe(404);
  });

  it('restores a record in one call, and the restore is audited', async () => {
    const branch = await deletedBranch();
    const restore = (as: string) =>
      request(app)
        .post(`/api/v1/recycle-bin/platform.branch/${branch.id}/restore`)
        .set('X-Test-As', as)
        .set('Idempotency-Key', randomUUID());

    // Another tenant cannot restore it, or even learn that it exists.
    expect((await restore('b')).status).toBe(404);

    const res = await restore('a1');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: branch.id, deletedAt: null, deleteReason: null });

    const live = await uow.runAs(ctxA1(), () => branches.get(branch.id));
    expect(live.deletedAt).toBeNull();
    const history = await historyOf(branch.id);
    expect(history.items[0]).toMatchObject({ action: 'restore', userId: f.userA });
    expect(history.items[0]?.roleKeys).toEqual(['admin']);

    // It is no longer in the bin.
    expect((await restore('a1')).status).toBe(404);
  });

  it('refuses a restore without the permission', async () => {
    const branch = await deletedBranch();
    denied = 'recycle_bin.restore';
    try {
      const res = await request(app)
        .post(`/api/v1/recycle-bin/platform.branch/${branch.id}/restore`)
        .set('X-Test-As', 'a1')
        .set('Idempotency-Key', randomUUID());
      expect(res.status).toBe(403);
    } finally {
      denied = undefined;
    }
  });
});
