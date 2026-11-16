/**
 * State machines (phase 2 row 2.10) against real PostgreSQL and Redis: configuration rules
 * (one machine per type, one initial state, nothing leaves a final state, states in use
 * kept), a new record starting in the initial state, moves checked for the allowed
 * transition, permission, required fields, reason and effective date, the insert-only
 * dated history, two people moving one record at once.
 *
 * People (all invented), tenant A, company A1: alice super_admin, carol "mover" (gets the
 * read and update permissions of each test type, nothing else), dave "user" with no
 * permissions.
 */
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { API_PREFIX, createApp } from '../../src/app.js';
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
import { createEntityDefinitionRouter } from '../../src/kernel/entities/entity-definition-router.js';
import { EntityDefinitionService } from '../../src/kernel/entities/entity-definition-service.js';
import { createLookupRouter } from '../../src/kernel/lookups/lookup-router.js';
import { LookupService } from '../../src/kernel/lookups/lookup-service.js';
import { NumberingService } from '../../src/kernel/numbering/numbering-service.js';
import { createLogger } from '../../src/kernel/observability/logger.js';
import { syncPermissionCatalogue } from '../../src/kernel/permissions/catalogue.js';
import { PermissionService } from '../../src/kernel/permissions/permission-service.js';
import { createRecordRouter } from '../../src/kernel/records/record-router.js';
import { RecordService } from '../../src/kernel/records/record-service.js';
import { createRedis } from '../../src/kernel/redis/client.js';
import { createStateRouter } from '../../src/kernel/states/state-router.js';
import { StateService, StateTargets } from '../../src/kernel/states/state-service.js';
import { createFixture, type Fixture } from './fixtures.js';
import { connectionUrl } from './global-setup.js';
import { connect, testDatabase } from './helpers.js';
import { TEST_AUTH_ENV } from './test-env.js';

const PASSWORD = 'synthetic-pass-state-1';

let owner: pg.Client;
let pool: Pool;
let redis: Redis;
let f: Fixture;
let app: Express;
let slugA = '';
let alice = '';
let carol = '';
let dave = '';
const ids = {
  carol: randomUUID(),
  dave: randomUUID(),
  superAdmin: randomUUID(),
  mover: randomUUID(),
  user: randomUUID(),
};

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
  redis = createRedis(inject('redisUrl'), 'fibrex-test-states');
  const prisma = createPrisma(pool);
  await syncPermissionCatalogue(prisma);
  const slug = await owner.query<{ slug: string }>(
    `SELECT slug FROM platform.tenant WHERE id = $1`,
    [f.tenantA],
  );
  slugA = slug.rows[0]?.slug ?? '';
  await owner.query(
    `INSERT INTO iam.role (id, tenant_id, key, name, is_builtin) VALUES
       ($1, $4, 'super_admin', 'Super Admin', true), ($2, $4, 'mover', 'Mover', false),
       ($3, $4, 'user', 'User', true)`,
    [ids.superAdmin, ids.mover, ids.user, f.tenantA],
  );
  await owner.query(
    `INSERT INTO iam.role_permission (tenant_id, role_id, permission_id)
     SELECT $1, $2, id FROM iam.permission`,
    [f.tenantA, ids.superAdmin],
  );
  await addUser(f.userA, 'alice', ids.superAdmin);
  await addUser(ids.carol, 'carol', ids.mover);
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
  const lookups = new LookupService();
  const entities = new EntityDefinitionService({ lookups, systemEntities: () => [] });
  const targets: StateTargets = new StateTargets((key) => records.stateTarget(key));
  const states = new StateService({ permissions, targets });
  const records: RecordService = new RecordService({
    entities,
    numbering: new NumberingService(),
    referenceExists: () => Promise.resolve(undefined),
    states,
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
      api.use(createRecordRouter({ uow, registry, permissions, records }));
      api.use(createStateRouter({ uow, registry, permissions, states }));
    },
  });
  alice = await signIn('alice');
  carol = await signIn('carol');
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
  code?: string;
  stateCode?: string | null;
}
interface HistoryEntry {
  fromCode: string | null;
  toCode: string;
  effectiveDate: string;
  reasonId: string | null;
  note: string | null;
  actorId: string | null;
}
interface Move {
  stateCode: string;
  history: HistoryEntry;
}

const unique = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8).replaceAll('-', '')}`;
const issueCodes = (res: { body: unknown }) =>
  ((res.body as { errors?: { path: string; code: string }[] }).errors ?? [])
    .map((i) => `${i.path}:${i.code}`)
    .sort();
const codeOf = (res: { body: unknown }) => (res.body as { code?: string }).code;

/** A published record type with fields plate (text) and seats (number); returns its key. */
async function makeType(): Promise<string> {
  const key = unique('veh');
  const created = await post('/entity-definitions', alice, {
    key,
    name: { en: 'Vehicle request' },
  });
  expect(created.status).toBe(201);
  const entity = created.body as Item;
  for (const [field, type] of [
    ['plate', 'text'],
    ['seats', 'number'],
  ] as const) {
    const res = await post('/field-definitions', alice, {
      entityDefinitionId: entity.id,
      key: field,
      label: { en: field },
      type,
    });
    expect(res.status).toBe(201);
  }
  const fresh = (await get(`/entity-definitions/${entity.id}`, alice)).body as Item;
  const published = await post(
    `/entity-definitions/${entity.id}/publish`,
    alice,
    {},
    fresh.version,
  );
  expect(published.status).toBe(200);
  // carol may see and change records of this type, and nothing else.
  await owner.query(
    `INSERT INTO iam.role_permission (tenant_id, role_id, permission_id)
     SELECT $1, $2, id FROM iam.permission WHERE key = ANY ($3)`,
    [f.tenantA, ids.mover, [`custom.${key}.read`, `custom.${key}.update`]],
  );
  return key;
}

async function makeMachine(entityKey: string): Promise<Item> {
  const res = await post('/state-machines', alice, { entityKey, name: `States of ${entityKey}` });
  expect(res.status).toBe(201);
  return res.body as Item;
}
async function addState(machineId: string, code: string, extra: Json = {}): Promise<Item> {
  const res = await post('/states', alice, {
    stateMachineId: machineId,
    code,
    labels: { en: code },
    ...extra,
  });
  expect(res.status).toBe(201);
  return res.body as Item;
}
const addTransition = (machineId: string, fromCode: string, toCode: string, extra: Json = {}) =>
  post('/state-transitions', alice, { stateMachineId: machineId, fromCode, toCode, ...extra });

/** draft (initial) -> submitted -> approved (final) | rejected (final); submitted -> draft. */
async function makeFlow(entityKey: string): Promise<Item> {
  const machine = await makeMachine(entityKey);
  await addState(machine.id, 'draft', { isInitial: true, sortOrder: 1 });
  await addState(machine.id, 'submitted', { category: 'active', sortOrder: 2 });
  await addState(machine.id, 'approved', { category: 'closed', isFinal: true, sortOrder: 3 });
  await addState(machine.id, 'rejected', { category: 'closed', isFinal: true, sortOrder: 4 });
  for (const [from, to] of [
    ['draft', 'submitted'],
    ['submitted', 'draft'],
  ] as const) {
    expect((await addTransition(machine.id, from, to)).status).toBe(201);
  }
  return machine;
}

async function makeRecord(key: string, data: Json = {}): Promise<Item> {
  const res = await post(`/records/${key}`, alice, { data });
  expect(res.status).toBe(201);
  return res.body as Item;
}
const move = (key: string, id: string, token: string, body: Json) =>
  post(`/transitions/${key}/${id}`, token, body);
const historyOf = async (key: string, id: string) =>
  ((await get(`/state-history/${key}/${id}`, alice)).body as { items: HistoryEntry[] }).items;

describe('state machine configuration', () => {
  it('keeps one machine per type, one initial state, and final states final', async () => {
    const key = unique('cfg');
    const machine = await makeMachine(key);
    expect((await post('/state-machines', alice, { entityKey: key, name: 'Again' })).status).toBe(
      409,
    );
    // Rule 1: the entity type never changes.
    expect(
      (await patch(`/state-machines/${machine.id}`, alice, machine.version, { entityKey: 'x' }))
        .status,
    ).toBe(400);

    const draft = await addState(machine.id, 'draft', { isInitial: true });
    const done = await addState(machine.id, 'done', { isFinal: true });
    const open = await addState(machine.id, 'open');
    const second = await post('/states', alice, {
      stateMachineId: machine.id,
      code: 'start',
      labels: { en: 'Start' },
      isInitial: true,
    });
    expect([second.status, codeOf(second)]).toEqual([409, 'state_initial_exists']);
    expect(
      (
        await post('/states', alice, {
          stateMachineId: machine.id,
          code: 'both',
          labels: { en: 'Both' },
          isInitial: true,
          isFinal: true,
        })
      ).status,
    ).toBe(400);
    expect(
      (await patch(`/states/${open.id}`, alice, open.version, { isInitial: true })).status,
    ).toBe(409);

    // Transitions: both ends live states of the machine, nothing leaves a final state.
    expect(issueCodes(await addTransition(machine.id, 'draft', 'nowhere'))).toEqual([
      'toCode:unknown_state',
    ]);
    const fromFinal = await addTransition(machine.id, 'done', 'draft');
    expect([fromFinal.status, codeOf(fromFinal)]).toEqual([422, 'transition_from_final']);
    expect(
      issueCodes(await addTransition(machine.id, 'draft', 'done', { permissionKey: 'no.such' })),
    ).toEqual(['permissionKey:unknown_permission']);
    expect(
      issueCodes(
        await addTransition(machine.id, 'draft', 'done', { reasonLookupTypeId: randomUUID() }),
      ),
    ).toEqual(['reasonLookupTypeId:unknown_lookup_type']);
    const ok = await addTransition(machine.id, 'draft', 'open');
    expect(ok.status).toBe(201);
    expect((await addTransition(machine.id, 'draft', 'open')).status).toBe(409);

    // A state with a way out cannot become final; a state in use is not deleted.
    const finalise = await patch(`/states/${draft.id}`, alice, draft.version, {
      isInitial: false,
      isFinal: true,
    });
    expect([finalise.status, codeOf(finalise)]).toEqual([422, 'state_has_transitions_out']);
    const inUse = await del(`/states/${open.id}`, alice, open.version);
    expect([inUse.status, codeOf(inUse)]).toEqual([409, 'state_in_use']);
    const full = await del(`/state-machines/${machine.id}`, alice, machine.version);
    expect([full.status, codeOf(full)]).toEqual([409, 'state_machine_has_states']);

    // Unused states go; the list is filtered by machine.
    expect((await del(`/states/${done.id}`, alice, done.version)).status).toBe(204);
    const listed = await get(`/states?stateMachineId=${machine.id}`, alice);
    expect((listed.body as { items: Item[] }).items.map((s) => s.code).sort()).toEqual([
      'draft',
      'open',
    ]);
    expect((await get('/state-machines', dave)).status).toBe(403);
  });
});

describe('moving a record', () => {
  it('starts a new record in the initial state and writes its first history row', async () => {
    const key = await makeType();
    const bare = await makeRecord(key);
    expect(bare.stateCode).toBeNull();
    // No machine yet: nothing to move through.
    expect((await move(key, bare.id, alice, { toCode: 'submitted' })).status).toBe(404);

    await makeFlow(key);
    const record = await makeRecord(key, { plate: 'TEST-1' });
    expect(record.stateCode).toBe('draft');
    const history = await historyOf(key, record.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      fromCode: null,
      toCode: 'draft',
      effectiveDate: isoDay(0),
      actorId: f.userA,
    });

    // The record made before the machine counts as being at the start, and the custom
    // records path does the same as the generic one.
    const viaRecords = await post(`/records/${key}/${bare.id}/transition`, alice, {
      toCode: 'submitted',
    });
    expect(viaRecords.status).toBe(200);
    expect((viaRecords.body as Move).history).toMatchObject({
      fromCode: 'draft',
      toCode: 'submitted',
    });
    // A state is never set through the record itself.
    const direct = await patch(`/records/${key}/${record.id}`, alice, record.version, {
      stateCode: 'approved',
    });
    expect(direct.status).toBe(400);
  });

  it('allows only listed moves and checks required fields, reason and dates', async () => {
    const key = await makeType();
    const machine = await makeFlow(key);
    const list = await post('/lookup-types', alice, { key: unique('why'), name: 'Reject reasons' });
    expect(list.status).toBe(201);
    const listId = (list.body as Item).id;
    const reason = await post('/lookup-values', alice, {
      lookupTypeId: listId,
      code: 'incomplete',
      labels: { en: 'Incomplete' },
    });
    expect(reason.status).toBe(201);
    const otherList = await post('/lookup-types', alice, { key: unique('oth'), name: 'Other' });
    const stray = await post('/lookup-values', alice, {
      lookupTypeId: (otherList.body as Item).id,
      code: 'stray',
      labels: { en: 'Stray' },
    });
    expect(
      (await addTransition(machine.id, 'submitted', 'approved', { requiredFields: ['seats'] }))
        .status,
    ).toBe(201);
    expect(
      (
        await addTransition(machine.id, 'submitted', 'rejected', {
          reasonRequired: true,
          reasonLookupTypeId: listId,
        })
      ).status,
    ).toBe(201);

    const record = await makeRecord(key, { plate: 'TEST-2' });
    // draft -> approved is not a transition of this machine.
    const skip = await move(key, record.id, alice, { toCode: 'approved' });
    expect([skip.status, codeOf(skip)]).toEqual([422, 'transition_not_allowed']);
    expect((await move(key, record.id, alice, { toCode: 'nowhere' })).status).toBe(422);

    // Effective date: not in the future; back-dating is fine.
    expect(
      issueCodes(
        await move(key, record.id, alice, { toCode: 'submitted', effectiveDate: isoDay(2) }),
      ),
    ).toEqual(['effectiveDate:effective_date_future']);
    const submitted = await move(key, record.id, alice, { toCode: 'submitted' });
    expect(submitted.status).toBe(200);
    expect((submitted.body as Move).stateCode).toBe('submitted');
    // ... but never before the previous move (made today).
    expect(
      issueCodes(await move(key, record.id, alice, { toCode: 'draft', effectiveDate: isoDay(-3) })),
    ).toEqual(['effectiveDate:effective_date_before_previous']);

    // Required field: seats is empty, so approval is refused until it is filled in.
    expect(issueCodes(await move(key, record.id, alice, { toCode: 'approved' }))).toEqual([
      'data.seats:required_for_transition',
    ]);

    // Reason: required, and from this transition's list only.
    expect(issueCodes(await move(key, record.id, alice, { toCode: 'rejected' }))).toEqual([
      'reasonId:reason_required',
    ]);
    expect(
      issueCodes(
        await move(key, record.id, alice, {
          toCode: 'rejected',
          reasonId: (stray.body as Item).id,
        }),
      ),
    ).toEqual(['reasonId:unknown_reason']);
    const rejected = await move(key, record.id, alice, {
      toCode: 'rejected',
      reasonId: (reason.body as Item).id,
      note: 'Plate photo missing',
    });
    expect(rejected.status).toBe(200);

    const stored = (await get(`/records/${key}/${record.id}`, alice)).body as Item;
    expect(stored.stateCode).toBe('rejected');
    expect(stored.version).toBe(record.version + 2);
    expect((await historyOf(key, record.id)).map((h) => [h.fromCode, h.toCode])).toEqual([
      [null, 'draft'],
      ['draft', 'submitted'],
      ['submitted', 'rejected'],
    ]);
    expect((await historyOf(key, record.id))[2]).toMatchObject({
      reasonId: (reason.body as Item).id,
      note: 'Plate photo missing',
      effectiveDate: isoDay(0),
    });
    // Rejected is final: nothing leaves it.
    expect((await move(key, record.id, alice, { toCode: 'draft' })).status).toBe(422);

    // Back-dating after a back-dated start: the order of dates is kept.
    const late = await makeRecord(key, { seats: 4 });
    const dated = await move(key, late.id, alice, {
      toCode: 'submitted',
      effectiveDate: isoDay(0),
    });
    expect(dated.status).toBe(200);
    expect((await move(key, late.id, alice, { toCode: 'approved' })).status).toBe(200);
  });

  it('asks for the transition permission, or the update permission of the type', async () => {
    const key = await makeType();
    const machine = await makeFlow(key);
    expect(
      (
        await addTransition(machine.id, 'submitted', 'approved', {
          permissionKey: 'platform.state_machine.delete',
        })
      ).status,
    ).toBe(201);
    const record = await makeRecord(key);

    // dave holds nothing; carol holds the type's read and update permissions.
    expect((await move(key, record.id, dave, { toCode: 'submitted' })).status).toBe(403);
    expect((await get(`/state-history/${key}/${record.id}`, dave)).status).toBe(403);
    expect((await move(key, record.id, carol, { toCode: 'submitted' })).status).toBe(200);

    const view = await get(`/transitions/${key}/${record.id}`, carol);
    expect(view.status).toBe(200);
    const body = view.body as {
      stateCode: string;
      current: { code: string };
      available: { to: { code: string }; allowed: boolean }[];
    };
    expect(body.current.code).toBe('submitted');
    expect(body.available.map((a) => [a.to.code, a.allowed])).toEqual([
      ['draft', true],
      ['approved', false],
    ]);
    expect((await move(key, record.id, carol, { toCode: 'approved' })).status).toBe(403);
    expect((await move(key, record.id, alice, { toCode: 'approved' })).status).toBe(200);
    const history = await historyOf(key, record.id);
    expect(history.map((h) => h.actorId)).toEqual([f.userA, ids.carol, f.userA]);
  });

  it('lets one of two simultaneous moves win and keeps the history insert-only', async () => {
    const key = await makeType();
    await makeFlow(key);
    const record = await makeRecord(key);
    const both = await Promise.all([
      move(key, record.id, alice, { toCode: 'submitted' }),
      move(key, record.id, carol, { toCode: 'submitted' }),
    ]);
    const statuses = both.map((r) => r.status).sort();
    expect(statuses[0]).toBe(200);
    // The loser either lost the version check (409) or found the record already moved (422).
    expect([409, 422]).toContain(statuses[1]);
    expect(await historyOf(key, record.id)).toHaveLength(2);

    // Not even the owner role can rewrite or remove history.
    await expect(
      owner.query(`UPDATE cfg.state_history SET note = 'changed' WHERE entity_id = $1`, [
        record.id,
      ]),
    ).rejects.toThrow();
    await expect(
      owner.query(`DELETE FROM cfg.state_history WHERE entity_id = $1`, [record.id]),
    ).rejects.toThrow();
  });
});
