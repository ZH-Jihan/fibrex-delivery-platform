/**
 * Workflow engine (phase 2 row 2.11a) against real PostgreSQL and Redis: versioned
 * definitions (draft, checked, published, frozen), a three-step approval bound to the
 * creation of a custom record type with a threshold condition (formula), notify step,
 * outcome state move, approve / reject / send back / comment / delegate, delegation
 * during leave, quorum "all" in a parallel group with two approvers acting at once,
 * self-approval refused, manual start and cancel, SLA reminder and escalation, the
 * timeline, and notifications announced after commit.
 *
 * People (all invented), tenant A, company A1: alice super_admin (creates the records, so
 * she starts the workflows), rita "reviewer", mia "manager", oscar and dan (role "user",
 * named in steps), eve (role "user", never named).
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
import { createPrisma, type PrismaDb } from '../../src/kernel/db/prisma.js';
import { UnitOfWork } from '../../src/kernel/db/unit-of-work.js';
import { createEntityDefinitionRouter } from '../../src/kernel/entities/entity-definition-router.js';
import { EntityDefinitionService } from '../../src/kernel/entities/entity-definition-service.js';
import { createFormulaRouter } from '../../src/kernel/formulas/formula-router.js';
import { FormulaService } from '../../src/kernel/formulas/formula-service.js';
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
import { createWorkflowRouter } from '../../src/kernel/workflows/workflow-router.js';
import {
  WorkflowService,
  type WorkflowAnnouncement,
} from '../../src/kernel/workflows/workflow-service.js';
import { createFixture, type Fixture } from './fixtures.js';
import { connectionUrl } from './global-setup.js';
import { connect, testDatabase } from './helpers.js';
import { TEST_AUTH_ENV } from './test-env.js';

const PASSWORD = 'synthetic-pass-flow-1';

let owner: pg.Client;
let pool: Pool;
let redis: Redis;
let prisma: PrismaDb;
let uow: UnitOfWork;
let workflows: WorkflowService;
let f: Fixture;
let app: Express;
let slugA = '';
const token: Record<string, string> = {};
const ids = {
  rita: randomUUID(),
  mia: randomUUID(),
  oscar: randomUUID(),
  dan: randomUUID(),
  eve: randomUUID(),
  superAdmin: randomUUID(),
  reviewer: randomUUID(),
  manager: randomUUID(),
  user: randomUUID(),
};
const sent: WorkflowAnnouncement[] = [];

type Json = Record<string, unknown>;
const auth = (req: request.Test, who: string) =>
  req.set('Authorization', `Bearer ${token[who] ?? ''}`);
const get = (path: string, who: string) => auth(request(app).get(`${API_PREFIX}${path}`), who);
const post = (path: string, who: string, body: Json = {}, version?: number) => {
  const req = auth(request(app).post(`${API_PREFIX}${path}`), who).set(
    'Idempotency-Key',
    randomUUID(),
  );
  if (version !== undefined) req.set('If-Match', `"${String(version)}"`);
  return req.send(body);
};
const patch = (path: string, who: string, version: number, body: Json) =>
  auth(request(app).patch(`${API_PREFIX}${path}`), who)
    .set('Idempotency-Key', randomUUID())
    .set('If-Match', `"${String(version)}"`)
    .send(body);
const codeOf = (res: { body: unknown }) => (res.body as { code?: string }).code;
const unique = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8)}`;
const today = () => new Date().toISOString().slice(0, 10);

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
  redis = createRedis(inject('redisUrl'), 'fibrex-test-workflows');
  prisma = createPrisma(pool);
  await syncPermissionCatalogue(prisma);
  const slug = await owner.query<{ slug: string }>(
    `SELECT slug FROM platform.tenant WHERE id = $1`,
    [f.tenantA],
  );
  slugA = slug.rows[0]?.slug ?? '';
  await owner.query(
    `INSERT INTO iam.role (id, tenant_id, key, name, is_builtin) VALUES
       ($1, $5, 'super_admin', 'Super Admin', true), ($2, $5, 'reviewer', 'Reviewer', false),
       ($3, $5, 'manager', 'Manager', false), ($4, $5, 'user', 'User', true)`,
    [ids.superAdmin, ids.reviewer, ids.manager, ids.user, f.tenantA],
  );
  await owner.query(
    `INSERT INTO iam.role_permission (tenant_id, role_id, permission_id)
     SELECT $1, $2, id FROM iam.permission`,
    [f.tenantA, ids.superAdmin],
  );
  await addUser(f.userA, 'alice', ids.superAdmin);
  await addUser(ids.rita, 'rita', ids.reviewer);
  await addUser(ids.mia, 'mia', ids.manager);
  await addUser(ids.oscar, 'oscar', ids.user);
  await addUser(ids.dan, 'dan', ids.user);
  await addUser(ids.eve, 'eve', ids.user);

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
  const entities = new EntityDefinitionService({
    lookups: new LookupService(),
    systemEntities: () => [],
  });
  const formulas = new FormulaService();
  const targets: StateTargets = new StateTargets((key) => records.stateTarget(key));
  const states: StateService = new StateService({
    permissions,
    targets,
    onTransition: (move) => workflows.onTransition(move),
  });
  workflows = new WorkflowService({
    permissions,
    targets,
    states,
    evaluate: (key, onDate, inputs) => formulas.evaluate(key, onDate, inputs),
    events: {
      emit: (event) => {
        sent.push(event);
        return Promise.resolve();
      },
    },
    logger,
  });
  const records: RecordService = new RecordService({
    entities,
    numbering: new NumberingService(),
    referenceExists: () => Promise.resolve(undefined),
    states,
    onCreated: (key, id) => workflows.onCreated(key, id),
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
      api.use(createEntityDefinitionRouter({ uow, registry, permissions, entities }));
      api.use(createRecordRouter({ uow, registry, permissions, records }));
      api.use(createStateRouter({ uow, registry, permissions, states }));
      api.use(createFormulaRouter({ uow, registry, permissions, formulas }));
      api.use(createWorkflowRouter({ uow, registry, permissions, workflows }));
    },
  });
  for (const who of ['alice', 'rita', 'mia', 'oscar', 'dan', 'eve']) token[who] = await signIn(who);

  // The threshold formula: more than 4 seats needs the manager.
  const formula = await post('/formulas', 'alice', {
    key: 'wf.big_vehicle',
    name: 'Big vehicle',
    purpose: 'eligibility',
    returnType: 'bool',
    inputSchema: { seats: { type: 'int' } },
  });
  expect(formula.status).toBe(201);
  const version = await post('/formula-versions', 'alice', {
    formulaId: (formula.body as Item).id,
    expression: 'seats > 4',
    validFrom: '2026-01-01',
    testCases: [
      { name: 'big', inputs: { seats: 8 }, expected: true },
      { name: 'small', inputs: { seats: 2 }, expected: false },
    ],
  });
  expect(version.status).toBe(201);
  const active = await post(
    `/formula-versions/${(version.body as Item).id}/activate`,
    'alice',
    {},
    (version.body as Item).version,
  );
  expect(active.status).toBe(200);
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
  stateCode?: string | null;
}
interface Task {
  id: string;
  stepKey: string;
  status: string;
  action: string | null;
  assigneeUserId: string | null;
  assigneeRoleId: string | null;
  delegatedFromUserId: string | null;
  activationNo: number;
  escalatedFromTaskId: string | null;
}
interface View {
  instance: { id: string; status: string; currentStepKeys: string[]; startedBy: string | null };
  tasks: Task[];
  events: { kind: string; stepKey: string | null; detail: Json }[];
}

/** A published record type with a number field "seats" and a state machine. */
async function makeType(): Promise<string> {
  const key = unique('req').replaceAll('-', '');
  const created = await post('/entity-definitions', 'alice', {
    key,
    name: { en: 'Vehicle request' },
  });
  expect(created.status).toBe(201);
  const entity = created.body as Item;
  expect(
    (
      await post('/field-definitions', 'alice', {
        entityDefinitionId: entity.id,
        key: 'seats',
        label: { en: 'Seats' },
        type: 'number',
      })
    ).status,
  ).toBe(201);
  const fresh = (await get(`/entity-definitions/${entity.id}`, 'alice')).body as Item;
  expect(
    (await post(`/entity-definitions/${entity.id}/publish`, 'alice', {}, fresh.version)).status,
  ).toBe(200);
  // draft (initial) -> approved | rejected (final). The moves need a permission nobody but
  // alice holds: the workflow's outcome is its own authority.
  const machine = (await post('/state-machines', 'alice', { entityKey: key, name: key }))
    .body as Item;
  for (const [code, extra] of [
    ['draft', { isInitial: true }],
    ['approved', { isFinal: true }],
    ['rejected', { isFinal: true }],
  ] as const) {
    expect(
      (
        await post('/states', 'alice', {
          stateMachineId: machine.id,
          code,
          labels: { en: code },
          ...extra,
        })
      ).status,
    ).toBe(201);
  }
  for (const to of ['approved', 'rejected']) {
    const res = await post('/state-transitions', 'alice', {
      stateMachineId: machine.id,
      fromCode: 'draft',
      toCode: to,
      permissionKey: 'platform.workflow_definition.publish',
    });
    expect(res.status).toBe(201);
  }
  // Everyone in the test may read records of this type.
  await owner.query(
    `INSERT INTO iam.role_permission (tenant_id, role_id, permission_id)
     SELECT $1, r, p.id FROM iam.permission p, unnest($2::uuid[]) r WHERE p.key = $3
     ON CONFLICT DO NOTHING`,
    [f.tenantA, [ids.reviewer, ids.manager, ids.user], `custom.${key}.read`],
  );
  return key;
}

/** Creates a definition with a published version; returns its id and key. */
async function makeWorkflow(entityKey: string, graph: Json, binding: Json | null) {
  const key = unique('wf').replaceAll('-', '_');
  const def = await post('/workflow-definitions', 'alice', { key, name: key, entityKey });
  expect(def.status).toBe(201);
  const id = (def.body as Item).id;
  const draft = await post('/workflow-versions', 'alice', { workflowDefinitionId: id, graph });
  expect(draft.status).toBe(201);
  const published = await post(`/workflow-definitions/${id}/versions/publish`, 'alice');
  expect(published.status).toBe(200);
  if (binding !== null) {
    const res = await post('/workflow-bindings', 'alice', { workflowDefinitionId: id, ...binding });
    expect(res.status).toBe(201);
  }
  return { id, key, versionId: (draft.body as Item).id };
}

const threeSteps = {
  steps: [
    { key: 'review', kind: 'approval', name: 'Reviewer', assignee: { roles: ['reviewer'] } },
    { key: 'owner', kind: 'approval', name: 'Owner', assignee: { users: [ids.oscar] } },
    {
      key: 'big',
      kind: 'condition',
      name: 'More than 4 seats',
      formulaKey: 'wf.big_vehicle',
      onFalse: 'tell',
    },
    { key: 'manager', kind: 'approval', name: 'Manager', assignee: { roles: ['manager'] } },
    { key: 'tell', kind: 'notify', name: 'Tell the office' },
  ],
  onApproved: { toStateCode: 'approved' },
  onRejected: { toStateCode: 'rejected' },
};

async function instanceOf(entityKey: string, recordId: string): Promise<View> {
  const list = await get(
    `/workflow-instances?entityType=${entityKey}&entityId=${recordId}`,
    'alice',
  );
  expect(list.status).toBe(200);
  const first = (list.body as { items: { id: string }[] }).items[0];
  expect(first).toBeDefined();
  return (await get(`/workflow-instances/${first?.id ?? ''}`, 'alice')).body as View;
}
const openTask = (view: View, stepKey: string) =>
  view.tasks.find((t) => t.stepKey === stepKey && t.status === 'open');
const act = (taskId: string, action: string, who: string, body: Json = {}) =>
  post(`/tasks/${taskId}/${action}`, who, body);

describe('definitions and versions', () => {
  it('checks the graph against the data, freezes published versions', async () => {
    const entityKey = await makeType();
    const def = await post('/workflow-definitions', 'alice', {
      key: unique('wf').replaceAll('-', '_'),
      name: 'x',
      entityKey,
    });
    const id = (def.body as Item).id;
    const wrong = await post('/workflow-versions', 'alice', {
      workflowDefinitionId: id,
      graph: {
        steps: [{ key: 'a', kind: 'approval', name: 'a', assignee: { roles: ['no_such_role'] } }],
        onApproved: { toStateCode: 'nowhere' },
      },
    });
    expect(wrong.status).toBe(400);
    expect(JSON.stringify(wrong.body)).toContain('unknown_role');
    expect(JSON.stringify(wrong.body)).toContain('unknown_state');

    expect(codeOf(await post(`/workflow-definitions/${id}/versions/publish`, 'alice'))).toBe(
      'workflow_no_draft',
    );
    const draft = (
      await post('/workflow-versions', 'alice', { workflowDefinitionId: id, graph: threeSteps })
    ).body as Item;
    const published = await post(`/workflow-definitions/${id}/versions/publish`, 'alice');
    expect(published.body).toMatchObject({ status: 'published', versionNo: 1 });
    const frozen = await patch(
      `/workflow-versions/${draft.id}`,
      'alice',
      (published.body as Item).version,
      { graph: threeSteps },
    );
    expect(codeOf(frozen)).toBe('workflow_version_frozen');
    const steps = await owner.query(
      `SELECT key, kind, parent_key FROM cfg.workflow_step WHERE workflow_version_id = $1 ORDER BY order_no`,
      [draft.id],
    );
    expect(steps.rows.map((r: { key: string }) => r.key)).toEqual([
      'review',
      'owner',
      'big',
      'manager',
      'tell',
    ]);

    // Version 2 retires version 1.
    await post('/workflow-versions', 'alice', { workflowDefinitionId: id, graph: threeSteps });
    const v2 = await post(`/workflow-definitions/${id}/versions/publish`, 'alice');
    expect(v2.body).toMatchObject({ versionNo: 2, status: 'published' });
    const v1 = await get(`/workflow-versions/${draft.id}`, 'alice');
    expect(v1.body).toMatchObject({ status: 'retired' });
  });
});

describe('a three-step approval bound to record creation', () => {
  it('runs review, owner, threshold and manager; send back and comment; ends approved', async () => {
    const entityKey = await makeType();
    await makeWorkflow(entityKey, threeSteps, { trigger: 'on_create' });
    sent.length = 0;
    const record = (await post(`/records/${entityKey}`, 'alice', { data: { seats: 8 } }))
      .body as Item;
    let view = await instanceOf(entityKey, record.id);
    expect(view.instance).toMatchObject({
      status: 'running',
      currentStepKeys: ['review'],
      startedBy: f.userA,
    });
    const review = openTask(view, 'review');
    expect(review?.assigneeRoleId).toBe(ids.reviewer);
    expect(sent.map((s) => s.eventType)).toEqual(['workflow.task_assigned']);

    // Not hers; and at the first approval there is nothing to send back to.
    expect((await act(review?.id ?? '', 'approve', 'eve')).status).toBe(403);
    expect(codeOf(await act(review?.id ?? '', 'send-back', 'rita', { comment: 'why?' }))).toBe(
      'workflow_nothing_to_send_back',
    );
    expect((await act(review?.id ?? '', 'comment', 'rita', { comment: 'Looks fine' })).status).toBe(
      200,
    );
    // rita's inbox shows the task through her role.
    const inbox = await get('/tasks', 'rita');
    expect(
      (inbox.body as { items: { task: Task; stepName: string }[] }).items.map((i) => i.stepName),
    ).toContain('Reviewer');

    expect((await act(review?.id ?? '', 'approve', 'rita')).status).toBe(200);
    expect((await act(review?.id ?? '', 'approve', 'rita')).status).toBe(409);
    view = await instanceOf(entityKey, record.id);
    const ownerTask = openTask(view, 'owner');
    expect(ownerTask?.assigneeUserId).toBe(ids.oscar);

    // The owner sends it back: a new round for the reviewer.
    expect(
      (await act(ownerTask?.id ?? '', 'send-back', 'oscar', { comment: 'Add the plate' })).status,
    ).toBe(200);
    view = await instanceOf(entityKey, record.id);
    const again = openTask(view, 'review');
    expect(again?.activationNo).toBeGreaterThan(review?.activationNo ?? 0);
    expect((await act(again?.id ?? '', 'approve', 'rita')).status).toBe(200);
    view = await instanceOf(entityKey, record.id);
    expect(
      (await act(openTask(view, 'owner')?.id ?? '', 'approve', 'oscar', { payload: { seats: 7 } }))
        .status,
    ).toBe(200);

    // 8 seats: the condition sends it to the manager.
    view = await instanceOf(entityKey, record.id);
    expect(view.instance.currentStepKeys).toEqual(['manager']);
    sent.length = 0;
    expect((await act(openTask(view, 'manager')?.id ?? '', 'approve', 'mia')).status).toBe(200);
    view = await instanceOf(entityKey, record.id);
    expect(view.instance.status).toBe('approved');
    expect(sent.map((s) => s.eventType)).toEqual(['workflow.notify', 'workflow.completed']);
    expect(sent[1]?.payload).toMatchObject({ outcome: 'approved', starterId: f.userA });

    // The outcome moved the record, though no one here holds the move's permission.
    const moved = await get(`/records/${entityKey}/${record.id}`, 'alice');
    expect((moved.body as Item).stateCode).toBe('approved');
    const kinds = view.events.map((e) => e.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'started',
        'commented',
        'sent_back',
        'condition',
        'notified',
        'approved',
        'completed',
        'state_moved',
      ]),
    );
    const condition = view.events.find((e) => e.kind === 'condition');
    expect(condition?.detail).toMatchObject({
      formulaKey: 'wf.big_vehicle',
      result: true,
      versionNo: 1,
    });
  });

  it('skips the manager for a small vehicle, and a rejection ends it', async () => {
    const entityKey = await makeType();
    await makeWorkflow(entityKey, threeSteps, { trigger: 'on_create' });
    const small = (await post(`/records/${entityKey}`, 'alice', { data: { seats: 2 } }))
      .body as Item;
    let view = await instanceOf(entityKey, small.id);
    await act(openTask(view, 'review')?.id ?? '', 'approve', 'rita');
    view = await instanceOf(entityKey, small.id);
    await act(openTask(view, 'owner')?.id ?? '', 'approve', 'oscar');
    view = await instanceOf(entityKey, small.id);
    expect(view.instance.status).toBe('approved');
    expect(view.tasks.some((t) => t.stepKey === 'manager')).toBe(false);

    const other = (await post(`/records/${entityKey}`, 'alice', { data: { seats: 9 } }))
      .body as Item;
    view = await instanceOf(entityKey, other.id);
    expect((await act(openTask(view, 'review')?.id ?? '', 'reject', 'rita', {})).status).toBe(400);
    expect(
      (await act(openTask(view, 'review')?.id ?? '', 'reject', 'rita', { comment: 'No budget' }))
        .status,
    ).toBe(200);
    view = await instanceOf(entityKey, other.id);
    expect(view.instance.status).toBe('rejected');
    expect(((await get(`/records/${entityKey}/${other.id}`, 'alice')).body as Item).stateCode).toBe(
      'rejected',
    );
  });

  it('a workflow that cannot find an approver stops the record from being created', async () => {
    const entityKey = await makeType();
    await makeWorkflow(
      entityKey,
      {
        steps: [{ key: 'boss', kind: 'approval', name: 'Boss', assignee: { userField: 'bossId' } }],
      },
      { trigger: 'on_create' },
    );
    const res = await post(`/records/${entityKey}`, 'alice', { data: { seats: 1 } });
    expect(codeOf(res)).toBe('workflow_no_assignee');
    const count = await owner.query(
      `SELECT count(*)::int AS n FROM cfg.custom_record r JOIN cfg.entity_definition e ON e.id = r.entity_definition_id WHERE e.key = $1`,
      [entityKey],
    );
    expect(count.rows[0]).toEqual({ n: 0 });
  });
});

describe('delegation', () => {
  it('gives the task to the stand-in during leave, and a task can be passed on', async () => {
    const entityKey = await makeType();
    const wf = await makeWorkflow(
      entityKey,
      {
        steps: [
          { key: 'owner', kind: 'approval', name: 'Owner', assignee: { users: [ids.oscar] } },
        ],
      },
      { trigger: 'on_create' },
    );
    const leave = await post('/delegations', 'alice', {
      userId: ids.oscar,
      delegateUserId: ids.dan,
      validFrom: today(),
      validTo: today(),
      scope: { definitionKeys: [wf.key] },
    });
    expect(leave.status).toBe(201);
    const record = (await post(`/records/${entityKey}`, 'alice', { data: { seats: 3 } }))
      .body as Item;
    let view = await instanceOf(entityKey, record.id);
    const task = openTask(view, 'owner');
    expect(task).toMatchObject({ assigneeUserId: ids.dan, delegatedFromUserId: ids.oscar });
    const inbox = (await get('/tasks', 'dan')).body as { items: { task: Task }[] };
    expect(inbox.items.some((i) => i.task.id === task?.id)).toBe(true);

    // dan passes it to eve; eve approves.
    expect((await act(task?.id ?? '', 'delegate', 'oscar', { toUserId: ids.eve })).status).toBe(
      403,
    );
    expect((await act(task?.id ?? '', 'delegate', 'dan', { toUserId: ids.eve })).status).toBe(200);
    expect((await act(task?.id ?? '', 'approve', 'dan')).status).toBe(403);
    expect((await act(task?.id ?? '', 'approve', 'eve')).status).toBe(200);
    view = await instanceOf(entityKey, record.id);
    expect(view.instance.status).toBe('approved');
    expect(view.events.find((e) => e.kind === 'delegated')?.detail).toMatchObject({
      fromUserId: ids.dan,
      toUserId: ids.eve,
    });
  });
});

describe('parallel group, quorum and manual start', () => {
  it('needs every branch, counts "all" correctly when two approve at once', async () => {
    const entityKey = await makeType();
    const wf = await makeWorkflow(
      entityKey,
      {
        steps: [
          {
            key: 'checks',
            kind: 'parallel_group',
            name: 'Checks',
            branches: [
              {
                key: 'legal',
                kind: 'approval',
                name: 'Legal',
                assignee: { users: [ids.oscar, ids.dan] },
                quorum: 'all',
              },
              {
                key: 'finance',
                kind: 'approval',
                name: 'Finance',
                assignee: { roles: ['manager'] },
              },
            ],
          },
        ],
      },
      { trigger: 'manual' },
    );
    const record = (await post(`/records/${entityKey}`, 'alice', { data: { seats: 3 } }))
      .body as Item;
    expect(
      await get(`/workflow-instances?entityType=${entityKey}&entityId=${record.id}`, 'alice'),
    ).toMatchObject({
      body: { items: [] },
    });
    const start = { definitionKey: wf.key, entityType: entityKey, entityId: record.id };
    expect((await post('/workflow-instances', 'eve', start)).status).toBe(403);
    expect((await post('/workflow-instances', 'alice', start)).status).toBe(201);
    expect(codeOf(await post('/workflow-instances', 'alice', start))).toBe('workflow_running');

    let view = await instanceOf(entityKey, record.id);
    expect(view.instance.currentStepKeys).toEqual(['legal', 'finance']);
    expect((await act(openTask(view, 'finance')?.id ?? '', 'approve', 'mia')).status).toBe(200);
    const legal = view.tasks.filter((t) => t.stepKey === 'legal');
    const byUser = (u: string) => legal.find((t) => t.assigneeUserId === u)?.id ?? '';
    const [a, b] = await Promise.all([
      act(byUser(ids.oscar), 'approve', 'oscar'),
      act(byUser(ids.dan), 'approve', 'dan'),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    view = await instanceOf(entityKey, record.id);
    expect(view.instance.status).toBe('approved');
  });

  it('refuses self-approval, and the starter may cancel', async () => {
    const entityKey = await makeType();
    const wf = await makeWorkflow(
      entityKey,
      { steps: [{ key: 'me', kind: 'approval', name: 'Me', assignee: { users: [f.userA] } }] },
      { trigger: 'manual' },
    );
    const record = (await post(`/records/${entityKey}`, 'alice', { data: { seats: 3 } }))
      .body as Item;
    await post('/workflow-instances', 'alice', {
      definitionKey: wf.key,
      entityType: entityKey,
      entityId: record.id,
    });
    const view = await instanceOf(entityKey, record.id);
    expect((await act(openTask(view, 'me')?.id ?? '', 'approve', 'alice')).status).toBe(403);
    expect(
      (await post(`/workflow-instances/${view.instance.id}/cancel`, 'oscar', { reason: 'x' }))
        .status,
    ).toBe(403);
    const cancelled = await post(`/workflow-instances/${view.instance.id}/cancel`, 'alice', {
      reason: 'Not needed',
    });
    expect(cancelled.body).toMatchObject({ status: 'cancelled' });
    expect(
      codeOf(
        await post(`/workflow-instances/${view.instance.id}/cancel`, 'alice', { reason: 'again' }),
      ),
    ).toBe('workflow_finished');
  });
});

describe('SLA', () => {
  it("reminds once, then escalates to the step's escalation role", async () => {
    const entityKey = await makeType();
    await makeWorkflow(
      entityKey,
      {
        steps: [
          {
            key: 'owner',
            kind: 'approval',
            name: 'Owner',
            assignee: { users: [ids.oscar] },
            slaHours: 48,
            reminderHours: 24,
            escalateTo: { roles: ['manager'] },
          },
        ],
      },
      { trigger: 'on_create' },
    );
    const record = (await post(`/records/${entityKey}`, 'alice', { data: { seats: 3 } }))
      .body as Item;
    let view = await instanceOf(entityKey, record.id);
    const task = openTask(view, 'owner');
    sent.length = 0;
    // Nothing is due yet.
    await workflows.sweep(prisma, uow);
    expect(sent.filter((s) => s.payload.taskId === task?.id)).toEqual([]);

    await owner.query(
      `UPDATE cfg.workflow_task SET reminder_at = now() - interval '1 minute' WHERE id = $1`,
      [task?.id],
    );
    await workflows.sweep(prisma, uow);
    await workflows.sweep(prisma, uow);
    expect(
      sent.filter((s) => s.eventType === 'workflow.task_reminder' && s.payload.taskId === task?.id),
    ).toHaveLength(1);

    await owner.query(
      `UPDATE cfg.workflow_task SET due_at = now() - interval '1 minute' WHERE id = $1`,
      [task?.id],
    );
    await workflows.sweep(prisma, uow);
    view = await instanceOf(entityKey, record.id);
    expect(view.tasks.find((t) => t.id === task?.id)?.status).toBe('expired');
    const escalated = openTask(view, 'owner');
    expect(escalated).toMatchObject({ assigneeRoleId: ids.manager, escalatedFromTaskId: task?.id });
    expect(sent.some((s) => s.eventType === 'workflow.task_escalated')).toBe(true);
    expect((await act(escalated?.id ?? '', 'approve', 'mia')).status).toBe(200);
    view = await instanceOf(entityKey, record.id);
    expect(view.instance.status).toBe('approved');
  });
});

describe('self-service delegation (row 2.11c)', () => {
  const own = ['read', 'create', 'update', 'delete'].map(
    (a) => `platform.workflow_delegation.${a}`,
  );
  const del = (path: string, who: string, version: number, reason: string) =>
    auth(request(app).delete(`${API_PREFIX}${path}`), who)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', `"${String(version)}"`)
      .send({ reason });

  it('lets an ordinary user manage only their own stand-ins', async () => {
    // Role "user" (oscar, dan, eve) gets the four own-delegation keys, as the seed gives the
    // built-in manager and viewer; none holds manage_all.
    await owner.query(
      `INSERT INTO iam.role_permission (tenant_id, role_id, permission_id)
       SELECT $1, $2, id FROM iam.permission WHERE key = ANY($3::text[])
       ON CONFLICT DO NOTHING`,
      [f.tenantA, ids.user, own],
    );
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    // oscar names dan for his own tasks.
    const made = await post('/delegations', 'oscar', {
      userId: ids.oscar,
      delegateUserId: ids.dan,
      validFrom: today(),
      validTo: tomorrow,
    });
    expect(made.status).toBe(201);
    const mine = made.body as Item;
    // ... but not for someone else's tasks.
    const forged = await post('/delegations', 'oscar', {
      userId: ids.eve,
      delegateUserId: ids.dan,
      validFrom: today(),
      validTo: tomorrow,
    });
    expect(forged.status).toBe(403);
    // The stand-in must be a person of the company.
    const stranger = await post('/delegations', 'oscar', {
      userId: ids.oscar,
      delegateUserId: randomUUID(),
      validFrom: today(),
      validTo: tomorrow,
    });
    expect(stranger.status).toBe(400);

    const seen = async (who: string) =>
      ((await get('/delegations?pageSize=200', who)).body as { items: Item[] }).items.map(
        (i) => i.id,
      );
    expect(await seen('oscar')).toContain(mine.id);
    expect(await seen('dan')).toContain(mine.id); // given to dan: he can see it
    expect(await seen('eve')).not.toContain(mine.id); // unrelated: not listed
    expect(await seen('alice')).toContain(mine.id); // manage_all sees everyone's

    // Reading one by id follows the same rule as the list: eve gets 404, the two parties 200.
    expect((await get(`/delegations/${mine.id}`, 'eve')).status).toBe(404);
    expect((await get(`/delegations/${mine.id}`, 'dan')).status).toBe(200);
    expect((await get(`/delegations/${mine.id}`, 'oscar')).status).toBe(200);

    // eve cannot change or cancel it; dan (the stand-in) cannot change it; oscar can.
    expect(
      (await patch(`/delegations/${mine.id}`, 'eve', mine.version, { note: 'x' })).status,
    ).toBe(403);
    expect((await del(`/delegations/${mine.id}`, 'eve', mine.version, 'no')).status).toBe(403);
    expect(
      (await patch(`/delegations/${mine.id}`, 'dan', mine.version, { validTo: '2099-12-31' }))
        .status,
    ).toBe(403);
    expect((await del(`/delegations/${mine.id}`, 'oscar', mine.version, 'back early')).status).toBe(
      204,
    );

    // The stand-in may decline (cancel) a delegation given to him.
    const second = (
      await post('/delegations', 'oscar', {
        userId: ids.oscar,
        delegateUserId: ids.dan,
        validFrom: today(),
        validTo: tomorrow,
      })
    ).body as Item;
    expect((await del(`/delegations/${second.id}`, 'dan', second.version, 'cannot')).status).toBe(
      204,
    );
    // alice, with manage_all, names a stand-in for someone else.
    const byAdmin = await post('/delegations', 'alice', {
      userId: ids.eve,
      delegateUserId: ids.dan,
      validFrom: today(),
      validTo: tomorrow,
    });
    expect(byAdmin.status).toBe(201);
  });

  it('one person approves a step once, even when standing in for another approver', async () => {
    const entityKey = await makeType();
    const wf = await makeWorkflow(
      entityKey,
      {
        steps: [
          {
            key: 'both',
            kind: 'approval',
            name: 'Both',
            assignee: { users: [ids.oscar, ids.dan] },
            quorum: 'all',
          },
        ],
      },
      { trigger: 'on_create' },
    );
    const record = (await post(`/records/${entityKey}`, 'alice', { data: { seats: 3 } }))
      .body as Item;
    let view = await instanceOf(entityKey, record.id);
    const taskOf = (u: string) =>
      view.tasks.find((t) => t.stepKey === 'both' && t.assigneeUserId === u)?.id ?? '';
    const oscarTask = taskOf(ids.oscar);
    const danTask = taskOf(ids.dan);

    // Passing oscar's task to dan, who already holds one on this step, is refused.
    const passOn = await act(oscarTask, 'delegate', 'oscar', { toUserId: ids.dan });
    expect(passOn.status).toBe(400);
    expect(JSON.stringify(passOn.body)).toContain('already_on_step');

    // oscar goes on leave after the tasks exist: dan now stands in for him.
    const leave = (
      await post('/delegations', 'alice', {
        userId: ids.oscar,
        delegateUserId: ids.dan,
        validFrom: today(),
        validTo: today(),
        scope: { definitionKeys: [wf.key] },
      })
    ).body as Item;
    expect((await act(danTask, 'approve', 'dan')).status).toBe(200);
    // dan cannot cast a second vote on the same step with oscar's task.
    expect((await act(oscarTask, 'approve', 'dan')).status).toBe(403);
    view = await instanceOf(entityKey, record.id);
    expect(view.instance.status).toBe('running');
    // oscar himself still can.
    expect((await act(oscarTask, 'approve', 'oscar')).status).toBe(200);
    view = await instanceOf(entityKey, record.id);
    expect(view.instance.status).toBe('approved');
    await del(`/delegations/${leave.id}`, 'alice', leave.version, 'test done');
  });

  it('lists the people of the company for any signed-in user', async () => {
    const res = await get('/workflow-people', 'eve');
    expect(res.status).toBe(200);
    const items = (res.body as { items: { id: string; displayName: string }[] }).items;
    expect(items.map((p) => p.id)).toEqual(expect.arrayContaining([ids.oscar, ids.dan, ids.eve]));
  });
});
