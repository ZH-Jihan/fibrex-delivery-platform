/**
 * Formulas (phase 2 row 2.9a) against real PostgreSQL and Redis: formula and version CRUD,
 * compile checks on save, test cases, activation with effective dates (closing the version
 * in force), frozen versions, resolution by date, evaluate with trace, permissions.
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
import {
  createFormulaRepository,
  createFormulaRouter,
  createFormulaVersionRepository,
} from '../../src/kernel/formulas/formula-router.js';
import { FormulaService } from '../../src/kernel/formulas/formula-service.js';
import { createLogger } from '../../src/kernel/observability/logger.js';
import { syncPermissionCatalogue } from '../../src/kernel/permissions/catalogue.js';
import { PermissionService } from '../../src/kernel/permissions/permission-service.js';
import { createRedis } from '../../src/kernel/redis/client.js';
import { createFixture, type Fixture } from './fixtures.js';
import { connectionUrl } from './global-setup.js';
import { connect, testDatabase } from './helpers.js';
import { TEST_AUTH_ENV } from './test-env.js';

const PASSWORD = 'synthetic-pass-fml-1';

let owner: pg.Client;
let pool: Pool;
let redis: Redis;
let f: Fixture;
let app: Express;
let uow: UnitOfWork;
const formulas = new FormulaService();
let slugA = '';
let alice = '';
let dave = '';
const ids = { dave: randomUUID(), superAdmin: randomUUID(), user: randomUUID() };

type Json = Record<string, unknown>;
const auth = (req: request.Test, token: string) => req.set('Authorization', `Bearer ${token}`);
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
  redis = createRedis(inject('redisUrl'), 'fibrex-test-formulas');
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
    entityType: 'platform.formula',
    moduleKey: 'platform',
    label: 'Formula',
    repository: createFormulaRepository(),
    describe: (r) => r.key,
  });
  recycleBin.register({
    entityType: 'platform.formula_version',
    moduleKey: 'platform',
    label: 'Formula version',
    repository: createFormulaVersionRepository(),
    describe: (v) => String(v.versionNo),
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
      api.use(createFormulaRouter({ uow, registry, permissions, formulas }));
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
  status?: string;
  validFrom?: string;
  validTo?: string | null;
  checksum?: string;
  versionNo?: number;
}

const payInputs = {
  orders: { type: 'int', description: 'Delivered orders in the month' },
  rate: { type: 'decimal' },
  bonus: { type: 'decimal', default: '0' },
};

async function makeFormula(key: string): Promise<Item> {
  const res = await post('/formulas', alice, {
    key,
    name: 'Pay per order',
    purpose: 'pay_component',
    returnType: 'decimal',
    inputSchema: payInputs,
  });
  expect(res.status).toBe(201);
  return res.body as Item;
}

describe('formulas and versions', () => {
  it('checks expressions on save and keeps a checksum', async () => {
    const formula = await makeFormula('pay.per_order');

    const notAllowed = await post('/formula-versions', alice, {
      formulaId: formula.id,
      expression: 'double(orders) * 1.5',
    });
    expect(notAllowed.status).toBe(400);
    expect(JSON.stringify(notAllowed.body)).toContain('formula_not_allowed');

    const unknownName = await post('/formula-versions', alice, {
      formulaId: formula.id,
      expression: 'salary * 2',
    });
    expect(unknownName.status).toBe(400);
    expect(JSON.stringify(unknownName.body)).toContain('formula_type');

    const ok = await post('/formula-versions', alice, {
      formulaId: formula.id,
      expression: 'rate * orders + bonus',
      validFrom: '2026-01-01',
    });
    expect(ok.status).toBe(201);
    const version = ok.body as Item;
    expect(version.status).toBe('draft');
    expect(version.versionNo).toBe(1);
    expect(version.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('runs test cases, then activates and closes the version in force', async () => {
    const formula = await makeFormula('pay.activation');
    const v1 = (
      await post('/formula-versions', alice, {
        formulaId: formula.id,
        expression: 'rate * orders',
        validFrom: '2026-01-01',
      })
    ).body as Item;

    // No test cases yet: activation is refused.
    const none = await post(`/formula-versions/${v1.id}/activate`, alice, {}, v1.version);
    expect(none.status).toBe(422);
    expect((none.body as { code: string }).code).toBe('formula_no_test_cases');

    // A failing case blocks activation and the test run shows the actual value.
    const failing = await patch(`/formula-versions/${v1.id}`, alice, v1.version, {
      testCases: [{ name: 'March', inputs: { orders: 300, rate: '10' }, expected: '3001' }],
    });
    expect(failing.status).toBe(200);
    const run = await post(`/formula-versions/${v1.id}/test`, alice);
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ passed: false, results: [{ actual: '3000' }] });
    const blocked = await post(
      `/formula-versions/${v1.id}/activate`,
      alice,
      {},
      (failing.body as Item).version,
    );
    expect((blocked.body as { code: string }).code).toBe('formula_tests_failed');

    const fixed = await patch(`/formula-versions/${v1.id}`, alice, (failing.body as Item).version, {
      testCases: [{ name: 'March', inputs: { orders: 300, rate: '10' }, expected: '3000.00' }],
    });
    const active = await post(
      `/formula-versions/${v1.id}/activate`,
      alice,
      {},
      (fixed.body as Item).version,
    );
    expect(active.status).toBe(200);
    expect(active.body).toMatchObject({ status: 'active', validTo: null });

    // Frozen: no edits, no deletion.
    const edit = await patch(`/formula-versions/${v1.id}`, alice, (active.body as Item).version, {
      expression: 'rate * orders * 2',
    });
    expect(edit.status).toBe(422);
    expect((edit.body as { code: string }).code).toBe('formula_version_frozen');
    const remove = await del(`/formula-versions/${v1.id}`, alice, (active.body as Item).version);
    expect(remove.status).toBe(422);

    // Version 2 must start after version 1.
    const v2 = (
      await post('/formula-versions', alice, {
        formulaId: formula.id,
        expression: 'round(rate * orders * 1.1, 2)',
        validFrom: '2026-01-01',
        testCases: [{ name: 'April', inputs: { orders: 3, rate: '10.05' }, expected: '33.17' }],
      })
    ).body as Item;
    const early = await post(`/formula-versions/${v2.id}/activate`, alice, {}, v2.version);
    expect((early.body as { code: string }).code).toBe('formula_version_starts_too_early');
    const moved = await patch(`/formula-versions/${v2.id}`, alice, v2.version, {
      validFrom: '2026-04-01',
    });
    const on = await post(
      `/formula-versions/${v2.id}/activate`,
      alice,
      {},
      (moved.body as Item).version,
    );
    expect(on.status).toBe(200);

    const first = await auth(request(app).get(`${API_PREFIX}/formula-versions/${v1.id}`), alice);
    expect(first.body).toMatchObject({ status: 'retired', validTo: '2026-03-31' });

    // Resolution by date picks the version in force that day.
    const inputs = { orders: 3, rate: '10.05' };
    const march = await post('/formulas/evaluate', alice, {
      formulaKey: 'pay.activation',
      date: '2026-03-31',
      inputs,
    });
    expect(march.body).toMatchObject({ value: '30.15', versionNo: 1 });
    const april = await post('/formulas/evaluate', alice, {
      formulaKey: 'pay.activation',
      date: '2026-04-01',
      inputs,
    });
    expect(april.body).toMatchObject({ value: '33.17', versionNo: 2 });
    const before = await post('/formulas/evaluate', alice, {
      formulaKey: 'pay.activation',
      date: '2025-12-31',
      inputs,
    });
    expect(before.status).toBe(404);

    // The service gives the same answer inside a unit of work.
    const viaService = await uow.runAs(
      { tenantId: f.tenantA, companyIds: [f.companyA1], userId: f.userA },
      () => formulas.evaluate('pay.activation', new Date('2026-05-01'), inputs),
    );
    expect(viaService.value).toBe('33.17');

    // Rule 2: inputs used by a version cannot be removed; rule 6: no delete with versions.
    const current = await auth(request(app).get(`${API_PREFIX}/formulas/${formula.id}`), alice);
    const shrink = await patch(`/formulas/${formula.id}`, alice, (current.body as Item).version, {
      inputSchema: { orders: { type: 'int' } },
    });
    expect(shrink.status).toBe(400);
    expect(JSON.stringify(shrink.body)).toContain('formula_inputs_in_use');
    const returnType = await patch(
      `/formulas/${formula.id}`,
      alice,
      (current.body as Item).version,
      {
        returnType: 'int',
      },
    );
    expect(returnType.status).toBe(400);
    const gone = await del(`/formulas/${formula.id}`, alice, (current.body as Item).version);
    expect(gone.status).toBe(409);
  });
});

describe('evaluate', () => {
  it('previews an unsaved expression with the trace', async () => {
    const res = await post('/formulas/evaluate', alice, {
      expression: 'orders > 250 ? round(rate * orders * 1.05, 2) : rate * orders',
      inputSchema: { orders: { type: 'int' }, rate: { type: 'decimal' } },
      returnType: 'decimal',
      inputs: { orders: 260, rate: '14' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      value: '3822',
      inputs: { orders: '260', rate: '14' },
      formulaVersionId: null,
    });
    const steps = (res.body as { trace: { expression: string; value: unknown }[] }).trace;
    expect(steps.map((s) => s.expression)).toEqual([
      'orders > 250',
      'rate * orders',
      'rate * orders * 1.05',
      'round(rate * orders * 1.05, 2)',
      'orders > 250 ? round(rate * orders * 1.05, 2) : rate * orders',
    ]);
  });

  it('reports bad inputs as 400 and needs the evaluate permission', async () => {
    const bad = await post('/formulas/evaluate', alice, {
      expression: 'rate * 2',
      inputSchema: { rate: { type: 'decimal' } },
      returnType: 'decimal',
      inputs: { rate: 'lots' },
    });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain('formula_input');

    const forbidden = await post('/formulas/evaluate', dave, {
      expression: '1',
      returnType: 'int',
    });
    expect(forbidden.status).toBe(403);
    const list = await auth(request(app).get(`${API_PREFIX}/formulas`), dave);
    expect(list.status).toBe(403);
  });
});
