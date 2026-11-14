/**
 * IAM part 7c, end to end over HTTP against real PostgreSQL and Redis: the permission
 * catalogue and matrix, `can()` enforced on the API, per-user overrides, data scopes,
 * user and role administration with its anti-escalation rules, and switching company.
 *
 * People (all invented), tenant A:
 *   alice  super_admin in A1 (default) and "user" in A2
 *   carol  admin in A1: may manage users, and may give out only the "user" role
 *   dave   "user" in A1: no permissions until the tests give him some
 * Tenant B: bob, super_admin in B1 (for the isolation checks).
 */
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { OutboundMessage } from '../../src/adapters/messaging/interface.js';
import { API_PREFIX, createApp } from '../../src/app.js';
import { AccessTokens } from '../../src/kernel/auth/access-token.js';
import { createAuthRouter } from '../../src/kernel/auth/auth-router.js';
import { AuthService } from '../../src/kernel/auth/auth-service.js';
import { authenticate } from '../../src/kernel/auth/authenticate.js';
import { MfaFactors } from '../../src/kernel/auth/mfa.js';
import { hashPassword } from '../../src/kernel/auth/password-hasher.js';
import { createUserAdminRouter } from '../../src/kernel/auth/user-admin-router.js';
import { loadEnv } from '../../src/kernel/config/env.js';
import { SecretBox } from '../../src/kernel/crypto/secret-box.js';
import { createPool, type Pool } from '../../src/kernel/db/pool.js';
import { createPrisma } from '../../src/kernel/db/prisma.js';
import { UnitOfWork } from '../../src/kernel/db/unit-of-work.js';
import { createLogger } from '../../src/kernel/observability/logger.js';
import { createAccessAdminRouter } from '../../src/kernel/permissions/access-admin-router.js';
import { AccessAdminService } from '../../src/kernel/permissions/access-admin-service.js';
import {
  KERNEL_PERMISSIONS,
  syncPermissionCatalogue,
} from '../../src/kernel/permissions/catalogue.js';
import { PermissionService } from '../../src/kernel/permissions/permission-service.js';
import { createRedis } from '../../src/kernel/redis/client.js';
import { createFixture, type Fixture } from './fixtures.js';
import { connectionUrl } from './global-setup.js';
import { connect, testDatabase } from './helpers.js';
import { TEST_AUTH_ENV } from './test-env.js';

const PASSWORD = 'synthetic-pass-7c-1';

let owner: pg.Client;
let pool: Pool;
let redis: Redis;
let f: Fixture;
let app: Express;
let slugA: string;
let slugB: string;
const sent: OutboundMessage[] = [];

const ids = {
  carol: randomUUID(),
  dave: randomUUID(),
  superAdmin: randomUUID(),
  admin: randomUUID(),
  user: randomUUID(),
  superAdminB: randomUUID(),
};

type Json = Record<string, unknown>;
const send = (method: 'post' | 'put' | 'patch' | 'delete', path: string, access: string) => {
  const agent = request(app);
  return agent[method](`${API_PREFIX}${path}`)
    .set('Authorization', `Bearer ${access}`)
    .set('Idempotency-Key', randomUUID());
};
const get = (path: string, access: string) =>
  request(app).get(`${API_PREFIX}${path}`).set('Authorization', `Bearer ${access}`);
const post = (path: string, access: string, body: Json = {}) =>
  send('post', path, access).send(body);
const put = (path: string, access: string, body: Json) => send('put', path, access).send(body);
const codeOf = (res: request.Response) => (res.body as { code?: string }).code;

/** Signs in and returns the access token. */
async function signIn(tenant: string, identifier: string): Promise<string> {
  const res = await request(app)
    .post(`${API_PREFIX}/auth/login`)
    .send({ tenant, identifier, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.body as { accessToken: string }).accessToken;
}

/** Signs in and re-authenticates, so sensitive actions are allowed. */
async function signInSensitive(tenant: string, identifier: string): Promise<string> {
  const access = await signIn(tenant, identifier);
  const res = await request(app)
    .post(`${API_PREFIX}/auth/reauth`)
    .set('Authorization', `Bearer ${access}`)
    .send({ password: PASSWORD });
  expect(res.status).toBe(200);
  return access;
}

const tick = (access: string, roleId: string, permissionKey: string, granted: boolean) =>
  put('/permission-matrix', access, { changes: [{ roleId, permissionKey, granted }] });

async function addUser(id: string, tenantId: string, username: string, email?: string) {
  await owner.query(
    `INSERT INTO iam.user_account (id, tenant_id, username, display_name, email, must_change_password)
     VALUES ($1, $2, $3, $4, $5, false)
     ON CONFLICT (id) DO UPDATE SET must_change_password = false, email = EXCLUDED.email`,
    [id, tenantId, username, `${username} test`, email ?? null],
  );
  await owner.query(
    `INSERT INTO iam.credential (tenant_id, user_id, kind, hash) VALUES ($1, $2, 'password', $3)`,
    [tenantId, id, await hashPassword(PASSWORD)],
  );
}

async function addMembership(
  tenantId: string,
  userId: string,
  companyId: string,
  roleId: string,
  isDefault: boolean,
) {
  const membershipId = randomUUID();
  await owner.query(
    `INSERT INTO iam.company_membership (id, tenant_id, user_id, company_id, is_default)
     VALUES ($1, $2, $3, $4, $5)`,
    [membershipId, tenantId, userId, companyId, isDefault],
  );
  await owner.query(
    `INSERT INTO iam.membership_role (tenant_id, membership_id, role_id) VALUES ($1, $2, $3)`,
    [tenantId, membershipId, roleId],
  );
}

async function grantKeys(tenantId: string, roleId: string, keys: readonly string[] | 'all') {
  await owner.query(
    `INSERT INTO iam.role_permission (tenant_id, role_id, permission_id)
     SELECT $1, $2, id FROM iam.permission WHERE $3::text[] IS NULL OR key = ANY ($3::text[])`,
    [tenantId, roleId, keys === 'all' ? null : keys],
  );
}

beforeAll(async () => {
  owner = await connect('owner');
  f = await createFixture(owner);
  const db = testDatabase();
  pool = createPool(connectionUrl(db, db.app), 3);
  redis = createRedis(inject('redisUrl'), 'fibrex-test-iam-admin');
  const prisma = createPrisma(pool);

  // The catalogue is written by the application role, exactly as at start-up. Twice, to
  // show a second start changes nothing.
  await syncPermissionCatalogue(prisma);
  await syncPermissionCatalogue(prisma);

  const slugs = await owner.query<{ id: string; slug: string }>(
    `SELECT id, slug FROM platform.tenant WHERE id IN ($1, $2)`,
    [f.tenantA, f.tenantB],
  );
  slugA = slugs.rows.find((r) => r.id === f.tenantA)?.slug ?? '';
  slugB = slugs.rows.find((r) => r.id === f.tenantB)?.slug ?? '';

  await owner.query(
    `INSERT INTO iam.role (id, tenant_id, key, name, is_builtin) VALUES
       ($1, $4, 'super_admin', 'Super Admin', true),
       ($2, $4, 'admin', 'Admin', true),
       ($3, $4, 'user', 'User', true),
       ($5, $6, 'super_admin', 'Super Admin', true)`,
    [ids.superAdmin, ids.admin, ids.user, f.tenantA, ids.superAdminB, f.tenantB],
  );
  await grantKeys(f.tenantA, ids.superAdmin, 'all');
  await grantKeys(f.tenantB, ids.superAdminB, 'all');
  await grantKeys(f.tenantA, ids.admin, [
    'iam.user.read',
    'iam.user.create',
    'iam.user.update',
    'iam.user.delete',
    'iam.user.lock',
    'iam.user.reset_password',
    'iam.user.manage_access',
    'iam.role.read',
  ]);
  await owner.query(
    `INSERT INTO iam.role_grantable (tenant_id, grantor_role_id, grantable_role_id) VALUES ($1, $2, $3)`,
    [f.tenantA, ids.admin, ids.user],
  );

  await addUser(f.userA, f.tenantA, 'alice');
  await addUser(f.userB, f.tenantB, 'bob');
  await addUser(ids.carol, f.tenantA, 'carol');
  await addUser(ids.dave, f.tenantA, 'dave');
  await addMembership(f.tenantA, f.userA, f.companyA1, ids.superAdmin, true);
  await addMembership(f.tenantA, f.userA, f.companyA2, ids.user, false);
  await addMembership(f.tenantA, ids.carol, f.companyA1, ids.admin, true);
  await addMembership(f.tenantA, ids.dave, f.companyA1, ids.user, true);
  await addMembership(f.tenantB, f.userB, f.companyB1, ids.superAdminB, true);

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
  const auth = new AuthService({
    prisma,
    uow,
    redis,
    tokens,
    mfa,
    messaging: {
      send: (message) => {
        sent.push(message);
        return Promise.resolve();
      },
    },
    logger,
    env,
  });
  const permissions = new PermissionService(uow);
  const admin = new AccessAdminService({ permissions });
  app = createApp({
    env,
    logger,
    redis,
    readinessChecks: [],
    authenticate: authenticate({ tokens, redis }),
    mountApi: (api, registry) => {
      api.use(
        createAuthRouter({ auth, registry, redis, logger, env, cookiePath: `${API_PREFIX}/auth` }),
      );
      api.use(createUserAdminRouter({ uow, registry, permissions, admin, auth }));
      api.use(createAccessAdminRouter({ uow, registry, permissions, admin, auth }));
    },
  });
});

afterAll(async () => {
  // Every request here counts against this machine's address in the shared Redis. Clear
  // those counters so test files that check low rate limits start from zero.
  const counters = await redis.keys('rl:*');
  if (counters.length > 0) await redis.del(...counters);
  await redis.quit();
  await pool.end();
  await owner.end();
});

describe('permission catalogue', () => {
  it('holds every kernel permission exactly once after two syncs', async () => {
    const keys = KERNEL_PERMISSIONS.map((p) => p.key);
    const rows = await owner.query<{ key: string; version: number }>(
      `SELECT key, version FROM iam.permission WHERE key = ANY ($1::text[])`,
      [keys],
    );
    expect(rows.rows.map((r) => r.key).sort()).toEqual([...keys].sort());
    // The second sync found nothing to change, so no version moved.
    expect(rows.rows.every((r) => r.version === 1)).toBe(true);
  });

  it('is listed for someone who may see the matrix, and refused otherwise', async () => {
    const alice = await signIn(slugA, 'alice');
    const res = await get('/permissions', alice);
    expect(res.status).toBe(200);
    const keys = (res.body as { items: { key: string }[] }).items.map((i) => i.key);
    expect(keys).toContain('iam.permission_matrix.update');
    expect((await get('/permissions', await signIn(slugA, 'dave'))).status).toBe(403);
  });

  it('answers 401 without a token', async () => {
    expect((await request(app).get(`${API_PREFIX}/users`)).status).toBe(401);
    expect((await request(app).get(`${API_PREFIX}/me/permissions`)).status).toBe(401);
  });
});

describe('permission matrix and can() on the API', () => {
  it('tells each user what they may do', async () => {
    const alice = (await get('/me/permissions', await signIn(slugA, 'alice'))).body as {
      roles: string[];
      permissions: string[];
      companyId: string;
    };
    expect(alice.roles).toEqual(['super_admin']);
    expect(alice.companyId).toBe(f.companyA1);
    expect(alice.permissions).toEqual(expect.arrayContaining(KERNEL_PERMISSIONS.map((p) => p.key)));
    const dave = (await get('/me/permissions', await signIn(slugA, 'dave'))).body as {
      roles: string[];
      permissions: string[];
      scopes: unknown[];
    };
    expect(dave).toMatchObject({ roles: ['user'], permissions: [] });
    // A role with no scope rows is not restricted.
    expect(dave.scopes).toEqual([{ all: true, own: false, platform: [], zone: [], branch: [] }]);
  });

  it('needs re-authentication before the matrix can be changed', async () => {
    const alice = await signIn(slugA, 'alice');
    const res = await tick(alice, ids.user, 'iam.user.read', true);
    expect(res.status).toBe(403);
    expect(codeOf(res)).toBe('reauth_required');
  });

  it('a ticked box lets the role in at once; unticking it gives 403 on the next request', async () => {
    const alice = await signInSensitive(slugA, 'alice');
    const dave = await signIn(slugA, 'dave');
    expect((await get('/users', dave)).status).toBe(403);

    const granted = await tick(alice, ids.user, 'iam.user.read', true);
    expect(granted.status).toBe(200);
    expect(granted.body).toEqual({ granted: 1, revoked: 0 });
    // Same token as before: permissions are read from the database, not from the token.
    expect((await get('/users', dave)).status).toBe(200);
    // Saving the same state again writes nothing.
    expect((await tick(alice, ids.user, 'iam.user.read', true)).body).toEqual({
      granted: 0,
      revoked: 0,
    });

    const matrix = (await get('/permission-matrix', alice)).body as {
      grants: { roleId: string; permissionKey: string }[];
    };
    expect(matrix.grants).toContainEqual({ roleId: ids.user, permissionKey: 'iam.user.read' });

    expect((await tick(alice, ids.user, 'iam.user.read', false)).body).toEqual({
      granted: 0,
      revoked: 1,
    });
    expect((await get('/users', dave)).status).toBe(403);
    // Nothing was physically deleted: the row is still there, marked deleted.
    const kept = await owner.query(
      `SELECT 1 FROM iam.role_permission rp JOIN iam.permission p ON p.id = rp.permission_id
       WHERE rp.role_id = $1 AND p.key = 'iam.user.read' AND rp.deleted_at IS NOT NULL`,
      [ids.user],
    );
    expect(kept.rowCount).toBe(1);
  });

  it('refuses a save that would lock the saver out, and saves none of it', async () => {
    const alice = await signInSensitive(slugA, 'alice');
    const res = await put('/permission-matrix', alice, {
      changes: [
        { roleId: ids.user, permissionKey: 'iam.role.read', granted: true },
        { roleId: ids.superAdmin, permissionKey: 'iam.permission_matrix.update', granted: false },
      ],
    });
    expect(res.status).toBe(422);
    expect(codeOf(res)).toBe('would_lock_out');
    const matrix = (await get('/permission-matrix', alice)).body as {
      grants: { roleId: string; permissionKey: string }[];
    };
    expect(matrix.grants).toContainEqual({
      roleId: ids.superAdmin,
      permissionKey: 'iam.permission_matrix.update',
    });
    expect(matrix.grants).not.toContainEqual({ roleId: ids.user, permissionKey: 'iam.role.read' });
  });

  it('rejects unknown roles and permissions, and someone without the permission', async () => {
    const alice = await signInSensitive(slugA, 'alice');
    expect((await tick(alice, randomUUID(), 'iam.user.read', true)).status).toBe(400);
    expect((await tick(alice, ids.user, 'no.such_permission', true)).status).toBe(400);
    // A role of another tenant is as good as unknown.
    expect((await tick(alice, ids.superAdminB, 'iam.user.read', true)).status).toBe(400);
    const carol = await signInSensitive(slugA, 'carol');
    expect((await tick(carol, ids.admin, 'iam.permission_matrix.update', true)).status).toBe(403);
  });
});

describe('per-user overrides', () => {
  const overrides = (access: string, userId: string, list: Json[]) =>
    put(`/users/${userId}/permission-overrides`, access, { overrides: list });

  it('a deny beats the role grant, and a grant adds what no role gives', async () => {
    const alice = await signInSensitive(slugA, 'alice');
    const carol = await signIn(slugA, 'carol');
    const dave = await signIn(slugA, 'dave');
    expect((await get('/users', carol)).status).toBe(200);
    expect((await get('/users', dave)).status).toBe(403);

    const denied = await overrides(alice, ids.carol, [
      { permissionKey: 'iam.user.read', effect: 'deny', reason: 'under review' },
    ]);
    expect(denied.status).toBe(200);
    expect((await get('/users', carol)).status).toBe(403);

    expect(
      (await overrides(alice, ids.dave, [{ permissionKey: 'iam.user.read', effect: 'grant' }]))
        .status,
    ).toBe(200);
    expect((await get('/users', dave)).status).toBe(200);

    // Removing them puts both back where their roles leave them.
    expect((await overrides(alice, ids.carol, [])).status).toBe(200);
    expect((await overrides(alice, ids.dave, [])).body).toEqual({ overrides: [] });
    expect((await get('/users', carol)).status).toBe(200);
    expect((await get('/users', dave)).status).toBe(403);
  });

  it('cannot be used to gain or hand out more than the caller has', async () => {
    const carol = await signInSensitive(slugA, 'carol');
    // Not on yourself.
    expect(
      (
        await overrides(carol, ids.carol, [
          { permissionKey: 'iam.permission_matrix.update', effect: 'grant' },
        ])
      ).status,
    ).toBe(403);
    // Not a permission the caller does not hold.
    expect(
      (
        await overrides(carol, ids.dave, [
          { permissionKey: 'iam.permission_matrix.update', effect: 'grant' },
        ])
      ).status,
    ).toBe(403);
    // Not on someone whose role the caller may not manage.
    expect(
      (await overrides(carol, f.userA, [{ permissionKey: 'iam.user.read', effect: 'deny' }]))
        .status,
    ).toBe(403);
    // One she holds, on someone she may manage, is fine.
    const ok = await overrides(carol, ids.dave, [
      { permissionKey: 'iam.role.read', effect: 'grant' },
    ]);
    expect(ok.status).toBe(200);
    expect((await overrides(carol, ids.dave, [])).status).toBe(200);
  });
});

describe('users', () => {
  let erin = '';
  let erinVersion = 0;

  it('an admin creates an account, which has no password yet', async () => {
    const carol = await signIn(slugA, 'carol');
    const res = await post('/users', carol, {
      username: 'Erin',
      displayName: 'Erin Test',
      email: 'Erin@Example.test',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      username: 'erin',
      email: 'erin@example.test',
      status: 'active',
      mustChangePassword: true,
    });
    erin = (res.body as { id: string }).id;
    erinVersion = (res.body as { version: number }).version;
    const credentials = await owner.query(`SELECT 1 FROM iam.credential WHERE user_id = $1`, [
      erin,
    ]);
    expect(credentials.rowCount).toBe(0);
    // The same username again is a conflict, not a second account.
    expect((await post('/users', carol, { username: 'erin', displayName: 'x' })).status).toBe(409);
    // Someone without the permission cannot create accounts.
    const dave = await signIn(slugA, 'dave');
    expect((await post('/users', dave, { username: 'frank', displayName: 'x' })).status).toBe(403);
  });

  it('updates with the version check, and never the username', async () => {
    const carol = await signIn(slugA, 'carol');
    const patch = (body: Json, version: number) =>
      send('patch', `/users/${erin}`, carol)
        .set('If-Match', `"${String(version)}"`)
        .send(body);
    expect((await patch({ username: 'other' }, erinVersion)).status).toBe(400);
    const ok = await patch({ displayName: 'Erin Renamed' }, erinVersion);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ displayName: 'Erin Renamed', username: 'erin' });
    expect((await patch({ displayName: 'Stale' }, erinVersion)).status).toBe(409);
    erinVersion = (ok.body as { version: number }).version;
  });

  it('an admin cannot touch a super admin, and nobody their own account', async () => {
    const carol = await signInSensitive(slugA, 'carol');
    const row = await owner.query<{ version: number }>(
      `SELECT version FROM iam.user_account WHERE id = $1`,
      [f.userA],
    );
    const version = `"${String(row.rows[0]?.version)}"`;
    const takeover = await send('patch', `/users/${f.userA}`, carol)
      .set('If-Match', version)
      .send({ email: 'carol-owned@example.test' });
    expect(takeover.status).toBe(403);
    expect((await post(`/users/${f.userA}/lock`, carol)).status).toBe(403);
    expect((await post(`/users/${f.userA}/reset-password`, carol)).status).toBe(403);
    expect((await post(`/users/${f.userA}/force-logout`, carol)).status).toBe(403);
    const del = await send('delete', `/users/${f.userA}`, carol)
      .set('If-Match', version)
      .send({ reason: 'takeover attempt' });
    expect(del.status).toBe(403);
    expect((await post(`/users/${ids.carol}/lock`, carol)).status).toBe(403);
    const alice = await owner.query<{ email: string | null; status: string }>(
      `SELECT email, status FROM iam.user_account WHERE id = $1`,
      [f.userA],
    );
    expect(alice.rows[0]).toEqual({ email: null, status: 'active' });
  });

  it('sends a reset link instead of setting a password, after re-authentication', async () => {
    const plain = await signIn(slugA, 'carol');
    const refused = await post(`/users/${erin}/reset-password`, plain);
    expect(refused.status).toBe(403);
    expect(codeOf(refused)).toBe('reauth_required');

    sent.length = 0;
    const carol = await signInSensitive(slugA, 'carol');
    const res = await post(`/users/${erin}/reset-password`, carol);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ channel: 'email' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'erin@example.test', purpose: 'password_reset' });
    // The link is not in the answer to the administrator.
    expect(JSON.stringify(res.body)).not.toContain('token');
    // Dave has neither email nor phone: the administrator is told nothing was sent.
    const none = await post(`/users/${ids.dave}/reset-password`, carol);
    expect(none.status).toBe(422);
    expect(codeOf(none)).toBe('reset_not_sent');
  });

  it('locking ends the sessions at once and blocks sign-in; unlocking restores it', async () => {
    const alice = await signIn(slugA, 'alice');
    const dave = await signIn(slugA, 'dave');
    expect((await get('/me', dave)).status).toBe(200);
    expect(
      ((await get(`/users/${ids.dave}/sessions`, alice)).body as { items: unknown[] }).items.length,
    ).toBeGreaterThan(0);

    const locked = await post(`/users/${ids.dave}/lock`, alice);
    expect(locked.status).toBe(200);
    expect(locked.body).toMatchObject({ status: 'disabled' });
    expect((await get('/me', dave)).status).toBe(401);
    const blocked = await request(app)
      .post(`${API_PREFIX}/auth/login`)
      .send({ tenant: slugA, identifier: 'dave', password: PASSWORD });
    expect(blocked.status).toBe(401);
    expect(
      ((await get(`/users/${ids.dave}/sessions`, alice)).body as { items: unknown[] }).items,
    ).toEqual([]);

    expect((await post(`/users/${ids.dave}/unlock`, alice)).body).toMatchObject({
      status: 'active',
    });
    const again = await signIn(slugA, 'dave');
    const ended = await post(`/users/${ids.dave}/force-logout`, alice);
    expect(ended.body).toEqual({ sessionsEnded: 1 });
    expect((await get('/me', again)).status).toBe(401);
    const history = await get(`/users/${ids.dave}/login-history`, alice);
    expect((history.body as { items: unknown[] }).items.length).toBeGreaterThan(1);
  });

  it('gives out only the roles, and only in the company, the caller is allowed', async () => {
    const carol = await signInSensitive(slugA, 'carol');
    const save = (access: string, memberships: Json[]) =>
      put(`/users/${erin}/memberships`, access, { memberships });
    const inA1 = (roleIds: string[]) => ({
      companyId: f.companyA1,
      roleIds,
      isDefault: true,
      status: 'active',
    });

    expect((await save(carol, [inA1([ids.admin])])).status).toBe(403);
    expect((await save(carol, [inA1([ids.superAdmin])])).status).toBe(403);
    expect((await save(carol, [{ ...inA1([ids.user]), companyId: f.companyA2 }])).status).toBe(403);
    // Two defaults, or none, is not a valid set.
    expect((await save(carol, [{ ...inA1([ids.user]), isDefault: false }])).status).toBe(400);

    const ok = await save(carol, [inA1([ids.user])]);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      memberships: [{ companyId: f.companyA1, roleIds: [ids.user], isDefault: true }],
    });

    // A super admin may use any role and any company of the tenant, but not another tenant's.
    const alice = await signInSensitive(slugA, 'alice');
    const both = await save(alice, [
      inA1([ids.user, ids.admin]),
      { companyId: f.companyA2, roleIds: [ids.user], isDefault: false, status: 'active' },
    ]);
    expect(both.status).toBe(200);
    expect((both.body as { memberships: unknown[] }).memberships).toHaveLength(2);
    expect(
      (
        await save(alice, [
          inA1([ids.user, ids.admin]),
          { companyId: f.companyB1, roleIds: [ids.user], isDefault: false, status: 'active' },
        ])
      ).status,
    ).toBe(400);

    // Erin now holds "admin", which carol may not give out, so carol may no longer manage her.
    expect((await save(carol, [inA1([ids.user])])).status).toBe(403);
    // Nobody edits their own roles.
    expect(
      (
        await put(`/users/${f.userA}/memberships`, alice, {
          memberships: [inA1([ids.superAdmin])],
        })
      ).status,
    ).toBe(403);

    // Removing a company soft-deletes the membership and its roles.
    expect((await save(alice, [inA1([ids.user])])).status).toBe(200);
    const removed = await owner.query(
      `SELECT 1 FROM iam.company_membership
       WHERE user_id = $1 AND company_id = $2 AND deleted_at IS NOT NULL`,
      [erin, f.companyA2],
    );
    expect(removed.rowCount).toBe(1);
  });

  it('deleting an account goes to the recycle bin and can be restored', async () => {
    const carol = await signIn(slugA, 'carol');
    const current = (await get(`/users/${erin}`, carol)).body as { version: number };
    const del = await send('delete', `/users/${erin}`, carol)
      .set('If-Match', `"${String(current.version)}"`)
      .send({ reason: 'left the company' });
    expect(del.status).toBe(204);
    expect((await get(`/users/${erin}`, carol)).status).toBe(404);
    const bin = (await get('/users?deleted=true', carol)).body as {
      items: { id: string; version: number }[];
    };
    const binned = bin.items.find((u) => u.id === erin);
    expect(binned).toBeDefined();
    // Carol has no restore permission; alice has.
    const restore = (access: string) =>
      send('post', `/users/${erin}/restore`, access).set(
        'If-Match',
        `"${String(binned?.version)}"`,
      );
    expect((await restore(carol)).status).toBe(403);
    expect((await restore(await signIn(slugA, 'alice'))).status).toBe(200);
  });

  it('never shows or reaches another tenant', async () => {
    const bob = await signInSensitive(slugB, 'bob');
    const list = (await get('/users', bob)).body as { items: { username: string }[] };
    expect(list.items.map((u) => u.username)).toEqual(['bob']);
    expect((await get(`/users/${f.userA}`, bob)).status).toBe(404);
    expect((await get(`/users/${f.userA}/memberships`, bob)).status).toBe(404);
    expect((await post(`/users/${ids.dave}/lock`, bob)).status).toBe(404);
    const matrix = (await get('/permission-matrix', bob)).body as { roles: { id: string }[] };
    expect(matrix.roles.map((r) => r.id)).toEqual([ids.superAdminB]);
  });
});

describe('roles', () => {
  it('creates custom roles; built-in and in-use roles cannot be deleted', async () => {
    const alice = await signInSensitive(slugA, 'alice');
    const created = await post('/roles', alice, { key: 'dispatcher', name: 'Dispatcher' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ key: 'dispatcher', isBuiltin: false });
    const role = created.body as { id: string; version: number };
    // isBuiltin and the key are not writable through the API.
    expect((await post('/roles', alice, { key: 'x1', name: 'X', isBuiltin: true })).status).toBe(
      400,
    );
    const renamed = await send('patch', `/roles/${role.id}`, alice)
      .set('If-Match', `"${String(role.version)}"`)
      .send({ key: 'other' });
    expect(renamed.status).toBe(400);

    const del = (id: string, version: number) =>
      send('delete', `/roles/${id}`, alice)
        .set('If-Match', `"${String(version)}"`)
        .send({ reason: 'no longer used' });
    const builtin = await del(ids.user, 1);
    expect(builtin.status).toBe(422);
    expect(codeOf(builtin)).toBe('builtin_role');

    // Give the new role to dave: now it is in use.
    const give = (roleIds: string[]) =>
      put(`/users/${ids.dave}/memberships`, alice, {
        memberships: [{ companyId: f.companyA1, roleIds, isDefault: true, status: 'active' }],
      });
    expect((await give([ids.user, role.id])).status).toBe(200);
    const inUse = await del(role.id, role.version);
    expect(inUse.status).toBe(409);
    expect(codeOf(inUse)).toBe('role_in_use');
    expect((await give([ids.user])).status).toBe(200);
    // Every deletion carries a reason.
    const noReason = await send('delete', `/roles/${role.id}`, alice).set(
      'If-Match',
      `"${String(role.version)}"`,
    );
    expect(noReason.status).toBe(400);
    expect((await del(role.id, role.version)).status).toBe(204);
  });

  it('only someone who may give any role decides what other roles may give out', async () => {
    const carol = await signInSensitive(slugA, 'carol');
    const alice = await signInSensitive(slugA, 'alice');
    const path = `/roles/${ids.admin}/grantable-roles`;
    expect((await get(path, carol)).body).toEqual({ roleIds: [ids.user] });
    expect((await put(path, carol, { roleIds: [ids.user, ids.superAdmin] })).status).toBe(403);
    const widened = await put(path, alice, { roleIds: [ids.user, ids.admin] });
    expect(widened.status).toBe(200);
    expect((widened.body as { roleIds: string[] }).roleIds.sort()).toEqual(
      [ids.user, ids.admin].sort(),
    );
    expect((await put(path, alice, { roleIds: [ids.user] })).body).toEqual({ roleIds: [ids.user] });
  });
});

describe('data scopes', () => {
  it('a scope on the user replaces the role scope and shows in their access', async () => {
    const alice = await signInSensitive(slugA, 'alice');
    const dave = await signIn(slugA, 'dave');
    const scopesOf = async () =>
      ((await get('/me/permissions', dave)).body as { scopes: unknown[] }).scopes;

    const role = await put(`/roles/${ids.user}/scopes`, alice, {
      scopes: [{ scopeKind: 'branch', values: [f.branchA1] }],
    });
    expect(role.status).toBe(200);
    expect(await scopesOf()).toEqual([
      { all: false, own: false, platform: [], zone: [], branch: [f.branchA1] },
    ]);

    const user = await put(`/users/${ids.dave}/scopes`, alice, {
      scopes: [{ scopeKind: 'own', values: [] }],
    });
    expect(user.status).toBe(200);
    expect(await scopesOf()).toEqual([
      { all: false, own: true, platform: [], zone: [], branch: [] },
    ]);

    expect((await put(`/users/${ids.dave}/scopes`, alice, { scopes: [] })).status).toBe(200);
    expect((await put(`/roles/${ids.user}/scopes`, alice, { scopes: [] })).body).toEqual({
      scopes: [],
    });
    expect(await scopesOf()).toEqual([
      { all: true, own: false, platform: [], zone: [], branch: [] },
    ]);
  });

  it('rejects scopes that make no sense', async () => {
    const alice = await signInSensitive(slugA, 'alice');
    const save = (scopes: Json[]) => put(`/users/${ids.dave}/scopes`, alice, { scopes });
    expect((await save([{ scopeKind: 'zone', values: [] }])).status).toBe(400);
    expect((await save([{ scopeKind: 'own', values: [f.branchA1] }])).status).toBe(400);
    // A branch of another company, and of another tenant.
    expect((await save([{ scopeKind: 'branch', values: [f.branchA2] }])).status).toBe(400);
    expect((await save([{ scopeKind: 'branch', values: [f.branchB1] }])).status).toBe(400);
    expect(
      (
        await save([
          { scopeKind: 'own', values: [] },
          { scopeKind: 'own', values: [] },
        ])
      ).status,
    ).toBe(400);
    // Nobody widens or narrows their own scope.
    expect(
      (await put(`/users/${f.userA}/scopes`, alice, { scopes: [{ scopeKind: 'all', values: [] }] }))
        .status,
    ).toBe(403);
  });
});

describe('switch company', () => {
  it('lists my companies and moves me to another one with the roles I hold there', async () => {
    const alice = await signIn(slugA, 'alice');
    const companies = (await get('/me/companies', alice)).body as {
      items: { id: string; current: boolean; isDefault: boolean }[];
    };
    expect(companies.items.map((c) => [c.id, c.current, c.isDefault])).toEqual([
      [f.companyA1, true, true],
      [f.companyA2, false, false],
    ]);

    // No Idempotency-Key is needed, and the answer sets the new session's cookies.
    const res = await request(app)
      .post(`${API_PREFIX}/me/switch-company`)
      .set('Authorization', `Bearer ${alice}`)
      .send({ companyId: f.companyA2 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ companyId: f.companyA2, roles: ['user'] });
    expect(String(res.headers['set-cookie'])).toContain('fibrex_refresh=');
    const inA2 = (res.body as { accessToken: string }).accessToken;

    // The old session is over; the new one has only what "user" gives in A2: nothing.
    expect((await get('/me', alice)).status).toBe(401);
    const access = (await get('/me/permissions', inA2)).body as {
      companyId: string;
      roles: string[];
      permissions: string[];
    };
    expect(access).toMatchObject({ companyId: f.companyA2, roles: ['user'], permissions: [] });
    expect((await get('/users', inA2)).status).toBe(403);
    const sessions = await owner.query<{ company_id: string; revoke_reason: string | null }>(
      `SELECT company_id, revoke_reason FROM iam.session
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT 2`,
      [f.userA],
    );
    expect(sessions.rows).toEqual([
      { company_id: f.companyA2, revoke_reason: null },
      { company_id: f.companyA1, revoke_reason: 'switched_company' },
    ]);
  });

  it('refuses a company I am not an active member of, and keeps my session', async () => {
    const dave = await signIn(slugA, 'dave');
    const to = (companyId: string) =>
      request(app)
        .post(`${API_PREFIX}/me/switch-company`)
        .set('Authorization', `Bearer ${dave}`)
        .send({ companyId });
    expect((await to(f.companyA2)).status).toBe(403);
    expect((await to(f.companyB1)).status).toBe(403);
    expect((await to(randomUUID())).status).toBe(403);
    expect((await to('not-a-uuid')).status).toBe(400);
    expect((await get('/me', dave)).status).toBe(200);
  });

  it('a suspended membership gives no access and cannot be switched to', async () => {
    await owner.query(
      `UPDATE iam.company_membership SET status = 'suspended' WHERE user_id = $1 AND company_id = $2`,
      [f.userA, f.companyA2],
    );
    const alice = await signIn(slugA, 'alice');
    const res = await request(app)
      .post(`${API_PREFIX}/me/switch-company`)
      .set('Authorization', `Bearer ${alice}`)
      .send({ companyId: f.companyA2 });
    expect(res.status).toBe(403);
    const companies = (await get('/me/companies', alice)).body as { items: { id: string }[] };
    expect(companies.items.map((c) => c.id)).toEqual([f.companyA1]);
  });
});
