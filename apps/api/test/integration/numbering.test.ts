/**
 * Numbering service and sequences API (phase 2 row 2.2) against real PostgreSQL and Redis:
 * CRUD with pattern and reset checks, preview, gapless allocation under concurrency (row
 * lock), rollback without a gap, yearly and monthly resets, defaults, recycle bin.
 *
 * People (all invented), tenant A, company A1: alice super_admin, dave "user" with no
 * permissions.
 */
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { API_PREFIX, createApp } from '../../src/app.js';
import { createAuditRouter } from '../../src/kernel/audit/audit-router.js';
import { createAuditService } from '../../src/kernel/audit/audit-service.js';
import { RecycleBin } from '../../src/kernel/audit/recycle-bin.js';
import { AccessTokens } from '../../src/kernel/auth/access-token.js';
import { ApiKeyResolver } from '../../src/kernel/auth/api-keys.js';
import { createAuthRouter } from '../../src/kernel/auth/auth-router.js';
import { AuthService } from '../../src/kernel/auth/auth-service.js';
import { authenticate } from '../../src/kernel/auth/authenticate.js';
import { MfaFactors } from '../../src/kernel/auth/mfa.js';
import { hashPassword } from '../../src/kernel/auth/password-hasher.js';
import { loadEnv } from '../../src/kernel/config/env.js';
import { SecretBox } from '../../src/kernel/crypto/secret-box.js';
import { createPool, type Pool } from '../../src/kernel/db/pool.js';
import { createPrisma } from '../../src/kernel/db/prisma.js';
import { UnitOfWork, type DbContext } from '../../src/kernel/db/unit-of-work.js';
import { createLogger } from '../../src/kernel/observability/logger.js';
import {
  createNumberSequenceRepository,
  createNumberingRouter,
} from '../../src/kernel/numbering/numbering-router.js';
import { NumberingService } from '../../src/kernel/numbering/numbering-service.js';
import { syncPermissionCatalogue } from '../../src/kernel/permissions/catalogue.js';
import { PermissionService } from '../../src/kernel/permissions/permission-service.js';
import { createRedis } from '../../src/kernel/redis/client.js';
import { createFixture, type Fixture } from './fixtures.js';
import { connectionUrl } from './global-setup.js';
import { connect, testDatabase } from './helpers.js';
import { TEST_AUTH_ENV } from './test-env.js';

const PASSWORD = 'synthetic-pass-num-1';

let owner: pg.Client;
let pool: Pool;
let redis: Redis;
let f: Fixture;
let app: Express;
let uow: UnitOfWork;
let asAlice: DbContext;
const numbering = new NumberingService();
let slugA = '';
const ids = { dave: randomUUID(), superAdmin: randomUUID(), user: randomUUID() };

type Json = Record<string, unknown>;
const auth = (req: request.Test, token: string) => req.set('Authorization', `Bearer ${token}`);
const get = (path: string, token: string) => auth(request(app).get(`${API_PREFIX}${path}`), token);
const post = (path: string, token: string, body: Json = {}) =>
  auth(request(app).post(`${API_PREFIX}${path}`), token)
    .set('Idempotency-Key', randomUUID())
    .send(body);
const patch = (path: string, token: string, version: number, body: Json) =>
  auth(request(app).patch(`${API_PREFIX}${path}`), token)
    .set('Idempotency-Key', randomUUID())
    .set('If-Match', `"${String(version)}"`)
    .send(body);
const del = (path: string, token: string, version: number) =>
  auth(request(app).delete(`${API_PREFIX}${path}`), token)
    .set('Idempotency-Key', randomUUID())
    .set('If-Match', `"${String(version)}"`)
    .send({ reason: 'test clean-up' });

async function signIn(identifier: string): Promise<string> {
  const res = await request(app)
    .post(`${API_PREFIX}/auth/login`)
    .send({ tenant: slugA, identifier, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.body as { accessToken: string }).accessToken;
}

async function addUser(id: string, username: string, roleId: string) {
  await owner.query(
    `INSERT INTO iam.user_account (id, tenant_id, username, display_name, must_change_password)
     VALUES ($1, $2, $3, $4, false)
     ON CONFLICT (id) DO UPDATE SET must_change_password = false`,
    [id, f.tenantA, username, `${username} test`],
  );
  await owner.query(
    `INSERT INTO iam.credential (tenant_id, user_id, kind, hash) VALUES ($1, $2, 'password', $3)`,
    [f.tenantA, id, await hashPassword(PASSWORD)],
  );
  const membershipId = randomUUID();
  await owner.query(
    `INSERT INTO iam.company_membership (id, tenant_id, user_id, company_id, is_default)
     VALUES ($1, $2, $3, $4, true)`,
    [membershipId, f.tenantA, id, f.companyA1],
  );
  await owner.query(
    `INSERT INTO iam.membership_role (tenant_id, membership_id, role_id) VALUES ($1, $2, $3)`,
    [f.tenantA, membershipId, roleId],
  );
}

beforeAll(async () => {
  owner = await connect('owner');
  f = await createFixture(owner);
  const db = testDatabase();
  // Six connections so the concurrency test really runs transactions side by side.
  pool = createPool(connectionUrl(db, db.app), 6);
  redis = createRedis(inject('redisUrl'), 'fibrex-test-numbering');
  const prisma = createPrisma(pool);
  await syncPermissionCatalogue(prisma);
  const slug = await owner.query<{ slug: string }>(
    `SELECT slug FROM platform.tenant WHERE id = $1`,
    [f.tenantA],
  );
  slugA = slug.rows[0]?.slug ?? '';

  await owner.query(
    `INSERT INTO iam.role (id, tenant_id, key, name, is_builtin) VALUES
       ($1, $3, 'super_admin', 'Super Admin', true), ($2, $3, 'user', 'User', true)`,
    [ids.superAdmin, ids.user, f.tenantA],
  );
  await owner.query(
    `INSERT INTO iam.role_permission (tenant_id, role_id, permission_id)
     SELECT $1, $2, id FROM iam.permission`,
    [f.tenantA, ids.superAdmin],
  );
  await addUser(f.userA, 'alice', ids.superAdmin);
  await addUser(ids.dave, 'dave', ids.user);
  asAlice = { tenantId: f.tenantA, companyIds: [f.companyA1], userId: f.userA };

  const env = loadEnv({
    DATABASE_URL: 'postgresql://unused@localhost:1/x',
    REDIS_URL: 'redis://localhost:1',
    ...TEST_AUTH_ENV,
    RATE_LIMIT_ANONYMOUS: '10000',
    RATE_LIMIT_AUTHENTICATED: '10000',
    AUTH_RATE_LIMIT: '10000',
    WEB_BASE_URL: 'https://app.example.test',
  });
  const logger = createLogger({ level: 'silent', pretty: false, serviceName: 'test' });
  uow = new UnitOfWork(prisma);
  const tokens = new AccessTokens(env.AUTH_TOKEN_SECRET, env.AUTH_ACCESS_TTL_SECONDS);
  const mfa = new MfaFactors({
    box: new SecretBox(env.DATA_ENCRYPTION_KEY),
    tokenSecret: env.AUTH_TOKEN_SECRET,
    issuer: env.AUTH_TOTP_ISSUER,
  });
  const authService = new AuthService({
    prisma,
    uow,
    redis,
    tokens,
    mfa,
    messaging: { send: () => Promise.resolve() },
    logger,
    env,
  });
  const permissions = new PermissionService(uow);
  const apiKeys = new ApiKeyResolver({ prisma, uow, redis, logger });
  const recycleBin = new RecycleBin();
  recycleBin.register({
    entityType: 'platform.number_sequence',
    moduleKey: 'platform',
    label: 'Numbering sequence',
    repository: createNumberSequenceRepository(),
    describe: (s) => s.key,
  });
  app = createApp({
    env,
    logger,
    redis,
    readinessChecks: [],
    authenticate: authenticate({ tokens, redis, apiKeys }),
    mountApi: (api, registry) => {
      api.use(
        createAuthRouter({
          auth: authService,
          registry,
          redis,
          logger,
          env,
          cookiePath: `${API_PREFIX}/auth`,
        }),
      );
      api.use(createNumberingRouter({ uow, registry, permissions, numbering }));
      api.use(
        createAuditRouter({
          uow,
          registry,
          authorize: permissions.authorize,
          audit: createAuditService(),
          recycleBin,
        }),
      );
    },
  });
});

afterAll(async () => {
  const counters = await redis.keys('rl:*');
  if (counters.length > 0) await redis.del(...counters);
  await redis.quit();
  await pool.end();
  await owner.end();
});

interface Item {
  id: string;
  key: string;
  format: string;
  nextValue: number;
  sample: string;
  version: number;
}

describe('number sequences API', () => {
  it('creates, previews, checks patterns and reset rules, and needs the permission', async () => {
    const alice = await signIn('alice');
    const dave = await signIn('dave');
    expect((await get('/number-sequences', dave)).status).toBe(403);
    expect((await post('/number-sequences/preview', dave, { format: 'L{0000}' })).status).toBe(
      403,
    );

    const created = await post('/number-sequences', alice, { key: 'loan', format: 'L{0000}' });
    expect(created.status).toBe(201);
    const loan = created.body as Item;
    expect(loan.sample).toBe('L0001');
    expect(loan.nextValue).toBe(1);

    const list = await get('/number-sequences', alice);
    expect((list.body as { items: Item[] }).items.map((i) => i.key)).toContain('loan');
    expect((await get(`/number-sequences/${loan.id}/next`, alice)).body).toEqual({
      sample: 'L0001',
    });

    const year = String(new Date().getUTCFullYear());
    const preview = await post('/number-sequences/preview', alice, {
      format: 'INV-{YYYY}-{00000}',
      resetPolicy: 'yearly',
      nextValue: 42,
    });
    expect(preview.status).toBe(200);
    expect(preview.body).toEqual({ sample: `INV-${year}-00042` });

    const bad = await post('/number-sequences', alice, { key: 'bad', format: 'X{0000}{00}' });
    expect(bad.status).toBe(400);
    expect((bad.body as { errors: { path: string }[] }).errors[0]?.path).toBe('format');
    const yearly = await post('/number-sequences', alice, {
      key: 'bad',
      format: 'X{0000}',
      resetPolicy: 'yearly',
    });
    expect(yearly.status).toBe(400);
    expect((await post('/number-sequences', alice, { key: 'Loan', format: 'L{0000}' })).status).toBe(
      400,
    );
    expect((await post('/number-sequences', alice, { key: 'loan', format: 'L{0000}' })).status).toBe(
      409,
    );
  });

  it('raises but never lowers the next value, and the key cannot change', async () => {
    const alice = await signIn('alice');
    const created = await post('/number-sequences', alice, { key: 'quote', format: 'Q{000}' });
    const row = created.body as Item;
    const raised = await patch(`/number-sequences/${row.id}`, alice, row.version, {
      nextValue: 100,
    });
    expect(raised.status).toBe(200);
    expect((raised.body as Item).sample).toBe('Q100');
    const lowered = await patch(
      `/number-sequences/${row.id}`,
      alice,
      (raised.body as Item).version,
      { nextValue: 5 },
    );
    expect(lowered.status).toBe(422);
    expect((lowered.body as { code: string }).code).toBe('next_value_lowered');
    const renamed = await patch(`/number-sequences/${row.id}`, alice, 2, { key: 'other' });
    expect(renamed.status).toBe(400);
    // Changing only the reset policy is checked against the stored pattern.
    const reset = await patch(`/number-sequences/${row.id}`, alice, 2, { resetPolicy: 'yearly' });
    expect(reset.status).toBe(400);
  });

  it('refuses to recreate a deleted key; restoring keeps the counter', async () => {
    const alice = await signIn('alice');
    const created = await post('/number-sequences', alice, { key: 'receipt', format: 'R{0000}' });
    const row = created.body as Item;
    await uow.runAs(asAlice, () => numbering.allocate('receipt'));
    const current = (await get(`/number-sequences/${row.id}`, alice)).body as Item;
    expect(current.nextValue).toBe(2);
    expect((await del(`/number-sequences/${row.id}`, alice, current.version)).status).toBe(204);
    const again = await post('/number-sequences', alice, { key: 'receipt', format: 'R{0000}' });
    expect(again.status).toBe(409);
    expect((again.body as { code: string }).code).toBe('key_in_recycle_bin');
    const restored = await post(`/number-sequences/${row.id}/restore`, alice).set(
      'If-Match',
      `"${String(current.version + 1)}"`,
    );
    expect(restored.status).toBe(200);
    expect((restored.body as Item).sample).toBe('R0002');
  });
});

describe('numbering service', () => {
  it('allocates gapless, unique numbers under concurrency and keeps none on rollback', async () => {
    await uow.runAs(asAlice, () =>
      numbering.allocate('payslip', { defaults: { format: '{prefix}{number}', prefix: 'PS' } }),
    );
    const numbers = await Promise.all(
      Array.from({ length: 8 }, () =>
        uow.runAs(asAlice, async () => (await numbering.allocate('payslip')).number),
      ),
    );
    expect(new Set(numbers).size).toBe(8);
    expect([...numbers].sort()).toEqual(
      Array.from({ length: 8 }, (_, i) => `PS${String(i + 2).padStart(4, '0')}`),
    );
    // A failed transaction gives its number back: the next caller gets PS0010 again.
    await expect(
      uow.runAs(asAlice, async () => {
        await numbering.allocate('payslip');
        throw new Error('record insert failed');
      }),
    ).rejects.toThrow('record insert failed');
    expect((await uow.runAs(asAlice, () => numbering.allocate('payslip'))).number).toBe('PS0010');
    expect(await uow.runAs(asAlice, () => numbering.peek('payslip'))).toBe('PS0011');
  });

  it('restarts yearly and monthly sequences in a new period', async () => {
    const invoice = (date: string) =>
      uow.runAs(asAlice, async () =>
        (
          await numbering.allocate('invoice', {
            date: new Date(date),
            defaults: { format: 'INV-{YYYY}-{00000}', resetPolicy: 'yearly' },
          })
        ).number,
      );
    expect(await invoice('2025-02-01T00:00:00Z')).toBe('INV-2025-00001');
    expect(await invoice('2025-12-31T23:00:00Z')).toBe('INV-2025-00002');
    expect(await invoice('2026-01-01T00:00:00Z')).toBe('INV-2026-00001');

    const receipt = (date: string) =>
      uow.runAs(asAlice, async () =>
        (
          await numbering.allocate('cash_receipt', {
            date: new Date(date),
            defaults: { format: '{YY}{MM}-{000}', resetPolicy: 'monthly' },
          })
        ).number,
      );
    expect(await receipt('2026-03-05T00:00:00Z')).toBe('2603-001');
    expect(await receipt('2026-03-30T00:00:00Z')).toBe('2603-002');
    expect(await receipt('2026-04-01T00:00:00Z')).toBe('2604-001');
  });

  it('refuses an unknown key without defaults, and a bad default pattern', async () => {
    await expect(uow.runAs(asAlice, () => numbering.allocate('nope'))).rejects.toMatchObject({
      code: 'sequence_missing',
    });
    await expect(
      uow.runAs(asAlice, () =>
        numbering.allocate('nope', { defaults: { format: 'N{000}', resetPolicy: 'yearly' } }),
      ),
    ).rejects.toThrow('Default pattern for "nope"');
  });
});
