/**
 * Retention (phase 2 row 2.18) against real PostgreSQL and Redis: policies refuse audit,
 * ledger, journal and payroll data (API and database), new policies start as dry runs,
 * a policy cannot go live without a registered target, the dry run and the scheduled sweep
 * change no data, a live run needs every switch, the run log is insert-only, tenants are
 * isolated, and the reserved tables exist with row-level security.
 *
 * People (all invented), tenant A, company A1: alice super_admin, dave "user" with no
 * permissions.
 */
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
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
import { createLogger } from '../../src/kernel/observability/logger.js';
import { syncPermissionCatalogue } from '../../src/kernel/permissions/catalogue.js';
import { PermissionService } from '../../src/kernel/permissions/permission-service.js';
import { createRedis } from '../../src/kernel/redis/client.js';
import { createRetentionRouter } from '../../src/kernel/retention/retention-router.js';
import {
  isProtectedEntityKey,
  RetentionService,
  RetentionTargets,
  type RetentionTarget,
} from '../../src/kernel/retention/retention-service.js';
import { createFixture, type Fixture } from './fixtures.js';
import { connectionUrl } from './global-setup.js';
import { connect, testDatabase } from './helpers.js';
import { TEST_AUTH_ENV } from './test-env.js';

const PASSWORD = 'synthetic-pass-retention-1';

let owner: pg.Client;
let pool: Pool;
let prisma: PrismaDb;
let uow: UnitOfWork;
let redis: Redis;
let f: Fixture;
let app: Express;
let retention: RetentionService;
let slugA = '';
let alice = '';
let dave = '';
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

/** A fake module target that counts how it was used; it never touches a table. */
function fakeTarget(entityKey: string, eligible: number) {
  const countEligible = vi.fn(() => Promise.resolve(eligible));
  const apply = vi.fn(() => Promise.resolve({ rowsAffected: eligible }));
  const target: RetentionTarget = { entityKey, countEligible, apply };
  return { target, countEligible, apply };
}

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

const targets = new RetentionTargets();
const noteTarget = fakeTarget('party.old_note', 7);
const stayTarget = fakeTarget('party.old_stay', 3);

beforeAll(async () => {
  owner = await connect('owner');
  f = await createFixture(owner);
  const db = testDatabase();
  pool = createPool(connectionUrl(db, db.app), 4);
  redis = createRedis(inject('redisUrl'), 'fibrex-test-retention');
  prisma = createPrisma(pool);
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
  targets.register(noteTarget.target);
  targets.register(stayTarget.target);
  retention = new RetentionService({ targets, logger });
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
      api.use(createRetentionRouter({ uow, registry, permissions, retention }));
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
  mode: string;
}
interface Run {
  policyId: string;
  dryRun: boolean;
  status: string;
  rowsAffected: number;
  note: string | null;
}

const policyBody = (entityKey: string): Json => ({
  entityKey,
  keepMonths: 24,
  action: 'anonymise',
  legalBasis: 'Synthetic test basis',
});

describe('protected data', () => {
  it('names audit, ledger, journal and payroll keys as protected and nothing else', () => {
    for (const key of ['audit.change', 'gl.account', 'journal_line', 'payroll_run', 'ledger.x']) {
      expect(isProtectedEntityKey(key)).toBe(true);
    }
    for (const key of ['party.old_note', 'custom_vehicle', 'files.attachment']) {
      expect(isProtectedEntityKey(key)).toBe(false);
    }
  });

  it('refuses a policy on protected data with 400, and the database refuses it too', async () => {
    for (const key of ['audit.change', 'gl.journal', 'payroll_run', 'journal']) {
      const res = await post('/retention-policies', alice, policyBody(key));
      expect(res.status, key).toBe(400);
    }
    await expect(
      owner.query(
        `INSERT INTO cfg.retention_policy (tenant_id, entity_key, keep_months, action, legal_basis)
         VALUES ($1, 'gl.journal', 12, 'archive', 'x')`,
        [f.tenantA],
      ),
    ).rejects.toMatchObject({ constraint: 'retention_policy_protected_ck' });
  });

  it('refuses to register a retention target for protected data', () => {
    const bad = fakeTarget('payroll.run', 1).target;
    expect(() => { new RetentionTargets().register(bad); }).toThrow(/protected/i);
  });
});

describe('policies and dry runs', () => {
  it('creates a policy as a dry run and refuses a second one for the same type', async () => {
    const created = await post('/retention-policies', alice, policyBody('party.old_note'));
    expect(created.status).toBe(201);
    expect((created.body as Item).mode).toBe('dry_run');
    const again = await post('/retention-policies', alice, policyBody('party.old_note'));
    expect(again.status).toBe(409);
  });

  it('keeps the entity key fixed and refuses live without a registered target', async () => {
    const created = await post('/retention-policies', alice, policyBody('party.no_target'));
    const item = created.body as Item;
    const live = await patch(`/retention-policies/${item.id}`, alice, item.version, {
      mode: 'live',
    });
    expect(live.status).toBe(422);
    expect((live.body as { code?: string }).code).toBe('retention_no_target');
    const rename = await patch(`/retention-policies/${item.id}`, alice, item.version, {
      entityKey: 'party.other',
    });
    expect(rename.status).toBe(400);
  });

  it('a dry run counts, changes no data and is logged', async () => {
    const created = await post('/retention-policies', alice, policyBody('files.dry'));
    const item = created.body as Item;
    // No target yet: skipped.
    const skipped = await post(`/retention-policies/${item.id}/dry-run`, alice);
    expect(skipped.status).toBe(201);
    expect((skipped.body as Run).status).toBe('skipped');

    const counted = await post(
      `/retention-policies/${(await findPolicy('party.old_note')).id}/dry-run`,
      alice,
    );
    const run = counted.body as Run;
    expect(run).toMatchObject({ dryRun: true, status: 'completed', rowsAffected: 0 });
    expect(run.note).toContain('7 record(s)');
    expect(noteTarget.countEligible).toHaveBeenCalled();
    expect(noteTarget.apply).not.toHaveBeenCalled();

    const log = await get(`/retention-runs?policyId=${run.policyId}`, alice);
    expect(log.status).toBe(200);
    expect((log.body as { items: Run[] }).items.length).toBeGreaterThanOrEqual(1);
  });

  it('the scheduled sweep only counts, even for a policy marked live', async () => {
    const policy = await findPolicy('party.old_stay').catch(async () => {
      const made = await post('/retention-policies', alice, policyBody('party.old_stay'));
      return made.body as Item;
    });
    const live = await patch(`/retention-policies/${policy.id}`, alice, policy.version, {
      mode: 'live',
    });
    expect(live.status).toBe(200);
    stayTarget.apply.mockClear();
    const result = await retention.sweep(prisma, uow);
    expect(result.runs).toBeGreaterThanOrEqual(2);
    expect(stayTarget.apply).not.toHaveBeenCalled();
    const rows = await owner.query<{ dry_run: boolean; rows_affected: number }>(
      `SELECT dry_run, rows_affected FROM cfg.retention_run WHERE policy_id = $1`,
      [policy.id],
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(rows.rows.every((r) => r.dry_run && r.rows_affected === 0)).toBe(true);
  });

  it('a live run needs the caller switch, a live policy and a target', async () => {
    const policy = await findPolicy('party.old_stay');
    await uow.runAs({ tenantId: f.tenantA, companyIds: [] }, async (db) => {
      const row = await db.retentionPolicy.findFirstOrThrow({ where: { id: policy.id } });
      const noSwitch = await retention.runPolicy(row, { dryRun: false });
      expect(noSwitch.dryRun).toBe(true);
      expect(stayTarget.apply).not.toHaveBeenCalled();
      const live = await retention.runPolicy(row, { dryRun: false, allowLive: true });
      expect(live).toMatchObject({ dryRun: false, rowsAffected: 3, status: 'completed' });
      expect(stayTarget.apply).toHaveBeenCalledWith(expect.any(Date), 'anonymise');
    });
  });

  it('is closed to people without the permission', async () => {
    expect((await get('/retention-policies', dave)).status).toBe(403);
    expect((await get('/retention-runs', dave)).status).toBe(403);
  });
});

async function findPolicy(entityKey: string): Promise<Item> {
  const list = await get('/retention-policies?pageSize=200', alice);
  const found = (list.body as { items: (Item & { entityKey: string })[] }).items.find(
    (p) => p.entityKey === entityKey,
  );
  if (found === undefined) throw new Error(`no policy ${entityKey}`);
  return found;
}

describe('database guarantees', () => {
  it('the run log is insert-only and the app role can never delete', async () => {
    const appDb = await connect('app');
    try {
      await expect(appDb.query(`DELETE FROM cfg.retention_run`)).rejects.toThrow();
      await expect(appDb.query(`DELETE FROM cfg.retention_policy`)).rejects.toThrow();
      await expect(appDb.query(`UPDATE cfg.retention_run SET note = 'x'`)).rejects.toThrow();
    } finally {
      await appDb.end();
    }
    await expect(owner.query(`UPDATE cfg.retention_run SET note = 'x'`)).rejects.toThrow();
  });

  it('a dry run row cannot claim affected rows', async () => {
    const policy = await findPolicy('party.old_note');
    await expect(
      owner.query(
        `INSERT INTO cfg.retention_run (tenant_id, policy_id, dry_run, status, rows_affected)
         VALUES ($1, $2, true, 'completed', 5)`,
        [f.tenantA, policy.id],
      ),
    ).rejects.toMatchObject({ constraint: 'retention_run_dry_ck' });
  });

  it('tenant B sees none of tenant A policies or runs', async () => {
    const seen = await uow.runAs({ tenantId: f.tenantB, companyIds: [] }, async (db) => ({
      policies: await db.retentionPolicy.count(),
      runs: await db.retentionRun.count(),
    }));
    expect(seen).toEqual({ policies: 0, runs: 0 });
  });

  it('the reserved tables exist with row-level security on', async () => {
    const tables = [
      ['cfg', 'automation_rule'],
      ['cfg', 'automation_run'],
      ['cfg', 'service_catalog_item'],
      ['cfg', 'service_request'],
      ['cfg', 'report_schedule'],
      ['cfg', 'dashboard'],
      ['cfg', 'dashboard_widget'],
      ['cfg', 'semantic_measure'],
      ['cfg', 'semantic_dimension'],
      ['cfg', 'retention_policy'],
      ['cfg', 'retention_run'],
      ['integration', 'adapter_config'],
      ['integration', 'integration_health'],
    ];
    const res = await owner.query<{ s: string; t: string; rls: boolean }>(
      `SELECT n.nspname AS s, c.relname AS t, c.relrowsecurity AS rls
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('cfg', 'integration')`,
    );
    for (const [s, t] of tables) {
      const row = res.rows.find((r) => r.s === s && r.t === t);
      expect(row, `${s}.${t}`).toBeDefined();
      expect(row?.rls, `${s}.${t} RLS`).toBe(true);
    }
  });

  it('keeps one active adapter per kind and a semantic reference that is not SQL', async () => {
    await owner.query(
      `INSERT INTO integration.adapter_config (tenant_id, adapter_kind, provider, active)
       VALUES ($1, 'sms', 'stub_a', true)`,
      [f.tenantA],
    );
    await expect(
      owner.query(
        `INSERT INTO integration.adapter_config (tenant_id, adapter_kind, provider, active)
         VALUES ($1, 'sms', 'stub_b', true)`,
        [f.tenantA],
      ),
    ).rejects.toMatchObject({ constraint: 'adapter_config_active_uq' });
    await expect(
      owner.query(
        `INSERT INTO cfg.semantic_measure (tenant_id, key, label, sql_ref, aggregation)
         VALUES ($1, 'bad', '{"en":"x"}', 'v; DROP TABLE x', 'sum')`,
        [f.tenantA],
      ),
    ).rejects.toThrow();
  });
});
