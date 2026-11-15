/**
 * Custom records API (phase 2 row 2.5) against real PostgreSQL and Redis: generic
 * `/records/{entityKey}` CRUD, per-type permissions created at publish, validation against
 * the published definition, gapless numbering, field filters, reference checks, links,
 * audit, recycle bin, and tenant and company isolation.
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
import { currentUnit, UnitOfWork } from '../../src/kernel/db/unit-of-work.js';
import { createEntityDefinitionRouter } from '../../src/kernel/entities/entity-definition-router.js';
import { EntityDefinitionService } from '../../src/kernel/entities/entity-definition-service.js';
import { createLookupRouter } from '../../src/kernel/lookups/lookup-router.js';
import { LookupService } from '../../src/kernel/lookups/lookup-service.js';
import { NumberingService } from '../../src/kernel/numbering/numbering-service.js';
import { createLogger } from '../../src/kernel/observability/logger.js';
import { createAccessAdminRouter } from '../../src/kernel/permissions/access-admin-router.js';
import { AccessAdminService } from '../../src/kernel/permissions/access-admin-service.js';
import { syncPermissionCatalogue } from '../../src/kernel/permissions/catalogue.js';
import { PermissionService } from '../../src/kernel/permissions/permission-service.js';
import { createRecordRouter } from '../../src/kernel/records/record-router.js';
import { PARTY_ENTITY_TYPE, RecordService } from '../../src/kernel/records/record-service.js';
import { createRedis } from '../../src/kernel/redis/client.js';
import { createFixture, type Fixture } from './fixtures.js';
import { connectionUrl } from './global-setup.js';
import { connect, testDatabase } from './helpers.js';
import { TEST_AUTH_ENV } from './test-env.js';

const PASSWORD = 'synthetic-pass-rec-1';

let owner: pg.Client;
let pool: Pool;
let redis: Redis;
let f: Fixture;
let app: Express;
let alice = '';
let dave = '';
let slugA = '';
const ids = {
  dave: randomUUID(),
  superAdmin: randomUUID(),
  user: randomUUID(),
  partyA1: randomUUID(),
  partyA2: randomUUID(),
};

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
const restore = (path: string, token: string, version: number) =>
  auth(request(app).post(`${API_PREFIX}${path}/restore`), token)
    .set('Idempotency-Key', randomUUID())
    .set('If-Match', `"${String(version)}"`)
    .send({});

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
  pool = createPool(connectionUrl(db, db.app), 6);
  redis = createRedis(inject('redisUrl'), 'fibrex-test-records');
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
  // Only the kernel's own keys: the keys of custom record types must come from publishing.
  await owner.query(
    `INSERT INTO iam.role_permission (tenant_id, role_id, permission_id)
     SELECT $1, $2, id FROM iam.permission WHERE module_key <> 'custom'`,
    [f.tenantA, ids.superAdmin],
  );
  await addUser(f.userA, 'alice', ids.superAdmin);
  await addUser(ids.dave, 'dave', ids.user);
  await owner.query(
    `INSERT INTO party.party (id, tenant_id, company_id, kind, display_name) VALUES
       ($1, $3, $4, 'person', 'Synthetic Person One'),
       ($2, $3, $5, 'person', 'Synthetic Person Two')`,
    [ids.partyA1, ids.partyA2, f.tenantA, f.companyA1, f.companyA2],
  );

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
  const admin = new AccessAdminService({ permissions });
  const apiKeys = new ApiKeyResolver({ prisma, uow, redis, logger });
  const lookups = new LookupService();
  const entities = new EntityDefinitionService({ lookups, systemEntities: () => [] });
  const records = new RecordService({
    entities,
    numbering: new NumberingService(),
    // Stands in for the party module's answer (main.ts wires the real one).
    referenceExists: async (entityType, id) => {
      if (entityType !== PARTY_ENTITY_TYPE) return undefined;
      const row = await currentUnit().db.party.findFirst({ where: { id }, select: { id: true } });
      return row !== null;
    },
  });
  const recycleBin = new RecycleBin();
  recycleBin.register({
    entityType: 'cfg.custom_record',
    moduleKey: 'custom',
    label: 'Custom record',
    repository: records.binRepository(),
    describe: (record) => record.number ?? record.id,
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
      api.use(createAccessAdminRouter({ uow, registry, permissions, admin, auth: authService }));
      api.use(createLookupRouter({ uow, registry, permissions, lookups }));
      api.use(createEntityDefinitionRouter({ uow, registry, permissions, entities }));
      api.use(createRecordRouter({ uow, registry, permissions, records }));
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

interface Entity {
  id: string;
  key: string;
  version: number;
}
interface RecordItem {
  id: string;
  number: string | null;
  data: Json;
  definitionVersion: number;
  partyId: string | null;
  branchId: string | null;
  companyId: string;
  version: number;
}
interface Page {
  items: RecordItem[];
  total: number;
}

const unique = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8).replaceAll('-', '')}`;
const issueCodes = (res: { body: unknown }) =>
  ((res.body as { errors?: { path: string; code: string }[] }).errors ?? [])
    .map((i) => `${i.path}:${i.code}`)
    .sort();

async function fresh(id: string): Promise<Entity> {
  return (await get(`/entity-definitions/${id}`, alice)).body as Entity;
}
async function publish(id: string): Promise<void> {
  const entity = await fresh(id);
  const res = await auth(request(app).post(`${API_PREFIX}/entity-definitions/${id}/publish`), alice)
    .set('Idempotency-Key', randomUUID())
    .set('If-Match', `"${String(entity.version)}"`)
    .send({});
  expect(res.status).toBe(200);
}
async function addField(entityId: string, key: string, type: string, extra: Json = {}) {
  const res = await post('/field-definitions', alice, {
    entityDefinitionId: entityId,
    key,
    label: { en: key },
    type,
    ...extra,
  });
  expect(res.status).toBe(201);
  return res.body as { id: string; version: number };
}
async function makeList(codes: string[]): Promise<string> {
  const list = await post('/lookup-types', alice, { key: unique('l'), name: 'Test list' });
  expect(list.status).toBe(201);
  const { id } = list.body as { id: string };
  for (const code of codes) {
    const res = await post('/lookup-values', alice, {
      lookupTypeId: id,
      code,
      labels: { en: code },
    });
    expect(res.status).toBe(201);
  }
  return id;
}

/** A published type: colour (text, required), seats, passed, tags (multi), owner (party). */
async function makeType(extra: Json = {}): Promise<Entity> {
  const created = await post('/entity-definitions', alice, {
    key: unique('veh'),
    name: { en: 'Vehicle inspection' },
    ...extra,
  });
  expect(created.status).toBe(201);
  const entity = created.body as Entity;
  await addField(entity.id, 'colour', 'text', { required: true });
  await addField(entity.id, 'seats', 'number');
  await addField(entity.id, 'passed', 'boolean');
  await addField(entity.id, 'tags', 'multi', { lookupTypeId: await makeList(['urgent', 'late']) });
  await addField(entity.id, 'owner', 'party_ref');
  await publish(entity.id);
  return fresh(entity.id);
}
async function makeRecord(key: string, data: Json, extra: Json = {}): Promise<RecordItem> {
  const res = await post(`/records/${key}`, alice, { data, ...extra });
  expect(res.status).toBe(201);
  return res.body as RecordItem;
}

describe('permissions of a custom record type', () => {
  it('exist only once the type is published, and go to the roles that may publish', async () => {
    const draft = await post('/entity-definitions', alice, {
      key: unique('veh'),
      name: { en: 'Draft type' },
    });
    const { id, key } = draft.body as Entity;
    await addField(id, 'colour', 'text');
    // Not published: no key exists yet, so even the administrator is refused.
    expect((await get(`/records/${key}`, alice)).status).toBe(403);

    await publish(id);
    expect((await get(`/records/${key}`, alice)).status).toBe(200);
    expect((await get(`/records/${key}`, dave)).status).toBe(403);
    expect((await post(`/records/${key}`, dave, { data: {} })).status).toBe(403);

    const keys = await owner.query<{ key: string }>(
      `SELECT key FROM iam.permission WHERE resource = $1 ORDER BY key`,
      [`custom.${key}`],
    );
    expect(keys.rows.map((r) => r.key)).toEqual(
      ['create', 'delete', 'read', 'restore', 'update'].map((a) => `custom.${key}.${a}`),
    );
  });

  it('are not handed back by a later publish once an administrator removed them', async () => {
    const type = await makeType();
    await owner.query(
      `UPDATE iam.role_permission SET deleted_at = now(), delete_reason = 'test'
       WHERE role_id = $1 AND permission_id =
         (SELECT id FROM iam.permission WHERE key = $2)`,
      [ids.superAdmin, `custom.${type.key}.delete`],
    );
    await addField(type.id, 'note', 'text');
    await publish(type.id);
    const record = await makeRecord(type.key, { colour: 'red' });
    expect((await del(`/records/${type.key}/${record.id}`, alice, record.version)).status).toBe(
      403,
    );
  });

  it('are listed in the catalogue for the tenant that owns the type only', async () => {
    const type = await makeType();
    // Tenant B defines its own type; its keys are in the same global catalogue.
    const foreign = unique('tb');
    await owner.query(
      `INSERT INTO cfg.entity_definition (tenant_id, key, name, permission_module_key)
       VALUES ($1, $2, '{"en": "Tenant B type"}', 'custom')`,
      [f.tenantB, foreign],
    );
    await owner.query(
      `INSERT INTO iam.permission (key, module_key, action, resource, description)
       VALUES ($1, 'custom', 'read', $2, 'View records')`,
      [`custom.${foreign}.read`, `custom.${foreign}`],
    );
    const res = await get('/permissions', alice);
    expect(res.status).toBe(200);
    const listed = JSON.stringify(res.body);
    expect(listed).toContain(`custom.${type.key}.read`);
    expect(listed).not.toContain(foreign);
  });
});

describe('creating and changing records', () => {
  it('checks the data against the published definition', async () => {
    const type = await makeType();
    const bad = await post(`/records/${type.key}`, alice, {
      data: { seats: 'four', tags: ['nope'], extra: 1 },
    });
    expect(bad.status).toBe(400);
    // Every problem is reported at once, so a form can mark all fields.
    expect(issueCodes(bad)).toEqual([
      'colour:required',
      'extra:unknown_field',
      'seats:type',
      'tags:unknown_lookup_value',
    ]);

    // A number typed by hand is refused: the body has no such property.
    const typed = await post(`/records/${type.key}`, alice, {
      data: { colour: 'red' },
      number: 'X-1',
    });
    expect(typed.status).toBe(400);

    const ok = await makeRecord(type.key, { colour: 'red', seats: 4, tags: ['urgent'], note: '' });
    expect(ok.data).toEqual({ colour: 'red', seats: 4, tags: ['urgent'] });
    expect(ok.companyId).toBe(f.companyA1);
    expect(ok.definitionVersion).toBe(1);
    expect(ok.number).toBeNull();
  });

  it('numbers records without gaps, and a failed save takes no number', async () => {
    const type = await makeType({ numberingKey: unique('seq') });
    const first = await makeRecord(type.key, { colour: 'red' });
    expect(first.number).toMatch(/^VEH-00001$/);
    // Refused by the party foreign key after the number was allocated: all rolled back.
    const failed = await post(`/records/${type.key}`, alice, {
      data: { colour: 'red' },
      partyId: randomUUID(),
    });
    expect(failed.status).toBe(409);
    const second = await makeRecord(type.key, { colour: 'blue' });
    expect(second.number).toBe('VEH-00002');

    // A deleted record keeps its number; the next one moves on.
    expect((await del(`/records/${type.key}/${second.id}`, alice, second.version)).status).toBe(
      204,
    );
    expect((await makeRecord(type.key, { colour: 'green' })).number).toBe('VEH-00003');
  });

  it('gives each of ten records created at once its own number', async () => {
    const type = await makeType({ numberingKey: unique('seq') });
    const made = await Promise.all(
      Array.from({ length: 10 }, () =>
        post(`/records/${type.key}`, alice, { data: { colour: 'x' } }),
      ),
    );
    expect(made.map((r) => r.status)).toEqual(Array.from({ length: 10 }, () => 201));
    const numbers = made.map((r) => (r.body as RecordItem).number).sort();
    expect(numbers).toEqual(
      Array.from({ length: 10 }, (_, i) => `VEH-${String(i + 1).padStart(5, '0')}`),
    );
  });

  it('merges a change into the stored data and locks on the version', async () => {
    const type = await makeType();
    const record = await makeRecord(type.key, { colour: 'red', seats: 4, passed: true });
    const path = `/records/${type.key}/${record.id}`;

    const noVersion = await auth(request(app).patch(`${API_PREFIX}${path}`), alice)
      .set('Idempotency-Key', randomUUID())
      .send({ data: { seats: 5 } });
    expect(noVersion.status).toBe(428);

    const changed = await patch(path, alice, record.version, { data: { seats: 5, passed: null } });
    expect(changed.status).toBe(200);
    expect((changed.body as RecordItem).data).toEqual({ colour: 'red', seats: 5 });
    expect(changed.headers.etag).toBe(`"${String(record.version + 1)}"`);

    const stale = await patch(path, alice, record.version, { data: { seats: 6 } });
    expect(stale.status).toBe(409);
    expect(JSON.stringify(stale.body)).toContain('version_conflict');

    // Clearing a required field is refused; the stored data is unchanged.
    const cleared = await patch(path, alice, record.version + 1, { data: { colour: '' } });
    expect(cleared.status).toBe(400);
    expect(issueCodes(cleared)).toEqual(['colour:required']);
    expect(((await get(path, alice)).body as RecordItem).data).toEqual({ colour: 'red', seats: 5 });
  });

  it('keeps a retired field as history and saves under the newest version', async () => {
    const created = await post('/entity-definitions', alice, {
      key: unique('veh'),
      name: { en: 'With a retired field' },
    });
    const type = created.body as Entity;
    await addField(type.id, 'colour', 'text');
    const old = await addField(type.id, 'old_note', 'text');
    await publish(type.id);
    const record = await makeRecord(type.key, { colour: 'red', old_note: 'kept' });

    const field = (await get(`/field-definitions/${old.id}`, alice)).body as { version: number };
    expect(
      (await patch(`/field-definitions/${old.id}`, alice, field.version, { status: 'retired' }))
        .status,
    ).toBe(200);
    await publish(type.id);

    const path = `/records/${type.key}/${record.id}`;
    const touched = await patch(path, alice, record.version, { data: { old_note: 'new' } });
    expect(touched.status).toBe(400);
    expect(issueCodes(touched)).toEqual(['old_note:retired_field']);
    const fresh_ = await post(`/records/${type.key}`, alice, { data: { old_note: 'x' } });
    expect(issueCodes(fresh_)).toEqual(['old_note:retired_field']);

    const saved = await patch(path, alice, record.version, { data: { colour: 'blue' } });
    expect(saved.status).toBe(200);
    expect((saved.body as RecordItem).data).toEqual({ colour: 'blue', old_note: 'kept' });
    expect((saved.body as RecordItem).definitionVersion).toBe(2);
  });

  it('accepts only references that exist and that the caller can see', async () => {
    const target = await makeType();
    const created = await post('/entity-definitions', alice, {
      key: unique('veh'),
      name: { en: 'With references' },
    });
    const type = created.body as Entity;
    await addField(type.id, 'owner', 'party_ref');
    await addField(type.id, 'vehicle', 'entity_ref', { refEntityKey: target.key });
    await addField(type.id, 'scan', 'file');
    await publish(type.id);
    const vehicle = await makeRecord(target.key, { colour: 'red' });
    const otherType = await makeRecord(type.key, {});

    const bad = await post(`/records/${type.key}`, alice, {
      data: {
        owner: ids.partyA2, // a party of company A2: outside alice's session
        vehicle: otherType.id, // a record, but of another type
        scan: randomUUID(), // nobody answers for files in this test: refused
      },
    });
    expect(bad.status).toBe(400);
    expect(issueCodes(bad)).toEqual([
      'owner:unknown_reference',
      'scan:unknown_reference',
      'vehicle:unknown_reference',
    ]);

    const ok = await makeRecord(
      type.key,
      { owner: ids.partyA1, vehicle: vehicle.id },
      { partyId: ids.partyA1, branchId: f.branchA1 },
    );
    expect(ok.partyId).toBe(ids.partyA1);
    expect(ok.branchId).toBe(f.branchA1);

    // The target is deleted later: the record can still be saved with the value it holds.
    expect((await del(`/records/${target.key}/${vehicle.id}`, alice, vehicle.version)).status).toBe(
      204,
    );
    const saved = await patch(`/records/${type.key}/${ok.id}`, alice, ok.version, {
      data: { owner: ids.partyA1 },
      partyId: null,
    });
    expect(saved.status).toBe(200);
    expect((saved.body as RecordItem).partyId).toBeNull();

    // A branch of another company fails its foreign key.
    const wrongBranch = await post(`/records/${type.key}`, alice, {
      data: {},
      branchId: f.branchA2,
    });
    expect(wrongBranch.status).toBe(409);
  });
});

describe('listing records', () => {
  it('filters by field values and by number, newest first', async () => {
    const type = await makeType({ numberingKey: unique('seq') });
    const a = await makeRecord(type.key, { colour: 'red', seats: 4, tags: ['urgent'] });
    const b = await makeRecord(type.key, { colour: 'red', seats: 2, passed: true });
    const c = await makeRecord(type.key, { colour: 'blue', seats: 4, tags: ['urgent', 'late'] });
    const list = async (query: string) => {
      const res = await get(`/records/${type.key}?${query}`, alice);
      expect(res.status).toBe(200);
      return (res.body as Page).items.map((r) => r.id);
    };

    expect(await list('')).toEqual([c.id, b.id, a.id]);
    expect(await list('f.colour=red')).toEqual([b.id, a.id]);
    expect(await list('f.colour=red&f.seats=4')).toEqual([a.id]);
    expect(await list('f.passed=true')).toEqual([b.id]);
    expect(await list('f.tags=late')).toEqual([c.id]);
    expect(await list('f.tags=urgent')).toEqual([c.id, a.id]);
    expect(await list(`number=${a.number ?? ''}`)).toEqual([a.id]);
    // The value is data, never part of the statement.
    expect(await list(`f.colour=${encodeURIComponent(`red' OR '1'='1`)}`)).toEqual([]);

    const paged = await get(`/records/${type.key}?f.seats=4&pageSize=1&page=2`, alice);
    expect((paged.body as Page).total).toBe(2);
    expect((paged.body as Page).items.map((r) => r.id)).toEqual([a.id]);

    const unknown = await get(`/records/${type.key}?f.nope=1`, alice);
    expect(unknown.status).toBe(400);
    expect(issueCodes(unknown)).toEqual(['f.nope:unknown_field']);
    expect((await get(`/records/${type.key}?f.seats=many`, alice)).status).toBe(400);
  });

  it('uses the GIN index for a field filter', async () => {
    // The table is small in a test, so the planner is told not to prefer reading it whole.
    await owner.query(`SET enable_seqscan = off`);
    const plan = await owner.query(
      `EXPLAIN SELECT id FROM cfg.custom_record WHERE data @> '{"colour": "red"}'::jsonb`,
    );
    await owner.query(`RESET enable_seqscan`);
    expect(JSON.stringify(plan.rows)).toContain('custom_record_data_idx');
  });

  it('shows a record only under its own type and its own company', async () => {
    const type = await makeType();
    const other = await makeType();
    const record = await makeRecord(type.key, { colour: 'red' });
    expect((await get(`/records/${other.key}/${record.id}`, alice)).status).toBe(404);
    expect(
      (await patch(`/records/${other.key}/${record.id}`, alice, record.version, { data: {} }))
        .status,
    ).toBe(404);
    expect((await del(`/records/${other.key}/${record.id}`, alice, record.version)).status).toBe(
      404,
    );

    // The same type has a record in company A2; alice's session is company A1.
    const hidden = randomUUID();
    await owner.query(
      `INSERT INTO cfg.custom_record (id, tenant_id, company_id, entity_definition_id,
                                      definition_version, data)
       VALUES ($1, $2, $3, $4, 1, '{"colour": "red"}')`,
      [hidden, f.tenantA, f.companyA2, type.id],
    );
    expect((await get(`/records/${type.key}/${hidden}`, alice)).status).toBe(404);
    const listed = (await get(`/records/${type.key}`, alice)).body as Page;
    expect(listed.total).toBe(1);
    expect(listed.items.map((r) => r.id)).toEqual([record.id]);

    // Unknown and built-in type keys.
    expect((await get(`/records/${unique('none')}`, alice)).status).toBe(403);
    expect((await get('/records/party.party', alice)).status).toBe(400);
  });
});

describe('delete, restore and history', () => {
  it('soft-deletes with a reason, lists in the recycle bin, restores, and is audited', async () => {
    const type = await makeType({ numberingKey: unique('seq') });
    const record = await makeRecord(type.key, { colour: 'red' });
    const path = `/records/${type.key}/${record.id}`;

    const noReason = await auth(request(app).delete(`${API_PREFIX}${path}`), alice)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', `"${String(record.version)}"`)
      .send({});
    expect(noReason.status).toBe(400);

    expect((await del(path, alice, record.version)).status).toBe(204);
    expect((await get(path, alice)).status).toBe(404);
    expect(((await get(`/records/${type.key}`, alice)).body as Page).total).toBe(0);
    const binned = (await get(`/records/${type.key}?deleted=true`, alice)).body as Page;
    expect(binned.items.map((r) => r.id)).toEqual([record.id]);

    const bin = await get('/recycle-bin?entityType=cfg.custom_record', alice);
    expect(bin.status).toBe(200);
    expect(JSON.stringify(bin.body)).toContain(record.number ?? 'missing');

    const back = await restore(path, alice, record.version + 1);
    expect(back.status).toBe(200);
    expect((await get(path, alice)).status).toBe(200);

    const log = await owner.query<{ action: string }>(
      `SELECT action FROM audit.audit_log
       WHERE entity_type = 'cfg.custom_record' AND entity_id = $1 ORDER BY at, id`,
      [record.id],
    );
    expect(log.rows.length).toBeGreaterThanOrEqual(3);

    // A type that has records cannot be deleted.
    const current = await fresh(type.id);
    const refused = await del(`/entity-definitions/${type.id}`, alice, current.version);
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain('entity_definition_in_use');
  });
});

describe('record links', () => {
  it('relates a record to other records and to a party', async () => {
    const type = await makeType();
    const a = await makeRecord(type.key, { colour: 'red' });
    const b = await makeRecord(type.key, { colour: 'blue' });
    const links = `/records/${type.key}/${a.id}/links`;

    const made = await post(links, alice, {
      relationKey: 'replaces',
      toEntityType: type.key,
      toId: b.id,
    });
    expect(made.status).toBe(201);
    const link = made.body as { id: string; version: number };
    const toParty = await post(links, alice, {
      relationKey: 'inspected_for',
      toEntityType: 'party.party',
      toId: ids.partyA1,
    });
    expect(toParty.status).toBe(201);

    const again = await post(links, alice, {
      relationKey: 'replaces',
      toEntityType: type.key,
      toId: b.id,
    });
    expect(again.status).toBe(409);
    const self = await post(links, alice, {
      relationKey: 'replaces',
      toEntityType: type.key,
      toId: a.id,
    });
    expect(issueCodes(self)).toEqual(['toId:self_link']);
    const missing = await post(links, alice, {
      relationKey: 'replaces',
      toEntityType: 'party.party',
      toId: ids.partyA2,
    });
    expect(issueCodes(missing)).toEqual(['toId:unknown_reference']);
    expect(
      (await post(links, dave, { relationKey: 'x', toEntityType: type.key, toId: b.id })).status,
    ).toBe(403);

    // Seen from both ends.
    const fromA = (await get(links, alice)).body as { items: { id: string }[] };
    expect(fromA.items).toHaveLength(2);
    const fromB = (await get(`/records/${type.key}/${b.id}/links`, alice)).body as {
      items: { id: string }[];
    };
    expect(fromB.items.map((l) => l.id)).toEqual([link.id]);

    expect((await del(`${links}/${link.id}`, alice, link.version)).status).toBe(204);
    expect(((await get(links, alice)).body as { items: unknown[] }).items).toHaveLength(1);
    // Removed, so the same relation can be made again.
    expect(
      (await post(links, alice, { relationKey: 'replaces', toEntityType: type.key, toId: b.id }))
        .status,
    ).toBe(201);
  });
});
