/**
 * Kernel database layer against a real PostgreSQL, connected as the restricted app role:
 * the unit of work sets the row-level security context per transaction and never leaks it;
 * the soft-delete extension hides deleted rows and blocks physical deletes; the generic
 * CRUD router creates, reads, updates (with optimistic locking), soft-deletes and restores
 * a real table (platform.branch) through the real Express app.
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
import { z } from 'zod';
import { createApp } from '../../src/app.js';
import type { Branch } from '../../src/generated/prisma/client.js';
import { loadEnv } from '../../src/kernel/config/env.js';
import { requireContext } from '../../src/kernel/context/request-context.js';
import { createPool, type Pool } from '../../src/kernel/db/pool.js';
import { createPrisma, type PrismaDb } from '../../src/kernel/db/prisma.js';
import { createRepository } from '../../src/kernel/db/repository.js';
import { PhysicalDeleteError } from '../../src/kernel/db/soft-delete.js';
import { UnitOfWork, type DbContext } from '../../src/kernel/db/unit-of-work.js';
import { createCrudRouter } from '../../src/kernel/http/crud-router.js';
import { ForbiddenError } from '../../src/kernel/http/errors.js';
import { createLogger } from '../../src/kernel/observability/logger.js';
import { createRedis } from '../../src/kernel/redis/client.js';
import { createFixture, type Fixture } from './fixtures.js';
import { connect, testDatabase } from './helpers.js';
import { connectionUrl } from './global-setup.js';

let owner: pg.Client;
let pool: Pool;
let prisma: PrismaDb;
let uow: UnitOfWork;
let redis: Redis;
let app: Express;
let f: Fixture;

/** Permission keys the CRUD router asked for, and one key the test can deny. */
const asked: string[] = [];
let denied: string | undefined;

const branchItem = z
  .object({
    id: z.uuid(),
    companyId: z.uuid(),
    code: z.string(),
    name: z.string(),
    address: z.string().nullable(),
    version: z.number().int(),
  })
  .meta({ id: 'TestBranch' });

const ctxA1 = (): DbContext => ({
  tenantId: f.tenantA,
  companyIds: [f.companyA1],
  userId: f.userA,
});
const ctxB = (): DbContext => ({ tenantId: f.tenantB, companyIds: [f.companyB1], userId: f.userB });

beforeAll(async () => {
  owner = await connect('owner');
  f = await createFixture(owner);
  const db = testDatabase();
  // Two connections only, so tests would notice a context left behind on a pooled one.
  pool = createPool(connectionUrl(db, db.app), 2);
  prisma = createPrisma(pool);
  uow = new UnitOfWork(prisma);
  redis = createRedis(inject('redisUrl'), 'fibrex-test-db');

  const repository = createRepository<Branch>({ model: 'branch', scope: 'company' });
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
        } else if (as === 'a-both') {
          ctx.principal = { kind: 'user', userId: f.userA, tenantId: f.tenantA };
          ctx.companyIds = [f.companyA1, f.companyA2];
        } else if (as === 'b') {
          ctx.principal = { kind: 'user', userId: f.userB, tenantId: f.tenantB };
          ctx.companyIds = [f.companyB1];
        }
        next();
      });
      api.use(
        createCrudRouter<Branch>(
          {
            uow,
            registry,
            authorize: (permission) => {
              asked.push(permission);
              if (permission === denied) throw new ForbiddenError();
            },
          },
          {
            path: '/test-branches',
            resource: 'platform.branch',
            tag: 'Test branches',
            repository,
            schemas: {
              create: z.object({
                companyId: z.uuid().optional(),
                code: z.string().min(1),
                name: z.string().min(1),
                address: z.string().optional(),
              }),
              update: z.object({
                name: z.string().min(1).optional(),
                address: z.string().nullable().optional(),
              }),
              item: branchItem,
              filter: z.object({ code: z.string().optional() }),
            },
            toWhere: (filter) => (filter.code === undefined ? {} : { code: filter.code }),
            toItem: (row) => ({
              id: row.id,
              companyId: row.companyId,
              code: row.code,
              name: row.name,
              address: row.address,
              version: row.version,
            }),
          },
        ),
      );
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  await pool.end();
  await redis.quit();
  await owner.end();
});

/** A write request with the headers every write needs. */
function write(method: 'post' | 'patch' | 'delete', url: string, as = 'a1') {
  const agent = request(app);
  return agent[method](`/api/v1${url}`).set('X-Test-As', as).set('Idempotency-Key', randomUUID());
}
const read = (url: string, as = 'a1') => request(app).get(`/api/v1${url}`).set('X-Test-As', as);

interface Item {
  id: string;
  companyId: string;
  code: string;
  name: string;
  version: number;
}
const item = (res: request.Response): Item => res.body as Item;
const code = () => `T-${randomUUID().slice(0, 8)}`;

describe('unit of work', () => {
  it('shows only the rows of the tenant and companies in the context', async () => {
    const a1 = await uow.runAs(ctxA1(), (db) => db.branch.findMany());
    expect(a1.length).toBeGreaterThan(0);
    expect(a1.every((b) => b.tenantId === f.tenantA && b.companyId === f.companyA1)).toBe(true);

    const b = await uow.runAs(ctxB(), (db) => db.branch.findMany());
    expect(b.map((row) => row.id)).toEqual([f.branchB1]);
  });

  it('fails closed: a query outside a unit of work sees no tenant rows', async () => {
    // Use every pooled connection inside a context first, then query without one.
    await Promise.all([
      uow.runAs(ctxA1(), (db) => db.branch.count()),
      uow.runAs(ctxB(), (db) => db.branch.count()),
    ]);
    for (let i = 0; i < 4; i += 1) {
      expect(await prisma.branch.count()).toBe(0);
    }
  });

  it('keeps concurrent units of work apart', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        uow.runAs(i % 2 === 0 ? ctxA1() : ctxB(), async (db) => {
          const rows = await db.branch.findMany({ select: { tenantId: true } });
          return rows.every((r) => r.tenantId === (i % 2 === 0 ? f.tenantA : f.tenantB));
        }),
      ),
    );
    expect(results.every(Boolean)).toBe(true);
  });

  it('stamps created_by from the context and rolls everything back on error', async () => {
    const c = code();
    await expect(
      uow.runAs(ctxA1(), async (db) => {
        const row = await db.branch.create({
          data: { tenantId: f.tenantA, companyId: f.companyA1, code: c, name: 'Rollback' },
        });
        expect(row.createdBy).toBe(f.userA);
        expect(row.version).toBe(1);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const { rows } = await owner.query('SELECT 1 FROM platform.branch WHERE code = $1', [c]);
    expect(rows).toHaveLength(0);
  });

  it('joins the open transaction when nested, and refuses a different context', async () => {
    await uow.runAs(ctxA1(), async (outer) => {
      await uow.runAs(ctxA1(), (inner) => {
        expect(inner).toBe(outer);
        return Promise.resolve();
      });
      expect(() => uow.runAs(ctxB(), () => Promise.resolve())).toThrow(
        /different database context/,
      );
    });
  });

  it('refuses physical deletes', async () => {
    await expect(
      uow.runAs(ctxA1(), (db) => db.branch.delete({ where: { id: f.branchA1 } })),
    ).rejects.toThrow(PhysicalDeleteError);
  });
});

describe('CRUD router', () => {
  it('rejects anonymous requests with 401', async () => {
    const res = await request(app).get('/api/v1/test-branches');
    expect(res.status).toBe(401);
  });

  it('creates, reads and lists inside the caller company', async () => {
    const c = code();
    const created = await write('post', '/test-branches').send({ code: c, name: 'Depot' });
    expect(created.status).toBe(201);
    expect(created.headers.etag).toBe('"1"');
    expect(item(created)).toMatchObject({ code: c, companyId: f.companyA1, version: 1 });
    expect(asked).toContain('platform.branch.create');

    const got = await read(`/test-branches/${item(created).id}`);
    expect(got.status).toBe(200);
    expect(got.headers.etag).toBe('"1"');

    const listed = await read(`/test-branches?code=${c}&pageSize=5`);
    expect(listed.body).toMatchObject({ total: 1, page: 1, pageSize: 5 });

    // Stamped by the database from the unit-of-work context.
    const { rows } = await owner.query<{ created_by: string; tenant_id: string }>(
      'SELECT created_by, tenant_id FROM platform.branch WHERE id = $1',
      [item(created).id],
    );
    expect(rows[0]).toEqual({ created_by: f.userA, tenant_id: f.tenantA });
  });

  it('hides other tenants and companies as 404 and cannot create into them', async () => {
    expect((await read(`/test-branches/${f.branchB1}`)).status).toBe(404);
    expect((await read(`/test-branches/${f.branchA2}`)).status).toBe(404);
    expect((await read(`/test-branches/${f.branchA1}`, 'b')).status).toBe(404);
    const patch = await write('patch', `/test-branches/${f.branchB1}`)
      .set('If-Match', '"1"')
      .send({ name: 'Hijack' });
    expect(patch.status).toBe(404);

    const other = await write('post', '/test-branches').send({
      companyId: f.companyB1,
      code: code(),
      name: 'Elsewhere',
    });
    expect(other.status).toBe(403);

    // With two companies in the session the request must say which one.
    const vague = await write('post', '/test-branches', 'a-both').send({ code: code(), name: 'X' });
    expect(vague.status).toBe(400);
    expect((vague.body as { code: string }).code).toBe('company_required');
    const named = await write('post', '/test-branches', 'a-both').send({
      companyId: f.companyA2,
      code: code(),
      name: 'Second company',
    });
    expect(named.status).toBe(201);
    expect(item(named).companyId).toBe(f.companyA2);
  });

  it('updates with the right version and answers 409 with a diff for a stale one', async () => {
    const created = await write('post', '/test-branches').send({ code: code(), name: 'First' });
    const id = item(created).id;

    const missing = await write('patch', `/test-branches/${id}`).send({ name: 'No version' });
    expect(missing.status).toBe(428);

    const first = await write('patch', `/test-branches/${id}`)
      .set('If-Match', '"1"')
      .send({ name: 'Second', address: 'Street 1' });
    expect(first.status).toBe(200);
    expect(first.headers.etag).toBe('"2"');
    expect(item(first)).toMatchObject({ name: 'Second', version: 2 });

    // Someone still holding version 1 tries to save.
    const stale = await write('patch', `/test-branches/${id}`)
      .set('If-Match', '"1"')
      .send({ name: 'Mine', address: 'Street 1' });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      code: 'version_conflict',
      expectedVersion: 1,
      currentVersion: 2,
      current: { id, name: 'Second', version: 2 },
      conflicts: [{ field: 'name', yours: 'Mine', current: 'Second' }],
    });
    // The conflict shows the mapped item, not raw columns.
    expect((stale.body as { current: object }).current).not.toHaveProperty('tenantId');

    // Nothing was written by the refused request.
    expect(item(await read(`/test-branches/${id}`))).toMatchObject({ name: 'Second', version: 2 });
  });

  it('lets only one of two simultaneous updates win', async () => {
    const created = await write('post', '/test-branches').send({ code: code(), name: 'Race' });
    const id = item(created).id;
    const attempts = await Promise.all(
      ['One', 'Two'].map((name) =>
        write('patch', `/test-branches/${id}`).set('If-Match', '"1"').send({ name }),
      ),
    );
    expect(attempts.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(item(await read(`/test-branches/${id}`)).version).toBe(2);
  });

  it('ignores system fields sent by the client and reports duplicates as 409', async () => {
    const c = code();
    const created = await write('post', '/test-branches').send({ code: c, name: 'Unique' });
    expect(created.status).toBe(201);
    const duplicate = await write('post', '/test-branches').send({ code: c, name: 'Again' });
    expect(duplicate.status).toBe(409);
    expect((duplicate.body as { code: string }).code).toBe('unique_conflict');
  });

  it('soft-deletes, keeps the row in the recycle bin, and restores it', async () => {
    const c = code();
    const created = await write('post', '/test-branches').send({ code: c, name: 'Temp' });
    const id = item(created).id;

    const stale = await write('delete', `/test-branches/${id}`).set('If-Match', '"9"');
    expect(stale.status).toBe(409);

    const deleted = await write('delete', `/test-branches/${id}`)
      .set('If-Match', '"1"')
      .send({ reason: 'Closed' });
    expect(deleted.status).toBe(204);

    // Gone for normal reads, but physically still there with who, when and why.
    expect((await read(`/test-branches/${id}`)).status).toBe(404);
    expect((await read(`/test-branches?code=${c}`)).body).toMatchObject({ total: 0 });
    const { rows } = await owner.query<{
      deleted_by: string;
      delete_reason: string;
      version: number;
    }>(
      'SELECT deleted_by, delete_reason, version FROM platform.branch WHERE id = $1 AND deleted_at IS NOT NULL',
      [id],
    );
    expect(rows[0]).toEqual({ deleted_by: f.userA, delete_reason: 'Closed', version: 2 });

    // A deleted row cannot be updated or deleted again.
    const again = await write('patch', `/test-branches/${id}`)
      .set('If-Match', '"2"')
      .send({ name: 'Z' });
    expect(again.status).toBe(404);

    const bin = await read(`/test-branches?deleted=true&code=${c}`);
    expect(bin.body).toMatchObject({ total: 1, items: [{ id, version: 2 }] });

    const restored = await write('post', `/test-branches/${id}/restore`).set('If-Match', '"2"');
    expect(restored.status).toBe(200);
    expect(item(restored)).toMatchObject({ id, version: 3 });
    expect((await read(`/test-branches/${id}`)).status).toBe(200);
    // Restoring a live row is a 404: there is nothing in the recycle bin with that id.
    const twice = await write('post', `/test-branches/${id}/restore`).set('If-Match', '"3"');
    expect(twice.status).toBe(404);
  });

  it('asks the permission layer and stops when it refuses', async () => {
    const created = await write('post', '/test-branches').send({ code: code(), name: 'Guarded' });
    denied = 'platform.branch.delete';
    try {
      const res = await write('delete', `/test-branches/${item(created).id}`).set(
        'If-Match',
        '"1"',
      );
      expect(res.status).toBe(403);
    } finally {
      denied = undefined;
    }
    expect((await read(`/test-branches/${item(created).id}`)).status).toBe(200);
    expect(asked).toEqual(
      expect.arrayContaining([
        'platform.branch.read',
        'platform.branch.create',
        'platform.branch.update',
        'platform.branch.delete',
        'platform.branch.restore',
      ]),
    );
  });

  it('validates ids and bodies and documents the routes', async () => {
    expect((await read('/test-branches/not-a-uuid')).status).toBe(400);
    expect((await write('post', '/test-branches').send({ name: 'No code' })).status).toBe(400);

    const doc = (await request(app).get('/api/v1/openapi.json')).body as {
      paths: Record<string, Record<string, { parameters?: { name: string; in: string }[] }>>;
    };
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/test-branches',
        '/test-branches/{id}',
        '/test-branches/{id}/restore',
      ]),
    );
    const headers = (doc.paths['/test-branches/{id}']?.patch?.parameters ?? [])
      .filter((p) => p.in === 'header')
      .map((p) => p.name);
    expect(headers).toEqual(expect.arrayContaining(['If-Match', 'Idempotency-Key']));
  });
});
