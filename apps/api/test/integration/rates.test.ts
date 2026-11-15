/**
 * Rate tables (phase 2 row 2.9b) against real PostgreSQL and Redis: table and row CRUD,
 * dimensions only added at the end, rows naming only table dimensions, resolve (most
 * specific row, effective dates), a new rate closing the open one, overlap refused, rows
 * that have started frozen except their end date, rate() inside a formula (evaluate, test
 * cases, activation), permissions.
 *
 * People (all invented), tenant A, company A1: alice super_admin, dave "user" with no
 * permissions. All rates are invented.
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
import { UnitOfWork } from '../../src/kernel/db/unit-of-work.js';
import { createFormulaRouter } from '../../src/kernel/formulas/formula-router.js';
import { FormulaService } from '../../src/kernel/formulas/formula-service.js';
import { createLogger } from '../../src/kernel/observability/logger.js';
import { syncPermissionCatalogue } from '../../src/kernel/permissions/catalogue.js';
import { PermissionService } from '../../src/kernel/permissions/permission-service.js';
import {
  createRateRouter,
  createRateRowRepository,
  createRateTableRepository,
} from '../../src/kernel/rates/rate-router.js';
import { RateService } from '../../src/kernel/rates/rate-service.js';
import { createRedis } from '../../src/kernel/redis/client.js';
import { createFixture, type Fixture } from './fixtures.js';
import { connectionUrl } from './global-setup.js';
import { connect, testDatabase } from './helpers.js';
import { TEST_AUTH_ENV } from './test-env.js';

const PASSWORD = 'synthetic-pass-rate-1';

let owner: pg.Client;
let pool: Pool;
let redis: Redis;
let f: Fixture;
let app: Express;
let slugA = '';
let alice = '';
let dave = '';
const ids = { dave: randomUUID(), superAdmin: randomUUID(), user: randomUUID() };

type Json = Record<string, unknown>;
const auth = (req: request.Test, token: string) => req.set('Authorization', `Bearer ${token}`);
const get = (path: string, token: string) => auth(request(app).get(`${API_PREFIX}${path}`), token);
const post = (path: string, token: string, body: Json = {}, version?: number) => {
  const req = auth(request(app).post(`${API_PREFIX}${path}`), token).set(
    'Idempotency-Key',
    randomUUID(),
  );
  if (version !== undefined) req.set('If-Match', `"${String(version)}"`);
  return req.send(body);
};
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

const DAY = 86_400_000;
const isoDay = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

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
  pool = createPool(connectionUrl(db, db.app), 4);
  redis = createRedis(inject('redisUrl'), 'fibrex-test-rates');
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
  const uow = new UnitOfWork(prisma);
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
    entityType: 'platform.rate_table',
    moduleKey: 'platform',
    label: 'Rate table',
    repository: createRateTableRepository(),
    describe: (t) => t.key,
  });
  recycleBin.register({
    entityType: 'platform.rate_table_row',
    moduleKey: 'platform',
    label: 'Rate',
    repository: createRateRowRepository(),
    describe: (r) => r.currency,
  });
  const rates = new RateService();
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
      api.use(
        createFormulaRouter({ uow, registry, permissions, formulas: new FormulaService(rates) }),
      );
      api.use(createRateRouter({ uow, registry, permissions, rates }));
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
  alice = await signIn('alice');
  dave = await signIn('dave');
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
  version: number;
  value?: string;
  validFrom?: string;
  validTo?: string | null;
  dimensions?: string[];
}

async function makeTable(key: string, dimensions = ['platform', 'profession']): Promise<Item> {
  const res = await post('/rate-tables', alice, { key, name: `Table ${key}`, dimensions });
  expect(res.status).toBe(201);
  return res.body as Item;
}

async function addRow(tableId: string, body: Json) {
  return post('/rate-table-rows', alice, { rateTableId: tableId, currency: 'QAR', ...body });
}

const resolve = (key: string, dims: Json, date: string) =>
  get(
    `/rate-tables/${key}/resolve?dims=${encodeURIComponent(JSON.stringify(dims))}&date=${date}`,
    alice,
  );

describe('rate tables', () => {
  it('only adds dimensions at the end and keeps the key', async () => {
    const table = await makeTable('rt_dims');
    const moved = await patch(`/rate-tables/${table.id}`, alice, table.version, {
      dimensions: ['profession', 'platform'],
    });
    expect(moved.status).toBe(400);
    expect(JSON.stringify(moved.body)).toContain('rate_dimensions_fixed');

    const added = await patch(`/rate-tables/${table.id}`, alice, table.version, {
      dimensions: ['platform', 'profession', 'zone'],
    });
    expect(added.status).toBe(200);
    expect((added.body as Item).dimensions).toEqual(['platform', 'profession', 'zone']);

    const rekey = await patch(`/rate-tables/${table.id}`, alice, (added.body as Item).version, {
      key: 'other',
    });
    expect(rekey.status).toBe(400);
  });

  it('resolves the most specific row in force on the day', async () => {
    const table = await makeTable('rt_resolve');
    expect(
      (
        await addRow(table.id, {
          dims: { profession: 'driver' },
          value: '18',
          validFrom: '2025-01-01',
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await addRow(table.id, {
          dims: { platform: 'p1', profession: 'driver' },
          value: '19.5',
          validFrom: '2025-01-01',
        })
      ).status,
    ).toBe(201);
    const unknown = await addRow(table.id, {
      dims: { colour: 'red' },
      value: '1',
      validFrom: '2025-01-01',
    });
    expect(unknown.status).toBe(400);
    expect(JSON.stringify(unknown.body)).toContain('rate_unknown_dimension');

    const general = await resolve(
      'rt_resolve',
      { platform: 'p2', profession: 'driver' },
      '2025-06-01',
    );
    expect(general.status).toBe(200);
    expect(general.body).toMatchObject({ value: '18.0000', currency: 'QAR' });

    const specific = await resolve(
      'rt_resolve',
      { platform: 'p1', profession: 'driver' },
      '2025-06-01',
    );
    expect((specific.body as { value: string }).value).toBe('19.5000');

    expect((await resolve('rt_resolve', { profession: 'driver' }, '2024-12-31')).status).toBe(404);
    expect((await resolve('rt_resolve', { profession: 'rider' }, '2025-06-01')).status).toBe(404);
    expect((await resolve('rt_resolve', { colour: 'red' }, '2025-06-01')).status).toBe(400);
  });

  it('a new rate closes the open one; the past stays frozen', async () => {
    const table = await makeTable('rt_dates');
    const old = (
      await addRow(table.id, {
        dims: { profession: 'rider' },
        value: '14',
        validFrom: '2025-01-01',
      })
    ).body as Item;

    // A new rate from a past day would rewrite days that have passed.
    const backdated = await addRow(table.id, {
      dims: { profession: 'rider' },
      value: '15',
      validFrom: '2025-06-01',
    });
    expect(backdated.status).toBe(422);
    expect((backdated.body as { code: string }).code).toBe('rate_row_closes_past');

    // From tomorrow: the open row is closed today.
    const next = await addRow(table.id, {
      dims: { profession: 'rider' },
      value: '15',
      validFrom: isoDay(1),
    });
    expect(next.status).toBe(201);
    const future = next.body as Item;
    const closed = (await get(`/rate-table-rows/${old.id}`, alice)).body as Item;
    expect(closed.validTo).toBe(isoDay(0));
    expect((await resolve('rt_dates', { profession: 'rider' }, isoDay(0))).body).toMatchObject({
      value: '14.0000',
    });
    expect((await resolve('rt_dates', { profession: 'rider' }, isoDay(1))).body).toMatchObject({
      value: '15.0000',
    });

    // Two rows for the same dims starting the same day are refused (nothing to close).
    const overlap = await addRow(table.id, {
      dims: { profession: 'rider' },
      value: '16',
      validFrom: isoDay(1),
    });
    expect(overlap.status).toBe(409);
    expect((overlap.body as { code: string }).code).toBe('rate_row_overlap');

    // A row that has started: value frozen, no delete, end date only forward of yesterday.
    const frozen = await patch(`/rate-table-rows/${old.id}`, alice, closed.version, {
      value: '99',
    });
    expect(frozen.status).toBe(422);
    expect((await del(`/rate-table-rows/${old.id}`, alice, closed.version)).status).toBe(422);
    const pastEnd = await patch(`/rate-table-rows/${old.id}`, alice, closed.version, {
      validTo: '2025-03-01',
    });
    expect(pastEnd.status).toBe(422);

    // A row that has not started can change and be deleted.
    const changed = await patch(`/rate-table-rows/${future.id}`, alice, future.version, {
      value: '15.25',
    });
    expect(changed.status).toBe(200);
    expect((changed.body as Item).value).toBe('15.2500');
    expect(
      (await del(`/rate-table-rows/${future.id}`, alice, (changed.body as Item).version)).status,
    ).toBe(204);

    // A table with live rows is not deleted.
    const t = (await get(`/rate-tables/${table.id}`, alice)).body as Item;
    expect((await del(`/rate-tables/${table.id}`, alice, t.version)).status).toBe(409);
  });

  it('needs permission', async () => {
    await makeTable('rt_perm');
    expect((await get('/rate-tables', dave)).status).toBe(403);
    expect((await get('/rate-tables/rt_perm/resolve?dims=%7B%7D', dave)).status).toBe(403);
  });
});

describe('rate() inside a formula', () => {
  it('evaluates with the rates of the day, lists them, and gates activation', async () => {
    const table = await makeTable('pay_rate_test', ['platform', 'profession']);
    await addRow(table.id, {
      dims: { profession: 'driver' },
      value: '14',
      validFrom: '2025-01-01',
    });
    await addRow(table.id, { dims: { profession: 'rider' }, value: '10', validFrom: '2025-01-01' });

    const formula = (
      await post('/formulas', alice, {
        key: 'pay.rate_test',
        name: 'Pay from the rate table',
        purpose: 'pay_component',
        returnType: 'decimal',
        inputSchema: { orders: { type: 'int' }, profession: { type: 'string' } },
      })
    ).body as Item;
    const created = await post('/formula-versions', alice, {
      formulaId: formula.id,
      expression: 'rate("pay_rate_test", {"profession": profession}) * orders',
      validFrom: '2025-02-01',
      testCases: [
        { name: 'driver', inputs: { orders: 300, profession: 'driver' }, expected: '4200' },
        { name: 'rider', inputs: { orders: 300, profession: 'rider' }, expected: '3000' },
      ],
    });
    expect(created.status).toBe(201);
    const version = created.body as Item;

    const tested = await post(`/formula-versions/${version.id}/test`, alice);
    expect((tested.body as { passed: boolean }).passed).toBe(true);
    expect(
      (await post(`/formula-versions/${version.id}/activate`, alice, {}, version.version)).status,
    ).toBe(200);

    const result = await post('/formulas/evaluate', alice, {
      formulaKey: 'pay.rate_test',
      date: '2025-03-31',
      inputs: { orders: 312, profession: 'driver' },
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      value: '4368',
      rates: [
        {
          table: 'pay_rate_test',
          dims: { profession: 'driver' },
          value: '14.0000',
          currency: 'QAR',
        },
      ],
    });

    // No rate for this profession: a clear 400, never a silent zero.
    const missing = await post('/formulas/evaluate', alice, {
      formulaKey: 'pay.rate_test',
      date: '2025-03-31',
      inputs: { orders: 1, profession: 'pilot' },
    });
    expect(missing.status).toBe(400);
    expect(JSON.stringify(missing.body)).toContain('No rate in force');

    // The table key must be written as text.
    const dynamic = await post('/formula-versions', alice, {
      formulaId: formula.id,
      expression: 'rate(profession, {}) * orders',
    });
    expect(dynamic.status).toBe(400);
    expect(JSON.stringify(dynamic.body)).toContain('formula_not_allowed');
  });
});
