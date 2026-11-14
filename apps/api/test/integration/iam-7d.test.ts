/**
 * IAM part 7d, end to end over HTTP against real PostgreSQL and Redis: impersonation
 * (rules, restrictions, both identities in the audit trail, ending it) and API clients
 * with keys (scopes, anti-escalation, issuing, using, revoking, disabling, rate limit).
 *
 * People (all invented), tenant A, company A1:
 *   alice  super_admin (every permission)
 *   carol  admin: manage users with the "user" role, impersonate, manage API clients
 *   dave   "user": no permissions
 * Tenant B: bob, super_admin (for the isolation checks).
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
import { createApiClientRouter } from '../../src/kernel/auth/api-client-router.js';
import { ApiKeyResolver } from '../../src/kernel/auth/api-keys.js';
import { createAuthRouter } from '../../src/kernel/auth/auth-router.js';
import { AuthService } from '../../src/kernel/auth/auth-service.js';
import { authenticate } from '../../src/kernel/auth/authenticate.js';
import { createImpersonationRouter } from '../../src/kernel/auth/impersonation.js';
import { MfaFactors } from '../../src/kernel/auth/mfa.js';
import { hashPassword } from '../../src/kernel/auth/password-hasher.js';
import { createUserAdminRouter } from '../../src/kernel/auth/user-admin-router.js';
import { loadEnv } from '../../src/kernel/config/env.js';
import { SecretBox } from '../../src/kernel/crypto/secret-box.js';
import { createPool, type Pool } from '../../src/kernel/db/pool.js';
import { createPrisma } from '../../src/kernel/db/prisma.js';
import { UnitOfWork } from '../../src/kernel/db/unit-of-work.js';
import { createLogger } from '../../src/kernel/observability/logger.js';
import { AccessAdminService } from '../../src/kernel/permissions/access-admin-service.js';
import { syncPermissionCatalogue } from '../../src/kernel/permissions/catalogue.js';
import { PermissionService } from '../../src/kernel/permissions/permission-service.js';
import { createRedis } from '../../src/kernel/redis/client.js';
import { createFixture, type Fixture } from './fixtures.js';
import { connectionUrl } from './global-setup.js';
import { connect, testDatabase } from './helpers.js';
import { TEST_AUTH_ENV } from './test-env.js';

const PASSWORD = 'synthetic-pass-7d-1';
const IMPERSONATION_TTL = 1800;

let owner: pg.Client;
let pool: Pool;
let redis: Redis;
let f: Fixture;
let app: Express;
let slugA: string;
let slugB: string;

const ids = {
  carol: randomUUID(),
  dave: randomUUID(),
  superAdmin: randomUUID(),
  admin: randomUUID(),
  user: randomUUID(),
  superAdminB: randomUUID(),
};

type Json = Record<string, unknown>;
const auth = (req: request.Test, token: string) => req.set('Authorization', `Bearer ${token}`);
const get = (path: string, token: string) => auth(request(app).get(`${API_PREFIX}${path}`), token);
const post = (path: string, token: string, body: Json = {}) =>
  auth(request(app).post(`${API_PREFIX}${path}`), token)
    .set('Idempotency-Key', randomUUID())
    .send(body);
const del = (path: string, token: string) =>
  auth(request(app).delete(`${API_PREFIX}${path}`), token).set('Idempotency-Key', randomUUID());
const patch = (path: string, token: string, version: number, body: Json) =>
  auth(request(app).patch(`${API_PREFIX}${path}`), token)
    .set('Idempotency-Key', randomUUID())
    .set('If-Match', `"${String(version)}"`)
    .send(body);
const codeOf = (res: request.Response) => (res.body as { code?: string }).code;

async function signIn(tenant: string, identifier: string, reauth = false): Promise<string> {
  const res = await request(app)
    .post(`${API_PREFIX}/auth/login`)
    .send({ tenant, identifier, password: PASSWORD });
  expect(res.status).toBe(200);
  const token = (res.body as { accessToken: string }).accessToken;
  if (reauth) {
    const r = await post('/auth/reauth', token, { password: PASSWORD });
    expect(r.status).toBe(200);
  }
  return token;
}

async function addUser(id: string, tenantId: string, username: string) {
  await owner.query(
    `INSERT INTO iam.user_account (id, tenant_id, username, display_name, must_change_password)
     VALUES ($1, $2, $3, $4, false)
     ON CONFLICT (id) DO UPDATE SET must_change_password = false`,
    [id, tenantId, username, `${username} test`],
  );
  await owner.query(
    `INSERT INTO iam.credential (tenant_id, user_id, kind, hash) VALUES ($1, $2, 'password', $3)`,
    [tenantId, id, await hashPassword(PASSWORD)],
  );
}

async function addMembership(tenantId: string, userId: string, companyId: string, roleId: string) {
  const membershipId = randomUUID();
  await owner.query(
    `INSERT INTO iam.company_membership (id, tenant_id, user_id, company_id, is_default)
     VALUES ($1, $2, $3, $4, true)`,
    [membershipId, tenantId, userId, companyId],
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
  redis = createRedis(inject('redisUrl'), 'fibrex-test-iam-7d');
  const prisma = createPrisma(pool);
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
    'iam.user.lock',
    'iam.user.impersonate',
    'iam.api_client.read',
    'iam.api_client.create',
    'iam.api_client.update',
    'iam.api_client.manage_keys',
  ]);
  await owner.query(
    `INSERT INTO iam.role_grantable (tenant_id, grantor_role_id, grantable_role_id) VALUES ($1, $2, $3)`,
    [f.tenantA, ids.admin, ids.user],
  );

  await addUser(f.userA, f.tenantA, 'alice');
  await addUser(f.userB, f.tenantB, 'bob');
  await addUser(ids.carol, f.tenantA, 'carol');
  await addUser(ids.dave, f.tenantA, 'dave');
  await addMembership(f.tenantA, f.userA, f.companyA1, ids.superAdmin);
  await addMembership(f.tenantA, ids.carol, f.companyA1, ids.admin);
  await addMembership(f.tenantA, ids.dave, f.companyA1, ids.user);
  await addMembership(f.tenantB, f.userB, f.companyB1, ids.superAdminB);

  const env = loadEnv({
    DATABASE_URL: 'postgresql://unused@localhost:1/x',
    REDIS_URL: 'redis://localhost:1',
    ...TEST_AUTH_ENV,
    RATE_LIMIT_ANONYMOUS: '10000',
    RATE_LIMIT_AUTHENTICATED: '10000',
    AUTH_RATE_LIMIT: '10000',
    AUTH_IMPERSONATION_TTL_SECONDS: String(IMPERSONATION_TTL),
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
      api.use(createUserAdminRouter({ uow, registry, permissions, admin, auth: authService }));
      api.use(
        createImpersonationRouter({
          uow,
          registry,
          permissions,
          admin,
          auth: authService,
          tokens,
          env,
        }),
      );
      api.use(createApiClientRouter({ uow, registry, permissions, auth: authService }));
      api.use(
        createAuditRouter({
          uow,
          registry,
          authorize: permissions.authorize,
          audit: createAuditService(),
          recycleBin: new RecycleBin(),
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

interface Started {
  impersonationId: string;
  accessToken: string;
  expiresIn: number;
  user: { id: string };
  roles: string[];
}

describe('impersonation', () => {
  it('needs recent re-authentication', async () => {
    const alice = await signIn(slugA, 'alice');
    const res = await post('/impersonations', alice, { userId: ids.dave, reason: 'support call' });
    expect(res.status).toBe(403);
    expect(codeOf(res)).toBe('reauth_required');
  });

  it('refuses yourself, a user you may not manage, and other tenants', async () => {
    const alice = await signIn(slugA, 'alice', true);
    const self = await post('/impersonations', alice, { userId: f.userA, reason: 'support' });
    expect(self.status).toBe(403);
    const otherTenant = await post('/impersonations', alice, { userId: f.userB, reason: 'xx' });
    expect(otherTenant.status).toBe(400); // reason too short
    const bob = await post('/impersonations', alice, { userId: f.userB, reason: 'support' });
    expect(bob.status).toBe(404);

    // carol may manage "user" holders only: alice (super_admin) is out of reach.
    const carol = await signIn(slugA, 'carol', true);
    const up = await post('/impersonations', carol, { userId: f.userA, reason: 'support' });
    expect(up.status).toBe(403);
    // dave has no impersonation permission at all.
    const dave = await signIn(slugA, 'dave');
    const none = await post('/impersonations', dave, { userId: ids.carol, reason: 'support' });
    expect(none.status).toBe(403);
  });

  it('acts as the target, logs both identities, and ends cleanly', async () => {
    const alice = await signIn(slugA, 'alice', true);
    const res = await post('/impersonations', alice, {
      userId: ids.dave,
      reason: 'Dave cannot see his payslip',
    });
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const started = res.body as Started;
    expect(started.user.id).toBe(ids.dave);
    expect(started.roles).toEqual(['user']);
    expect(started.expiresIn).toBe(IMPERSONATION_TTL);
    const token = started.accessToken;

    const me = await get('/me', token);
    expect(me.status).toBe(200);
    expect((me.body as { user: { id: string } }).user.id).toBe(ids.dave);
    // dave's permissions, not alice's.
    expect((await get('/users', token)).status).toBe(403);

    // Things that act on the account itself, not as it, are closed.
    for (const [method, path] of [
      ['post', '/auth/reauth'],
      ['post', '/me/switch-company'],
      ['post', '/impersonations'],
      ['get', '/api-clients'],
    ] as const) {
      const r =
        method === 'get'
          ? await get(path, token)
          : await post(path, token, { password: PASSWORD, userId: ids.carol, reason: 'again' });
      expect(r.status, path).toBe(403);
      expect(codeOf(r), path).toBe('impersonation_restricted');
    }

    // The start is recorded under alice alone.
    const startRow = await owner.query<{ user_id: string; impersonator_id: string | null }>(
      `SELECT user_id, impersonator_id FROM audit.audit_log
        WHERE entity_type = 'iam.impersonation' AND entity_id = $1 AND action = 'create'`,
      [started.impersonationId],
    );
    expect(startRow.rows).toEqual([{ user_id: f.userA, impersonator_id: null }]);

    const end = await del('/impersonations/current', token);
    expect(end.status).toBe(204);
    expect((await get('/me', token)).status).toBe(401);

    const row = await owner.query<{ ended_at: Date | null; reason: string }>(
      `SELECT ended_at, reason FROM iam.impersonation WHERE id = $1`,
      [started.impersonationId],
    );
    expect(row.rows[0]?.ended_at).not.toBeNull();
    // Changes made while impersonating carry both identities.
    const endRow = await owner.query<{ user_id: string; impersonator_id: string }>(
      `SELECT user_id, impersonator_id FROM audit.audit_log
        WHERE entity_type = 'iam.impersonation' AND entity_id = $1 AND action = 'update'`,
      [started.impersonationId],
    );
    expect(endRow.rows).toEqual([{ user_id: ids.dave, impersonator_id: f.userA }]);

    // alice's own session never changed.
    expect((await get('/users', alice)).status).toBe(200);
  });

  it('DELETE /impersonations/current with a normal token is a conflict', async () => {
    const alice = await signIn(slugA, 'alice');
    const res = await del('/impersonations/current', alice);
    expect(res.status).toBe(409);
    expect(codeOf(res)).toBe('not_impersonating');
  });

  it('signing the administrator out also ends the sessions they impersonate in', async () => {
    const carol = await signIn(slugA, 'carol', true);
    const res = await post('/impersonations', carol, { userId: ids.dave, reason: 'support' });
    expect(res.status).toBe(201);
    const token = (res.body as Started).accessToken;
    expect((await get('/me', token)).status).toBe(200);

    const alice = await signIn(slugA, 'alice');
    const out = await post(`/users/${ids.carol}/force-logout`, alice);
    expect(out.status).toBe(200);
    expect((await get('/me', token)).status).toBe(401);
  });
});

interface Client {
  id: string;
  kind: string;
  scopes: string[];
  version: number;
}
interface IssuedKey {
  id: string;
  key: string;
  keyPrefix: string;
}

describe('API clients and keys', () => {
  let alice: string;
  let client: Client;

  beforeAll(async () => {
    alice = await signIn(slugA, 'alice', true);
  });

  it('refuses identity permissions and unknown keys as scopes', async () => {
    const iam = await post('/api-clients', alice, { name: 'Bad', scopes: ['iam.user.read'] });
    expect(iam.status).toBe(400);
    const unknown = await post('/api-clients', alice, { name: 'Bad', scopes: ['no.such.key'] });
    expect(unknown.status).toBe(400);
    const kind = await post('/api-clients', alice, {
      name: 'Bad',
      scopes: [],
      kind: 'oauth_client',
    });
    expect(kind.status).toBe(400);
  });

  it('refuses scopes the creator does not hold', async () => {
    const carol = await signIn(slugA, 'carol');
    const res = await post('/api-clients', carol, { name: 'Escalate', scopes: ['audit.log.read'] });
    expect(res.status).toBe(403);
  });

  it('creates a client of kind api_key', async () => {
    const res = await post('/api-clients', alice, {
      name: 'Telematics bridge',
      scopes: ['audit.log.read', 'audit.log.read'],
      rateLimitPerMinute: 5,
    });
    expect(res.status).toBe(201);
    client = res.body as Client;
    expect(client.kind).toBe('api_key');
    expect(client.scopes).toEqual(['audit.log.read']);
  });

  it('issues a key only after re-authentication, and shows it once', async () => {
    const fresh = await signIn(slugA, 'alice');
    const denied = await post(`/api-clients/${client.id}/keys`, fresh);
    expect(denied.status).toBe(403);
    expect(codeOf(denied)).toBe('reauth_required');

    const res = await post(`/api-clients/${client.id}/keys`, alice);
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const issued = res.body as IssuedKey;
    expect(issued.key).toMatch(/^fbx_[A-Za-z0-9_-]{43}$/);
    expect(issued.key.startsWith(issued.keyPrefix)).toBe(true);

    const list = await get(`/api-clients/${client.id}/keys`, alice);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(issued.key);
    const stored = await owner.query<{ key_hash: string }>(
      `SELECT key_hash FROM iam.api_key WHERE id = $1`,
      [issued.id],
    );
    expect(stored.rows[0]?.key_hash).not.toContain(issued.key.slice(4));
  });

  it('a key acts within its scopes and company, and is rate limited per client', async () => {
    const key = ((await post(`/api-clients/${client.id}/keys`, alice)).body as IssuedKey).key;

    const ok = await get('/audit-log?pageSize=1', key);
    expect(ok.status).toBe(200);
    expect((await get('/users', key)).status).toBe(403);
    // A client is not a user: no /me, no user routes.
    expect((await get('/me', key)).status).toBe(401);
    // Another tenant's admin cannot see this client.
    const bob = await signIn(slugB, 'bob');
    expect((await get(`/api-clients/${client.id}`, bob)).status).toBe(404);

    // The limit is 5 per minute and every call counts, refused ones too: 3 used above.
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) codes.push((await get('/audit-log?pageSize=1', key)).status);
    expect(codes).toEqual([200, 200, 429]);

    const used = await owner.query<{ last_used_at: Date | null }>(
      `SELECT last_used_at FROM iam.api_key WHERE company_id = $1 AND api_client_id = $2
        ORDER BY created_at DESC LIMIT 1`,
      [f.companyA1, client.id],
    );
    expect(used.rows[0]?.last_used_at).not.toBeNull();
  });

  it('unknown, revoked, expired keys and disabled clients are refused at once', async () => {
    const res = await post('/api-clients', alice, {
      name: 'Short lived',
      scopes: ['audit.log.read'],
    });
    const c = res.body as Client;
    const issue = async () => (await post(`/api-clients/${c.id}/keys`, alice)).body as IssuedKey;

    expect((await get('/audit-log', `fbx_${'A'.repeat(43)}`)).status).toBe(401);

    const revoked = await issue();
    expect((await get('/audit-log?pageSize=1', revoked.key)).status).toBe(200);
    expect((await del(`/api-clients/${c.id}/keys/${revoked.id}`, alice)).status).toBe(204);
    expect((await get('/audit-log?pageSize=1', revoked.key)).status).toBe(401);

    const expired = await issue();
    await owner.query(
      `UPDATE iam.api_key SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [expired.id],
    );
    expect((await get('/audit-log?pageSize=1', expired.key)).status).toBe(401);

    const live = await issue();
    expect((await get('/audit-log?pageSize=1', live.key)).status).toBe(200);
    const disabled = await patch(`/api-clients/${c.id}`, alice, c.version, { status: 'disabled' });
    expect(disabled.status).toBe(200);
    expect((await get('/audit-log?pageSize=1', live.key)).status).toBe(401);
  });

  it('a past expiry date is refused when issuing', async () => {
    const res = await post(`/api-clients/${client.id}/keys`, alice, {
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(res.status).toBe(400);
  });
});
