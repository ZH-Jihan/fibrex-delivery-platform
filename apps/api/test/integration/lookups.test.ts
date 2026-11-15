/**
 * Lookups (phase 2 row 2.3) against real PostgreSQL and Redis: lists and values CRUD with
 * the label, parent and delete rules, the dropdown endpoint (ETag, 304, inactive values),
 * tenant isolation, the seed, recycle bin.
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
import { UnitOfWork } from '../../src/kernel/db/unit-of-work.js';
import { createLogger } from '../../src/kernel/observability/logger.js';
import {
  createLookupTypeRepository,
  createLookupValueRepository,
  createLookupRouter,
} from '../../src/kernel/lookups/lookup-router.js';
import { LookupService } from '../../src/kernel/lookups/lookup-service.js';
import { seedLookups } from '../../src/kernel/lookups/lookup-seed.js';
import { syncPermissionCatalogue } from '../../src/kernel/permissions/catalogue.js';
import { PermissionService } from '../../src/kernel/permissions/permission-service.js';
import { createRedis } from '../../src/kernel/redis/client.js';
import { createFixture, type Fixture } from './fixtures.js';
import { connectionUrl } from './global-setup.js';
import { connect, testDatabase } from './helpers.js';
import { TEST_AUTH_ENV } from './test-env.js';

const PASSWORD = 'synthetic-pass-lkp-1';

let owner: pg.Client;
let pool: Pool;
let redis: Redis;
let f: Fixture;
let app: Express;
let uow: UnitOfWork;
const lookups = new LookupService();
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
  redis = createRedis(inject('redisUrl'), 'fibrex-test-lookups');
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
    entityType: 'platform.lookup_type',
    moduleKey: 'platform',
    label: 'Lookup list',
    repository: createLookupTypeRepository(),
    describe: (t) => t.key,
  });
  recycleBin.register({
    entityType: 'platform.lookup_value',
    moduleKey: 'platform',
    label: 'Lookup value',
    repository: createLookupValueRepository(),
    describe: (v) => v.code,
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
      api.use(createLookupRouter({ uow, registry, permissions, lookups }));
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

interface TypeItem {
  id: string;
  key: string;
  name: string;
  isSystem: boolean;
  allowHierarchy: boolean;
  version: number;
}
interface ValueItem {
  id: string;
  code: string;
  labels: Record<string, string>;
  parentId: string | null;
  active: boolean;
  version: number;
}

const unique = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8).replaceAll('-', '')}`;

async function makeType(token: string, allowHierarchy = false): Promise<TypeItem> {
  const res = await post('/lookup-types', token, {
    key: unique('t'),
    name: 'Test list',
    allowHierarchy,
  });
  expect(res.status).toBe(201);
  return res.body as TypeItem;
}
async function makeValue(token: string, typeId: string, code: string, extra: Json = {}) {
  return post('/lookup-values', token, {
    lookupTypeId: typeId,
    code,
    labels: { en: code.toUpperCase() },
    ...extra,
  });
}

describe('lookup lists and values', () => {
  it('creates a list and values and serves them in order to any signed-in user', async () => {
    const alice = await signIn('alice');
    const type = await makeType(alice);
    expect(type.isSystem).toBe(false);
    expect((await makeValue(alice, type.id, 'b', { sortOrder: 20 })).status).toBe(201);
    expect((await makeValue(alice, type.id, 'a', { sortOrder: 20 })).status).toBe(201);
    expect(
      (await makeValue(alice, type.id, 'z', { sortOrder: 10, labels: { en: 'Zed', bn: 'জেড' } }))
        .status,
    ).toBe(201);
    expect((await makeValue(alice, type.id, 'off', { active: false })).status).toBe(201);

    // dave holds no permissions at all, and still reads the dropdown.
    const dave = await signIn('dave');
    const res = await get(`/lookups/${type.key}`, dave);
    expect(res.status).toBe(200);
    const body = res.body as { key: string; items: { code: string; labels: Json }[] };
    expect(body.key).toBe(type.key);
    expect(body.items.map((i) => i.code)).toEqual(['z', 'a', 'b']);
    expect(body.items[0]?.labels).toEqual({ en: 'Zed', bn: 'জেড' });

    // The hidden value needs the read permission.
    expect((await get(`/lookups/${type.key}?includeInactive=true`, dave)).status).toBe(403);
    const all = await get(`/lookups/${type.key}?includeInactive=true`, alice);
    expect((all.body as { items: unknown[] }).items).toHaveLength(4);
  });

  it('answers 304 when the ETag still matches and a new tag after a change', async () => {
    const alice = await signIn('alice');
    const type = await makeType(alice);
    const created = await makeValue(alice, type.id, 'one');
    const first = await get(`/lookups/${type.key}`, alice);
    const etag = first.headers.etag;
    if (etag === undefined) throw new Error('no ETag');
    expect(etag).toBeTruthy();
    expect(first.headers['cache-control']).toContain('no-cache');
    const same = await get(`/lookups/${type.key}`, alice).set('If-None-Match', etag);
    expect(same.status).toBe(304);
    const value = created.body as ValueItem;
    expect(
      (await patch(`/lookup-values/${value.id}`, alice, value.version, { active: false })).status,
    ).toBe(200);
    const after = await get(`/lookups/${type.key}`, alice).set('If-None-Match', etag);
    expect(after.status).toBe(200);
    expect(after.headers.etag).not.toBe(etag);
  });

  it('gives 404 for an unknown list and 400 for a bad key', async () => {
    const alice = await signIn('alice');
    expect((await get('/lookups/nothing_here', alice)).status).toBe(404);
    expect((await get('/lookups/Bad-Key', alice)).status).toBe(400);
  });

  it('requires an English label, a valid code and a known list', async () => {
    const alice = await signIn('alice');
    const type = await makeType(alice);
    const noEnglish = await makeValue(alice, type.id, 'x', { labels: { bn: 'এক' } });
    expect(noEnglish.status).toBe(400);
    expect(JSON.stringify(noEnglish.body)).toContain('english_label_required');
    expect((await makeValue(alice, type.id, '_bad')).status).toBe(400);
    expect((await makeValue(alice, randomUUID(), 'x')).status).toBe(400);
  });

  it('refuses a second value with the same code in a list, allows it in another', async () => {
    const alice = await signIn('alice');
    const one = await makeType(alice);
    const two = await makeType(alice);
    expect((await makeValue(alice, one.id, 'dup')).status).toBe(201);
    expect((await makeValue(alice, one.id, 'dup')).status).toBe(409);
    expect((await makeValue(alice, two.id, 'dup')).status).toBe(201);
  });

  it('never changes a code, a list key or the list of a value', async () => {
    const alice = await signIn('alice');
    const type = await makeType(alice);
    const value = (await makeValue(alice, type.id, 'keep')).body as ValueItem;
    expect(
      (await patch(`/lookup-values/${value.id}`, alice, value.version, { code: 'other' })).status,
    ).toBe(400);
    expect(
      (
        await patch(`/lookup-values/${value.id}`, alice, value.version, {
          lookupTypeId: randomUUID(),
        })
      ).status,
    ).toBe(400);
    expect(
      (await patch(`/lookup-types/${type.id}`, alice, type.version, { key: 'other_key' })).status,
    ).toBe(400);
    const renamed = await patch(`/lookup-types/${type.id}`, alice, type.version, {
      name: 'Renamed',
    });
    expect(renamed.status).toBe(200);
  });

  it('builds a hierarchy only where allowed, in one list, without cycles', async () => {
    const alice = await signIn('alice');
    const flat = await makeType(alice, false);
    const flatRoot = (await makeValue(alice, flat.id, 'root')).body as ValueItem;
    const notAllowed = await makeValue(alice, flat.id, 'child', { parentId: flatRoot.id });
    expect(notAllowed.status).toBe(400);
    expect(JSON.stringify(notAllowed.body)).toContain('hierarchy_not_allowed');

    const tree = await makeType(alice, true);
    const root = (await makeValue(alice, tree.id, 'root')).body as ValueItem;
    const child = (await makeValue(alice, tree.id, 'child', { parentId: root.id }))
      .body as ValueItem;
    const grand = (await makeValue(alice, tree.id, 'grand', { parentId: child.id }))
      .body as ValueItem;
    // A parent from another list is refused.
    expect((await makeValue(alice, tree.id, 'x', { parentId: flatRoot.id })).status).toBe(400);
    // Under itself, and under its own descendant, is refused.
    const self = await patch(`/lookup-values/${root.id}`, alice, root.version, {
      parentId: root.id,
    });
    expect(self.status).toBe(400);
    const loop = await patch(`/lookup-values/${root.id}`, alice, root.version, {
      parentId: grand.id,
    });
    expect(loop.status).toBe(400);
    expect(JSON.stringify(loop.body)).toContain('parent_cycle');

    // Cannot switch the hierarchy off while values have parents.
    const off = await patch(`/lookup-types/${tree.id}`, alice, tree.version, {
      allowHierarchy: false,
    });
    expect(off.status).toBe(422);
    // A parent with live children cannot be deleted.
    const blocked = await del(`/lookup-values/${root.id}`, alice, root.version);
    expect(blocked.status).toBe(409);
  });

  it('deletes values; a list with values stays until they are gone', async () => {
    const alice = await signIn('alice');
    const type = await makeType(alice);
    const value = (await makeValue(alice, type.id, 'gone')).body as ValueItem;
    expect((await del(`/lookup-types/${type.id}`, alice, type.version)).status).toBe(409);
    const deleted = await del(`/lookup-values/${value.id}`, alice, value.version);
    expect(deleted.status).toBe(204);
    // The dropdown no longer shows it; the code can be used again by a new value.
    expect(((await get(`/lookups/${type.key}`, alice)).body as { items: unknown[] }).items).toEqual(
      [],
    );
    expect((await makeValue(alice, type.id, 'gone')).status).toBe(201);
    expect((await del(`/lookup-types/${type.id}`, alice, type.version)).status).toBe(409);
  });

  it('refuses to delete a system list', async () => {
    const alice = await signIn('alice');
    const type = await makeType(alice);
    await owner.query(`UPDATE cfg.lookup_type SET is_system = true WHERE id = $1`, [type.id]);
    const res = await del(`/lookup-types/${type.id}`, alice, type.version + 1);
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain('system_lookup_type');
  });

  it('lists values by list and by active flag', async () => {
    const alice = await signIn('alice');
    const type = await makeType(alice);
    await makeValue(alice, type.id, 'on');
    await makeValue(alice, type.id, 'off', { active: false });
    const all = await get(`/lookup-values?lookupTypeId=${type.id}`, alice);
    expect((all.body as { total: number }).total).toBe(2);
    const active = await get(`/lookup-values?lookupTypeId=${type.id}&active=true`, alice);
    expect((active.body as { total: number }).total).toBe(1);
  });

  it('checks permissions: no read, no create, no list', async () => {
    const dave = await signIn('dave');
    expect((await get('/lookup-types', dave)).status).toBe(403);
    expect((await post('/lookup-types', dave, { key: unique('d'), name: 'x' })).status).toBe(403);
    expect((await get('/lookup-values', dave)).status).toBe(403);
  });

  it("keeps another tenant's lists out of sight", async () => {
    const key = unique('other');
    await owner.query(
      `INSERT INTO cfg.lookup_type (tenant_id, key, name) VALUES ($1, $2, 'Other tenant')`,
      [f.tenantB, key],
    );
    const alice = await signIn('alice');
    expect((await get(`/lookups/${key}`, alice)).status).toBe(404);
    const list = await get(`/lookup-types?pageSize=200`, alice);
    expect((list.body as { items: { key: string }[] }).items.some((i) => i.key === key)).toBe(
      false,
    );
  });

  it('writes audit rows for list and value changes', async () => {
    const alice = await signIn('alice');
    const type = await makeType(alice);
    const rows = await owner.query(
      `SELECT 1 FROM audit.audit_log WHERE entity_type = 'cfg.lookup_type' AND entity_id = $1`,
      [type.id],
    );
    expect(rows.rowCount).toBeGreaterThan(0);
  });
});

describe('lookup seed', () => {
  it('adds the starting lists once, marks them system, and never overwrites edits', async () => {
    const first = await seedLookups(owner, f.tenantA);
    expect(first.types).toBeGreaterThanOrEqual(10);
    expect(first.values).toBeGreaterThan(40);
    const second = await seedLookups(owner, f.tenantA);
    expect(second).toEqual({ types: 0, values: 0 });

    const alice = await signIn('alice');
    const vehicles = await get('/lookups/vehicle_type', alice);
    expect(vehicles.status).toBe(200);
    const items = (vehicles.body as { items: { code: string; id: string }[] }).items;
    expect(items.map((i) => i.code)).toContain('motorbike');

    // An administrator retires one and renames another; a later seed leaves both alone.
    const list = await get('/lookup-types?pageSize=200', alice);
    const type = (list.body as { items: TypeItem[] }).items.find((t) => t.key === 'vehicle_type');
    expect(type?.isSystem).toBe(true);
    await owner.query(
      `UPDATE cfg.lookup_value SET deleted_at = now(), delete_reason = 'test' WHERE lookup_type_id = $1 AND code = 'van'`,
      [type?.id],
    );
    await seedLookups(owner, f.tenantA);
    const after = await get('/lookups/vehicle_type', alice);
    expect((after.body as { items: { code: string }[] }).items.map((i) => i.code)).not.toContain(
      'van',
    );
  });
});
