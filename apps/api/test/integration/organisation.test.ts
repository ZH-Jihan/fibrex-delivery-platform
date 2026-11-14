/**
 * Organisation API over HTTP against real PostgreSQL and Redis: companies (only your own,
 * settings change, base currency fixed) and branches (CRUD, one head office, recycle bin).
 *
 * People (all invented), tenant A with companies A1 (alice is a member) and A2 (not):
 *   alice  super_admin, dave  "user" with no permissions.
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
import { createLogger } from '../../src/kernel/observability/logger.js';
import { syncPermissionCatalogue } from '../../src/kernel/permissions/catalogue.js';
import { PermissionService } from '../../src/kernel/permissions/permission-service.js';
import {
  createBranchRepository,
  createOrganisationRouter,
} from '../../src/kernel/platform/organisation-router.js';
import { createRedis } from '../../src/kernel/redis/client.js';
import { createFixture, type Fixture } from './fixtures.js';
import { connectionUrl } from './global-setup.js';
import { connect, testDatabase } from './helpers.js';
import { TEST_AUTH_ENV } from './test-env.js';

const PASSWORD = 'synthetic-pass-org-1';

let owner: pg.Client;
let pool: Pool;
let redis: Redis;
let f: Fixture;
let app: Express;
let slugA = '';
const ids = { dave: randomUUID(), superAdmin: randomUUID(), user: randomUUID() };

type Json = Record<string, unknown>;
const auth = (req: request.Test, token: string) => req.set('Authorization', `Bearer ${token}`);
const get = (path: string, token: string) => auth(request(app).get(`${API_PREFIX}${path}`), token);
const post = (path: string, token: string, body: Json = {}, version?: number) =>
  auth(request(app).post(`${API_PREFIX}${path}`), token)
    .set('Idempotency-Key', randomUUID())
    .set('If-Match', `"${String(version ?? 1)}"`)
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
  pool = createPool(connectionUrl(db, db.app), 3);
  redis = createRedis(inject('redisUrl'), 'fibrex-test-organisation');
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
    entityType: 'platform.branch',
    moduleKey: 'platform',
    label: 'Branch',
    repository: createBranchRepository(),
    describe: (b) => b.code,
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
      api.use(createOrganisationRouter({ uow, registry, permissions }));
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

describe('companies', () => {
  it('lists only companies you are a member of, and refuses the rest', async () => {
    const alice = await signIn('alice');
    const list = await get('/companies', alice);
    expect(list.status).toBe(200);
    const items = (list.body as { items: { id: string }[] }).items;
    expect(items.map((c) => c.id)).toEqual([f.companyA1]); // A2 is in the tenant but not hers
    expect((await get(`/companies/${f.companyA2}`, alice)).status).toBe(404);
    expect((await patch(`/companies/${f.companyA2}`, alice, 1, { tradeName: 'x' })).status).toBe(
      404,
    );
  });

  it('changes settings, keeps the base currency, and needs the permission', async () => {
    const alice = await signIn('alice');
    const one = await get(`/companies/${f.companyA1}`, alice);
    const version = (one.body as { version: number }).version;
    const ok = await patch(`/companies/${f.companyA1}`, alice, version, {
      tradeName: 'Alpha',
      workingWeek: ['sun', 'mon', 'tue', 'wed', 'thu'],
      fiscalYearStartMonth: 4,
    });
    expect(ok.status).toBe(200);
    expect((ok.body as { fiscalYearStartMonth: number }).fiscalYearStartMonth).toBe(4);
    const currency = await patch(`/companies/${f.companyA1}`, alice, version + 1, {
      baseCurrency: 'USD',
    });
    expect(currency.status).toBe(400); // strict schema: not an editable field
    const stale = await patch(`/companies/${f.companyA1}`, alice, version, { tradeName: 'B' });
    expect(stale.status).toBe(409);
    const badZone = await patch(`/companies/${f.companyA1}`, alice, version + 1, {
      timeZone: 'Not/AZone',
    });
    expect(badZone.status).toBeGreaterThanOrEqual(400);

    const dave = await signIn('dave');
    expect((await get('/companies', dave)).status).toBe(403);
  });
});

describe('branches', () => {
  it('creates, edits, moves the head office, refuses to delete it, and restores', async () => {
    const alice = await signIn('alice');
    const made = await post('/branches', alice, { code: 'NORTH', name: 'North branch' });
    expect(made.status).toBe(201);
    const north = made.body as { id: string; version: number };
    const dup = await post('/branches', alice, { code: 'NORTH', name: 'Again' });
    expect(dup.status).toBe(409);

    // HQ (from the fixture) is not flagged; make North head office, then South: only one at a time.
    const head = await patch(`/branches/${north.id}`, alice, north.version, { isHeadOffice: true });
    expect(head.status).toBe(200);
    const south = (
      await post('/branches', alice, { code: 'SOUTH', name: 'South', isHeadOffice: true })
    ).body as { id: string; version: number };
    const heads = await owner.query(
      `SELECT code FROM platform.branch WHERE company_id = $1 AND is_head_office AND deleted_at IS NULL`,
      [f.companyA1],
    );
    expect(heads.rows).toEqual([{ code: 'SOUTH' }]);

    const refuse = await del(`/branches/${south.id}`, alice, south.version);
    expect(refuse.status).toBe(409);

    const northNow = (await get(`/branches/${north.id}`, alice)).body as { version: number };
    expect((await del(`/branches/${north.id}`, alice, northNow.version)).status).toBe(204);
    const bin = await get('/recycle-bin?entityType=platform.branch', alice);
    expect(bin.status).toBe(200);
    expect(JSON.stringify(bin.body)).toContain('NORTH');
    const deleted = await get('/branches?deleted=true', alice);
    const row = (deleted.body as { items: { id: string; version: number }[] }).items.find(
      (b) => b.id === north.id,
    );
    expect(row).toBeDefined();
    const restored = await post(`/branches/${north.id}/restore`, alice, {}, row?.version);
    expect(restored.status).toBe(200);
  });

  it('is hidden from a user without permission and from other companies', async () => {
    const dave = await signIn('dave');
    expect((await get('/branches', dave)).status).toBe(403);
    const alice = await signIn('alice');
    const items = ((await get('/branches', alice)).body as { items: { id: string }[] }).items;
    expect(items.map((b) => b.id)).not.toContain(f.branchA2);
  });
});
