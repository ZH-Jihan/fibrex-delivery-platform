/**
 * Entity and field definitions (phase 2 row 2.4) against real PostgreSQL and Redis: record
 * types and fields CRUD with their rules, draft and publish with versions, the generated
 * JSON Schema, server validation of record data (including lookup codes), built-in record
 * types, permissions, tenant isolation and audit.
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
import {
  createEntityDefinitionRepository,
  createEntityDefinitionRouter,
  createFieldDefinitionRepository,
} from '../../src/kernel/entities/entity-definition-router.js';
import { EntityDefinitionService } from '../../src/kernel/entities/entity-definition-service.js';
import { syncPermissionCatalogue } from '../../src/kernel/permissions/catalogue.js';
import { PermissionService } from '../../src/kernel/permissions/permission-service.js';
import { createRedis } from '../../src/kernel/redis/client.js';
import { createFixture, type Fixture } from './fixtures.js';
import { connectionUrl } from './global-setup.js';
import { connect, testDatabase } from './helpers.js';
import { TEST_AUTH_ENV } from './test-env.js';

const PASSWORD = 'synthetic-pass-ent-1';

let owner: pg.Client;
let pool: Pool;
let redis: Redis;
let f: Fixture;
let app: Express;
let uow: UnitOfWork;
const lookups = new LookupService();
const entities = new EntityDefinitionService({
  lookups,
  systemEntities: () => [{ key: 'party.party', name: { en: 'People and organisations' } }],
});
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
  pool = createPool(connectionUrl(db, db.app), 6);
  redis = createRedis(inject('redisUrl'), 'fibrex-test-entities');
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
  recycleBin.register({
    entityType: 'platform.entity_definition',
    moduleKey: 'platform',
    label: 'Record type',
    repository: createEntityDefinitionRepository(entities),
    describe: (e) => e.key,
  });
  recycleBin.register({
    entityType: 'platform.field_definition',
    moduleKey: 'platform',
    label: 'Field of a record type',
    repository: createFieldDefinitionRepository(),
    describe: (x) => x.key,
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
      api.use(createEntityDefinitionRouter({ uow, registry, permissions, entities }));
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

interface EntityItem {
  id: string;
  key: string;
  kind: string;
  status: string;
  publishedVersion: number;
  hasUnpublishedChanges: boolean;
  jsonSchema: { required?: string[]; properties?: Record<string, Json> };
  version: number;
}
interface FieldItem {
  id: string;
  key: string;
  status: string;
  version: number;
}
interface Validation {
  valid: boolean;
  issues: { path: string; code: string }[];
}

const unique = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8).replaceAll('-', '')}`;
/** `field:code` of every issue, sorted: JSONB does not keep the order of schema properties. */
const codes = (res: { body: unknown }) =>
  (res.body as Validation).issues.map((i) => `${i.path}:${i.code}`).sort();

async function makeEntity(token: string, extra: Json = {}): Promise<EntityItem> {
  const res = await post('/entity-definitions', token, {
    key: unique('e'),
    name: { en: 'Vehicle inspection' },
    ...extra,
  });
  expect(res.status).toBe(201);
  return res.body as EntityItem;
}
const addField = (token: string, entityId: string, key: string, type: string, extra: Json = {}) =>
  post('/field-definitions', token, {
    entityDefinitionId: entityId,
    key,
    label: { en: key },
    type,
    ...extra,
  });
async function fresh(token: string, id: string): Promise<EntityItem> {
  return (await get(`/entity-definitions/${id}`, token)).body as EntityItem;
}
const publish = (token: string, entity: { id: string; version: number }) =>
  auth(request(app).post(`${API_PREFIX}/entity-definitions/${entity.id}/publish`), token)
    .set('Idempotency-Key', randomUUID())
    .set('If-Match', `"${String(entity.version)}"`)
    .send({});
/** A lookup list with the given codes; returns its id, key and values. */
async function makeList(token: string, values: string[]) {
  const list = await post('/lookup-types', token, { key: unique('l'), name: 'Test list' });
  expect(list.status).toBe(201);
  const { id, key } = list.body as { id: string; key: string };
  const made: Record<string, { id: string; version: number }> = {};
  for (const code of values) {
    const res = await post('/lookup-values', token, {
      lookupTypeId: id,
      code,
      labels: { en: code },
    });
    expect(res.status).toBe(201);
    made[code] = res.body as { id: string; version: number };
  }
  return { id, key, values: made };
}
async function expectCode(res: request.Test, status: number, code: string) {
  const done = await res;
  expect(done.status).toBe(status);
  expect(JSON.stringify(done.body)).toContain(code);
}

describe('record types: draft, publish and versions', () => {
  it('publishes a type with every field type and serves the generated schema', async () => {
    const alice = await signIn('alice');
    const list = await makeList(alice, ['pass', 'fail']);
    const entity = await makeEntity(alice);
    expect(entity).toMatchObject({ kind: 'custom', status: 'draft', publishedVersion: 0 });
    const fields: [string, string, Json][] = [
      ['plate', 'text', { required: true, sortOrder: 1, validations: { maxLength: 8 } }],
      ['odometer', 'number', { sortOrder: 2, validations: { min: 0 } }],
      ['cost', 'decimal', { sortOrder: 3, validations: { max: '5000.00', scale: 2 } }],
      ['inspected_on', 'date', { sortOrder: 4 }],
      ['result', 'dropdown', { sortOrder: 5, lookupTypeId: list.id }],
      ['faults', 'multi', { sortOrder: 6, lookupTypeId: list.id }],
      ['report', 'file', { sortOrder: 7 }],
      ['inspector', 'party_ref', { sortOrder: 8 }],
      ['previous', 'entity_ref', { sortOrder: 9, refEntityKey: entity.key }],
      ['passed', 'boolean', { sortOrder: 10 }],
    ];
    for (const [key, type, extra] of fields) {
      expect((await addField(alice, entity.id, key, type, extra)).status).toBe(201);
    }
    // Not published yet: users cannot see it.
    expect((await get(`/entities/${entity.key}`, alice)).status).toBe(404);

    const res = await publish(alice, await fresh(alice, entity.id));
    expect(res.status).toBe(200);
    const published = res.body as EntityItem;
    expect(published).toMatchObject({
      status: 'published',
      publishedVersion: 1,
      hasUnpublishedChanges: false,
    });
    expect(published.jsonSchema.required).toEqual(['plate']);
    expect(Object.keys(published.jsonSchema.properties ?? {}).sort()).toEqual(
      fields.map(([k]) => k).sort(),
    );
    expect(published.jsonSchema.properties?.result).toMatchObject({ 'x-lookup': list.key });
    expect(published.jsonSchema.properties?.previous).toMatchObject({
      'x-ref': 'entity',
      'x-ref-entity': entity.key,
    });

    const live = await get(`/entities/${entity.key}`, alice);
    expect(live.status).toBe(200);
    const body = live.body as { version: number; fields: { key: string; status: string }[] };
    expect(body.version).toBe(1);
    expect(body.fields).toHaveLength(10);
    expect(body.fields.every((x) => x.status === 'published')).toBe(true);
    const listed = await get(`/field-definitions?entityDefinitionId=${entity.id}`, alice);
    const items = (listed.body as { items: FieldItem[] }).items;
    expect(items.map((x) => x.key)).toEqual(fields.map(([k]) => k));
    expect(items.every((x) => x.status === 'published')).toBe(true);
  });

  it('keeps drafted changes away from users until the next publish', async () => {
    const alice = await signIn('alice');
    const entity = await makeEntity(alice);
    await addField(alice, entity.id, 'plate', 'text');
    const v1 = (await publish(alice, await fresh(alice, entity.id))).body as EntityItem;
    await expectCode(publish(alice, v1), 422, 'nothing_to_publish');

    const added = await addField(alice, entity.id, 'colour', 'text', { required: true });
    expect(added.status).toBe(201);
    const changed = await fresh(alice, entity.id);
    expect(changed.hasUnpublishedChanges).toBe(true);
    expect(changed.publishedVersion).toBe(1);
    const before = await get(`/entities/${entity.key}`, alice);
    expect((before.body as { fields: unknown[] }).fields).toHaveLength(1);
    const stillValid = await post(`/entities/${entity.key}/validate`, alice, {
      data: { plate: 'A1' },
    });
    expect((stillValid.body as Validation).valid).toBe(true);

    // A version read before the change is stale.
    expect((await publish(alice, v1)).status).toBe(409);
    const v2 = await publish(alice, changed);
    expect(v2.status).toBe(200);
    expect((v2.body as EntityItem).publishedVersion).toBe(2);
    const after = await post(`/entities/${entity.key}/validate`, alice, { data: { plate: 'A1' } });
    expect(codes(after)).toEqual(['colour:required']);

    const versions = await get(`/entity-definitions/${entity.id}/versions`, alice);
    const history = (versions.body as { items: { versionNo: number; publishedBy: string }[] })
      .items;
    expect(history.map((v) => v.versionNo)).toEqual([2, 1]);
    expect(history[0]?.publishedBy).toBe(f.userA);
    // Published versions are frozen: the database refuses to change one.
    await expect(
      owner.query(
        `UPDATE cfg.entity_definition_version SET version_no = 9 WHERE entity_definition_id = $1`,
        [entity.id],
      ),
    ).rejects.toThrow();
  });

  it('refuses to publish an empty type, a broken layout or a missing reference', async () => {
    const alice = await signIn('alice');
    const empty = await makeEntity(alice);
    await expectCode(publish(alice, empty), 422, 'no_fields');

    const layout = await makeEntity(alice, { listConfig: { columns: ['number', 'ghost'] } });
    await addField(alice, layout.id, 'plate', 'text');
    await expectCode(publish(alice, await fresh(alice, layout.id)), 400, 'ghost');
    const current = await fresh(alice, layout.id);
    const fixed = await patch(`/entity-definitions/${layout.id}`, alice, current.version, {
      listConfig: { columns: ['number', 'plate'] },
      formLayout: { sections: [{ title: { en: 'Main' }, fields: ['plate'] }] },
    });
    expect(fixed.status).toBe(200);
    expect((await publish(alice, fixed.body as EntityItem)).status).toBe(200);

    const ref = await makeEntity(alice);
    await addField(alice, ref.id, 'other', 'entity_ref', { refEntityKey: 'not_there_at_all' });
    await expectCode(publish(alice, await fresh(alice, ref.id)), 422, 'unknown_ref_entity');
  });
});

describe('field rules', () => {
  it('fixes key and type, checks lists, references, labels and validations', async () => {
    const alice = await signIn('alice');
    const list = await makeList(alice, ['a']);
    const entity = await makeEntity(alice);
    const field = (await addField(alice, entity.id, 'plate', 'text')).body as FieldItem;
    const fieldPath = `/field-definitions/${field.id}`;
    expect((await patch(fieldPath, alice, field.version, { key: 'x' })).status).toBe(400);
    expect((await patch(fieldPath, alice, field.version, { type: 'number' })).status).toBe(400);
    const current = await fresh(alice, entity.id);
    const rekey = await patch(`/entity-definitions/${entity.id}`, alice, current.version, {
      key: 'x',
    });
    expect(rekey.status).toBe(400);

    const add = (key: string, type: string, extra: Json = {}) =>
      addField(alice, entity.id, key, type, extra);
    await expectCode(add('a1', 'dropdown'), 400, 'lookup_type_required');
    await expectCode(add('a2', 'text', { lookupTypeId: list.id }), 400, 'lookup_type_not_allowed');
    await expectCode(
      add('a3', 'dropdown', { lookupTypeId: randomUUID() }),
      400,
      'unknown_lookup_type',
    );
    await expectCode(add('a4', 'entity_ref'), 400, 'ref_entity_required');
    await expectCode(add('a5', 'date', { refEntityKey: 'x' }), 400, 'ref_entity_not_allowed');
    await expectCode(add('a6', 'text', { label: { bn: 'x' } }), 400, 'english_label_required');
    await expectCode(
      add('a7', 'number', { validations: { maxLength: 3 } }),
      400,
      'invalid_validations',
    );
    await expectCode(
      add('a8', 'text', { validations: { pattern: '(a+)+' } }),
      400,
      'invalid_validations',
    );
    await expectCode(addField(alice, randomUUID(), 'a9', 'text'), 400, 'unknown_entity');
    expect((await add('plate', 'text')).status).toBe(409);
    expect((await add('Bad-Key', 'text')).status).toBe(400);
    await expectCode(
      patch(fieldPath, alice, field.version, { validations: { min: 1 } }),
      400,
      'invalid_validations',
    );
  });

  it('deletes only draft fields; a published field is retired and stays in the schema', async () => {
    const alice = await signIn('alice');
    const entity = await makeEntity(alice);
    await addField(alice, entity.id, 'plate', 'text', { required: true });
    const note = (await addField(alice, entity.id, 'note', 'text', { required: true }))
      .body as FieldItem;
    const draft = (await addField(alice, entity.id, 'scrap', 'text')).body as FieldItem;
    // A draft field cannot be given a status by hand, and can be deleted.
    await expectCode(
      patch(`/field-definitions/${draft.id}`, alice, draft.version, { status: 'retired' }),
      422,
      'field_not_published',
    );
    expect((await del(`/field-definitions/${draft.id}`, alice, draft.version)).status).toBe(204);
    expect((await publish(alice, await fresh(alice, entity.id))).status).toBe(200);

    const notePath = `/field-definitions/${note.id}`;
    const published = (await get(notePath, alice)).body as FieldItem;
    expect(published.status).toBe('published');
    await expectCode(del(notePath, alice, published.version), 422, 'field_in_use');

    const retired = await patch(notePath, alice, published.version, { status: 'retired' });
    expect(retired.status).toBe(200);
    const v2 = (await publish(alice, await fresh(alice, entity.id))).body as EntityItem;
    expect(v2.publishedVersion).toBe(2);
    expect(v2.jsonSchema.required).toEqual(['plate']);
    expect(v2.jsonSchema.properties?.note).toMatchObject({ 'x-retired': true });
    // Old data in the retired field is still accepted; it is no longer required.
    const check = await post(`/entities/${entity.key}/validate`, alice, {
      data: { plate: 'A1', note: 'old' },
    });
    expect((check.body as Validation).valid).toBe(true);
  });
});

describe('server validation of record data', () => {
  it('checks structure, limits and lookup codes against the published version', async () => {
    const alice = await signIn('alice');
    const list = await makeList(alice, ['pass', 'fail', 'old']);
    const entity = await makeEntity(alice);
    await addField(alice, entity.id, 'plate', 'text', {
      required: true,
      sortOrder: 1,
      validations: { maxLength: 8 },
    });
    await addField(alice, entity.id, 'cost', 'decimal', {
      sortOrder: 2,
      validations: { max: '5000.00', scale: 2 },
    });
    await addField(alice, entity.id, 'result', 'dropdown', { sortOrder: 3, lookupTypeId: list.id });
    await addField(alice, entity.id, 'faults', 'multi', { sortOrder: 4, lookupTypeId: list.id });
    expect((await publish(alice, await fresh(alice, entity.id))).status).toBe(200);
    const check = (data: unknown, previous?: Json) =>
      post(
        `/entities/${entity.key}/validate`,
        alice,
        previous === undefined ? { data } : { data, previous },
      );

    const good = await check({ plate: 'AB1234', cost: '250.50', result: 'pass', faults: ['fail'] });
    expect(good.status).toBe(200);
    expect(good.body).toEqual({ valid: true, issues: [] });
    const bad = await check({
      plate: 'TOO-LONG-PLATE',
      cost: '5000.01',
      result: 'maybe',
      faults: ['pass', 'nope'],
      extra: 1,
    });
    expect(codes(bad)).toEqual([
      'cost:maximum',
      'extra:unknown_field',
      'faults:unknown_lookup_value',
      'plate:max_length',
      'result:unknown_lookup_value',
    ]);
    expect(codes(await check({ cost: 12.5 }))).toEqual(['cost:type', 'plate:required']);
    expect(codes(await check('text'))).toEqual([':type']);

    // A retired lookup value is refused for new input but kept on a record that has it.
    const old = list.values.old ?? { id: '', version: 0 };
    const retire = await patch(`/lookup-values/${old.id}`, alice, old.version, { active: false });
    expect(retire.status).toBe(200);
    expect(codes(await check({ plate: 'A1', result: 'old' }))).toEqual([
      'result:unknown_lookup_value',
    ]);
    const kept = await check(
      { plate: 'A1', result: 'old', faults: ['old', 'pass'] },
      { result: 'old', faults: ['old'] },
    );
    expect(codes(kept)).toEqual([]);
    expect((await post('/entities/never_published/validate', alice, { data: {} })).status).toBe(
      404,
    );
  });
});

describe('built-in record types', () => {
  it('registers them per tenant, takes custom fields, and protects them', async () => {
    const alice = await signIn('alice');
    const list = await get('/entity-definitions?kind=system', alice);
    const system = (list.body as { items: (EntityItem & { permissionModuleKey: string })[] }).items;
    expect(system.map((e) => e.key)).toEqual(['party.party']);
    // Listing again does not create a second row.
    const again = await get('/entity-definitions?kind=system', alice);
    expect((again.body as { total: number }).total).toBe(1);
    const party = system[0];
    if (party === undefined) throw new Error('party.party was not registered');
    expect(party).toMatchObject({ kind: 'system', permissionModuleKey: 'party', status: 'draft' });

    const partyPath = `/entity-definitions/${party.id}`;
    await expectCode(del(partyPath, alice, party.version), 422, 'system_entity');
    await expectCode(
      patch(partyPath, alice, party.version, { name: { en: 'X' } }),
      422,
      'system_entity',
    );
    const dotted = await post('/entity-definitions', alice, {
      key: 'party.other',
      name: { en: 'X' },
    });
    expect(dotted.status).toBe(400);

    const added = await addField(alice, party.id, 'blood_group', 'text', {
      validations: { maxLength: 3 },
    });
    expect(added.status).toBe(201);
    expect((await publish(alice, await fresh(alice, party.id))).status).toBe(200);
    const check = await post('/entities/party.party/validate', alice, {
      data: { blood_group: 'AB+++' },
    });
    expect(codes(check)).toEqual(['blood_group:max_length']);
  });
});

describe('access, isolation, audit and delete', () => {
  it('needs permissions to build, but only sign-in to read a published type', async () => {
    const alice = await signIn('alice');
    const dave = await signIn('dave');
    const entity = await makeEntity(alice);
    await addField(alice, entity.id, 'plate', 'text');
    const ready = await fresh(alice, entity.id);
    expect((await get('/entity-definitions', dave)).status).toBe(403);
    expect((await get('/field-definitions', dave)).status).toBe(403);
    const create = await post('/entity-definitions', dave, { key: unique('d'), name: { en: 'x' } });
    expect(create.status).toBe(403);
    expect((await publish(dave, ready)).status).toBe(403);
    expect((await get(`/entity-definitions/${entity.id}/versions`, dave)).status).toBe(403);
    expect((await publish(alice, ready)).status).toBe(200);
    expect((await get(`/entities/${entity.key}`, dave)).status).toBe(200);
    expect((await request(app).get(`${API_PREFIX}/entities/${entity.key}`)).status).toBe(401);
  });

  it("keeps another tenant's record types out of sight", async () => {
    const key = unique('other');
    await owner.query(
      `INSERT INTO cfg.entity_definition (tenant_id, key, name, permission_module_key)
       VALUES ($1, $2, '{"en":"Other tenant"}', 'custom')`,
      [f.tenantB, key],
    );
    const alice = await signIn('alice');
    expect((await get(`/entities/${key}`, alice)).status).toBe(404);
    const list = await get('/entity-definitions?pageSize=200', alice);
    expect((list.body as { items: { key: string }[] }).items.some((i) => i.key === key)).toBe(
      false,
    );
  });

  it('audits changes, blocks deleting a referenced type, restores from the recycle bin', async () => {
    const alice = await signIn('alice');
    const target = await makeEntity(alice);
    const user = await makeEntity(alice);
    const link = (
      await addField(alice, user.id, 'link', 'entity_ref', { refEntityKey: target.key })
    ).body as FieldItem;
    const targetPath = `/entity-definitions/${target.id}`;
    await expectCode(del(targetPath, alice, target.version), 409, 'entity_definition_in_use');
    expect((await del(`/field-definitions/${link.id}`, alice, link.version)).status).toBe(204);
    expect((await del(targetPath, alice, target.version)).status).toBe(204);
    expect((await get(targetPath, alice)).status).toBe(404);
    const restored = await auth(request(app).post(`${API_PREFIX}${targetPath}/restore`), alice)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', `"${String(target.version + 1)}"`)
      .send({});
    expect(restored.status).toBe(200);
    const rows = await owner.query(
      `SELECT 1 FROM audit.audit_log WHERE entity_type = 'cfg.entity_definition' AND entity_id = $1`,
      [target.id],
    );
    expect(rows.rowCount).toBeGreaterThan(0);
  });
});
