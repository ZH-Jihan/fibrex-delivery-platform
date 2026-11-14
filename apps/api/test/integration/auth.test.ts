/**
 * Authentication and sessions (Phase 1, commit 7a), end to end over HTTP against real
 * PostgreSQL and Redis: sign-in, lockout, login history, refresh rotation with reuse
 * detection, CSRF, forced password change, password policy, sessions and remote sign-out.
 *
 * All users and passwords are invented for the test.
 */
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { API_PREFIX, createApp } from '../../src/app.js';
import { AccessTokens } from '../../src/kernel/auth/access-token.js';
import {
  createAuthRouter,
  CSRF_COOKIE,
  REFRESH_COOKIE,
} from '../../src/kernel/auth/auth-router.js';
import { AuthService } from '../../src/kernel/auth/auth-service.js';
import { authenticate } from '../../src/kernel/auth/authenticate.js';
import { hashPassword } from '../../src/kernel/auth/password-hasher.js';
import { loadEnv } from '../../src/kernel/config/env.js';
import { createPool, type Pool } from '../../src/kernel/db/pool.js';
import { createPrisma } from '../../src/kernel/db/prisma.js';
import { UnitOfWork } from '../../src/kernel/db/unit-of-work.js';
import { createLogger } from '../../src/kernel/observability/logger.js';
import { createRedis } from '../../src/kernel/redis/client.js';
import { createFixture, type Fixture } from './fixtures.js';
import { connectionUrl } from './global-setup.js';
import { connect, testDatabase } from './helpers.js';
import { TEST_AUTH_ENV } from './test-env.js';

const ALICE_PASSWORD = 'alice-synthetic-pass-1';
const BOB_PASSWORD = 'bob-synthetic-pass-1';
const MAX_ATTEMPTS = 3;

let owner: pg.Client;
let pool: Pool;
let redis: Redis;
let f: Fixture;
let app: Express;
let limitedApp: Express;
let slugA: string;
let slugB: string;

function buildApp(over: Record<string, string> = {}): Express {
  const env = loadEnv({
    DATABASE_URL: 'postgresql://unused@localhost:1/x',
    REDIS_URL: 'redis://localhost:1',
    ...TEST_AUTH_ENV,
    RATE_LIMIT_ANONYMOUS: '10000',
    AUTH_RATE_LIMIT: '10000',
    AUTH_MAX_FAILED_ATTEMPTS: String(MAX_ATTEMPTS),
    AUTH_PASSWORD_HISTORY: '2',
    ...over,
  });
  const logger = createLogger({ level: 'silent', pretty: false, serviceName: 'test' });
  const prisma = createPrisma(pool);
  const tokens = new AccessTokens(env.AUTH_TOKEN_SECRET, env.AUTH_ACCESS_TTL_SECONDS);
  const auth = new AuthService({ prisma, uow: new UnitOfWork(prisma), redis, tokens, env });
  return createApp({
    env,
    logger,
    redis,
    readinessChecks: [],
    authenticate: authenticate({ tokens, redis }),
    mountApi: (api, registry) => {
      api.use(
        createAuthRouter({ auth, registry, redis, logger, env, cookiePath: `${API_PREFIX}/auth` }),
      );
    },
  });
}

interface SignIn {
  status: number;
  body: Record<string, unknown>;
  access: string;
  refresh: string | undefined;
  csrf: string | undefined;
  setCookie: string[];
}

function cookieValue(setCookie: string[], name: string): string | undefined {
  const line = setCookie.find((c) => c.startsWith(`${name}=`));
  const value = line?.slice(name.length + 1).split(';')[0];
  return value === undefined || value === '' ? undefined : value;
}

function toSignIn(res: request.Response): SignIn {
  const raw = res.headers['set-cookie'] as string[] | string | undefined;
  const setCookie = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const body = res.body as Record<string, unknown>;
  return {
    status: res.status,
    body,
    access: typeof body.accessToken === 'string' ? body.accessToken : '',
    refresh: cookieValue(setCookie, REFRESH_COOKIE),
    csrf: cookieValue(setCookie, CSRF_COOKIE),
    setCookie,
  };
}

async function login(tenant: string, identifier: string, password: string): Promise<SignIn> {
  return toSignIn(
    await request(app).post(`${API_PREFIX}/auth/login`).send({ tenant, identifier, password }),
  );
}

async function refresh(
  session: Pick<SignIn, 'refresh' | 'csrf'>,
  sendCsrf = true,
): Promise<SignIn> {
  const req = request(app)
    .post(`${API_PREFIX}/auth/refresh`)
    .set(
      'Cookie',
      `${REFRESH_COOKIE}=${session.refresh ?? ''}; ${CSRF_COOKIE}=${session.csrf ?? ''}`,
    );
  if (sendCsrf) void req.set('X-CSRF-Token', session.csrf ?? '');
  return toSignIn(await req);
}

const get = (path: string, access?: string) => {
  const req = request(app).get(`${API_PREFIX}${path}`);
  return access === undefined ? req : req.set('Authorization', `Bearer ${access}`);
};

async function setPassword(
  userId: string,
  tenantId: string,
  password: string,
  mustChange: boolean,
) {
  await owner.query(
    `INSERT INTO iam.credential (tenant_id, user_id, kind, hash) VALUES ($1, $2, 'password', $3)`,
    [tenantId, userId, await hashPassword(password)],
  );
  await owner.query(`UPDATE iam.user_account SET must_change_password = $2 WHERE id = $1`, [
    userId,
    mustChange,
  ]);
}

const unlock = (userId: string) =>
  owner.query(
    `UPDATE iam.user_account SET locked_until = NULL, failed_attempts = 0 WHERE id = $1`,
    [userId],
  );

beforeAll(async () => {
  owner = await connect('owner');
  f = await createFixture(owner);
  const db = testDatabase();
  pool = createPool(connectionUrl(db, db.app), 3);
  redis = createRedis(inject('redisUrl'), 'fibrex-test-auth');

  const slugs = await owner.query<{ id: string; slug: string }>(
    `SELECT id, slug FROM platform.tenant WHERE id IN ($1, $2)`,
    [f.tenantA, f.tenantB],
  );
  slugA = slugs.rows.find((r) => r.id === f.tenantA)?.slug ?? '';
  slugB = slugs.rows.find((r) => r.id === f.tenantB)?.slug ?? '';

  // Alice: normal user, admin in company A1. Bob: must change his password first.
  await setPassword(f.userA, f.tenantA, ALICE_PASSWORD, false);
  await setPassword(f.userB, f.tenantB, BOB_PASSWORD, true);
  await owner.query(`UPDATE iam.user_account SET email = 'alice@example.test' WHERE id = $1`, [
    f.userA,
  ]);
  const roleId = randomUUID();
  const membershipId = randomUUID();
  await owner.query(
    `INSERT INTO iam.role (id, tenant_id, key, name) VALUES ($1, $2, 'admin', 'Admin')`,
    [roleId, f.tenantA],
  );
  await owner.query(
    `INSERT INTO iam.company_membership (id, tenant_id, user_id, company_id, is_default)
     VALUES ($1, $2, $3, $4, true)`,
    [membershipId, f.tenantA, f.userA, f.companyA1],
  );
  await owner.query(
    `INSERT INTO iam.membership_role (tenant_id, membership_id, role_id) VALUES ($1, $2, $3)`,
    [f.tenantA, membershipId, roleId],
  );

  app = buildApp();
  limitedApp = buildApp({ AUTH_RATE_LIMIT: '2', TRUST_PROXY_HOPS: '1' });
});

afterAll(async () => {
  await redis.quit();
  await pool.end();
  await owner.end();
});

describe('sign-in', () => {
  it('signs in and identifies the caller, company and roles', async () => {
    const s = await login(slugA, 'alice', ALICE_PASSWORD);
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ companyId: f.companyA1, roles: ['admin'], expiresIn: 900 });
    expect(s.body).not.toHaveProperty('refreshToken');
    expect(s.body.csrfToken).toBe(s.csrf);

    const refreshCookie = s.setCookie.find((c) => c.startsWith(`${REFRESH_COOKIE}=`)) ?? '';
    expect(refreshCookie).toContain('HttpOnly');
    expect(refreshCookie).toContain('SameSite=Strict');
    expect(refreshCookie).toContain(`Path=${API_PREFIX}/auth`);
    const csrfCookie = s.setCookie.find((c) => c.startsWith(`${CSRF_COOKIE}=`)) ?? '';
    expect(csrfCookie).not.toContain('HttpOnly');

    const me = await get('/me', s.access);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      user: { id: f.userA, username: 'alice', mustChangePassword: false },
      companyId: f.companyA1,
      roles: ['admin'],
    });
  });

  it('accepts the email address as the identifier', async () => {
    expect((await login(slugA, 'Alice@Example.test', ALICE_PASSWORD)).status).toBe(200);
  });

  it('gives one indistinguishable answer for every kind of failure', async () => {
    const wrongPassword = await login(slugA, 'alice', 'not-the-password');
    const unknownUser = await login(slugA, 'nobody-here', ALICE_PASSWORD);
    const unknownTenant = await login('no-such-tenant', 'alice', ALICE_PASSWORD);
    // Alice exists only in tenant A: tenant B must not find her.
    const otherTenant = await login(slugB, 'alice', ALICE_PASSWORD);
    for (const s of [wrongPassword, unknownUser, unknownTenant, otherTenant]) {
      expect(s.status).toBe(401);
      expect(s.body.code).toBe('invalid_credentials');
      expect(s.body.detail).toBe(wrongPassword.body.detail);
      expect(s.setCookie).toEqual([]);
    }
    await unlock(f.userA);
  });

  it('refuses requests without a token, or with a forged one', async () => {
    expect((await get('/me')).status).toBe(401);
    const s = await login(slugA, 'alice', ALICE_PASSWORD);
    const [h, p, sig] = s.access.split('.') as [string, string, string];
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>;
    const forged = Buffer.from(JSON.stringify({ ...claims, tid: f.tenantB })).toString('base64url');
    expect((await get('/me', `${h}.${forged}.${sig}`)).status).toBe(401);
  });

  it('records every attempt in the login history, including failures', async () => {
    await login(slugA, 'alice', 'wrong-for-history');
    await unlock(f.userA);
    const s = await login(slugA, 'alice', ALICE_PASSWORD);
    const history = await get('/me/login-history?limit=5', s.access);
    expect(history.status).toBe(200);
    const results = (history.body as { items: { result: string }[] }).items.map((e) => e.result);
    expect(results.slice(0, 2)).toEqual(['success', 'bad_credentials']);
  });

  it('locks the account after repeated wrong passwords, even for the right one', async () => {
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      expect((await login(slugA, 'alice', `wrong-guess-${String(i)}`)).status).toBe(401);
    }
    const locked = await login(slugA, 'alice', ALICE_PASSWORD);
    expect(locked.status).toBe(401);
    expect(locked.body.code).toBe('invalid_credentials');
    const event = await owner.query<{ result: string }>(
      `SELECT result FROM iam.login_event WHERE user_id = $1 ORDER BY at DESC LIMIT 1`,
      [f.userA],
    );
    expect(event.rows[0]?.result).toBe('locked');

    await unlock(f.userA);
    expect((await login(slugA, 'alice', ALICE_PASSWORD)).status).toBe(200);
  });

  it('applies the stricter sign-in rate limit per address', async () => {
    // A client address of its own, so earlier sign-ins in this file are not counted.
    const address = `203.0.113.${String(1 + Math.floor(Math.random() * 250))}`;
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await request(limitedApp)
        .post(`${API_PREFIX}/auth/login`)
        .set('X-Forwarded-For', address)
        .send({ tenant: 'no-such-tenant', identifier: 'someone', password: 'whatever-pass' });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([401, 401, 429]);
  });
});

describe('refresh tokens', () => {
  it('stores only a hash of the refresh token', async () => {
    const s = await login(slugA, 'alice', ALICE_PASSWORD);
    const rows = await owner.query(`SELECT 1 FROM iam.refresh_token WHERE token_hash = $1`, [
      s.refresh,
    ]);
    expect(rows.rowCount).toBe(0);
  });

  it('requires the CSRF header that matches the cookie', async () => {
    const s = await login(slugA, 'alice', ALICE_PASSWORD);
    const noHeader = await refresh(s, false);
    expect(noHeader.status).toBe(403);
    expect(noHeader.body.code).toBe('csrf_failed');
    const wrong = await refresh({ refresh: s.refresh, csrf: 'something-else' });
    // Cookie and header agree with each other here, so this passes CSRF: the check
    // proves the caller can read the cookie, and the refresh token is the credential.
    expect(wrong.status).toBe(200);
  });

  it('rotates: a new token each time, and the session keeps working', async () => {
    const s = await login(slugA, 'alice', ALICE_PASSWORD);
    const r1 = await refresh(s);
    expect(r1.status).toBe(200);
    expect(r1.refresh).toBeDefined();
    expect(r1.refresh).not.toBe(s.refresh);
    expect((await get('/me', r1.access)).status).toBe(200);
    const r2 = await refresh(r1);
    expect(r2.status).toBe(200);
  });

  it('treats a reused token as theft: the whole session ends', async () => {
    const s = await login(slugA, 'alice', ALICE_PASSWORD);
    const r1 = await refresh(s);
    expect(r1.status).toBe(200);

    const replay = await refresh(s); // the old, already-used token again
    expect(replay.status).toBe(401);
    // The legitimate holder is cut off too: newest refresh token and access token.
    expect((await refresh(r1)).status).toBe(401);
    expect((await get('/me', r1.access)).status).toBe(401);

    const session = await owner.query<{ revoke_reason: string | null }>(
      `SELECT s.revoke_reason FROM iam.session s
         JOIN iam.refresh_token t ON t.session_id = s.id WHERE t.token_hash = encode(sha256($1::bytea), 'hex')`,
      [Buffer.from(s.refresh ?? '')],
    );
    expect(session.rows[0]?.revoke_reason).toBe('refresh_token_reuse');
  });

  it('refuses an expired token and a made-up one', async () => {
    const s = await login(slugA, 'alice', ALICE_PASSWORD);
    await owner.query(
      `UPDATE iam.refresh_token SET expires_at = now() - interval '1 minute'
        WHERE token_hash = encode(sha256($1::bytea), 'hex')`,
      [Buffer.from(s.refresh ?? '')],
    );
    expect((await refresh(s)).status).toBe(401);
    expect((await refresh({ refresh: `${f.tenantA}.made-up-token`, csrf: 'x' })).status).toBe(401);
    expect((await refresh({ refresh: 'garbage', csrf: 'x' })).status).toBe(401);
  });
});

describe('sessions', () => {
  it('lists sessions, signs one out remotely, and hides other users sessions', async () => {
    const here = await login(slugA, 'alice', ALICE_PASSWORD);
    const there = await login(slugA, 'alice', ALICE_PASSWORD);
    const list = await get('/me/sessions', here.access);
    expect(list.status).toBe(200);
    const items = (list.body as { items: { id: string; current: boolean }[] }).items;
    expect(items.filter((i) => i.current)).toHaveLength(1);
    const thereId = ((await get('/me', there.access)).body as { sessionId: string }).sessionId;
    expect(items.map((i) => i.id)).toContain(thereId);

    const remove = (id: string) =>
      request(app)
        .delete(`${API_PREFIX}/me/sessions/${id}`)
        .set('Authorization', `Bearer ${here.access}`)
        .set('Idempotency-Key', randomUUID());
    expect((await remove(thereId)).status).toBe(204);
    expect((await get('/me', there.access)).status).toBe(401);
    expect((await refresh(there)).status).toBe(401);
    expect((await get('/me', here.access)).status).toBe(200);

    // A session of another tenant's user looks exactly like one that does not exist.
    const bob = await login(slugB, 'bob', BOB_PASSWORD);
    const bobId = ((await get('/me', bob.access)).body as { sessionId: string }).sessionId;
    expect((await remove(bobId)).status).toBe(404);
    expect((await get('/me', bob.access)).status).toBe(200);
  });

  it('logout ends the session and clears the cookies', async () => {
    const s = await login(slugA, 'alice', ALICE_PASSWORD);
    const out = await request(app)
      .post(`${API_PREFIX}/auth/logout`)
      .set('Cookie', `${REFRESH_COOKIE}=${s.refresh ?? ''}; ${CSRF_COOKIE}=${s.csrf ?? ''}`)
      .set('X-CSRF-Token', s.csrf ?? '');
    expect(out.status).toBe(204);
    expect(cookieValue(toSignIn(out).setCookie, REFRESH_COOKIE)).toBeUndefined();
    expect((await get('/me', s.access)).status).toBe(401);
    expect((await refresh(s)).status).toBe(401);
  });
});

describe('passwords', () => {
  const change = (access: string, currentPassword: string, newPassword: string) =>
    request(app)
      .post(`${API_PREFIX}/auth/password/change`)
      .set('Authorization', `Bearer ${access}`)
      .send({ currentPassword, newPassword });

  it('forces a password change before anything else, then lifts the restriction', async () => {
    const bob = await login(slugB, 'bob', BOB_PASSWORD);
    expect(bob.status).toBe(200);
    expect(bob.body).toMatchObject({
      user: { mustChangePassword: true },
      companyId: null,
      roles: [],
    });
    expect((await get('/me', bob.access)).status).toBe(200);
    const blocked = await get('/me/sessions', bob.access);
    expect(blocked.status).toBe(403);
    expect((blocked.body as { code: string }).code).toBe('password_change_required');

    expect((await change(bob.access, BOB_PASSWORD, 'short-one')).status).toBe(400);
    const reused = await change(bob.access, BOB_PASSWORD, BOB_PASSWORD);
    expect(reused.status).toBe(422);
    expect((reused.body as { code: string }).code).toBe('password_reused');
    const wrongCurrent = await change(bob.access, 'not-bobs-password', 'bob-synthetic-pass-2');
    expect(wrongCurrent.status).toBe(422);
    expect((wrongCurrent.body as { code: string }).code).toBe('current_password_incorrect');

    const ok = await change(bob.access, BOB_PASSWORD, 'bob-synthetic-pass-2');
    expect(ok.status).toBe(200);
    const fresh = (ok.body as { accessToken: string }).accessToken;
    expect((await get('/me/sessions', fresh)).status).toBe(200);

    expect((await login(slugB, 'bob', BOB_PASSWORD)).status).toBe(401);
    const again = await login(slugB, 'bob', 'bob-synthetic-pass-2');
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ user: { mustChangePassword: false } });
    // History: the previous password cannot come straight back.
    expect((await change(again.access, 'bob-synthetic-pass-2', BOB_PASSWORD)).status).toBe(422);
  });

  it('signs out the other sessions when the password changes', async () => {
    const here = await login(slugA, 'alice', ALICE_PASSWORD);
    const there = await login(slugA, 'alice', ALICE_PASSWORD);
    const ok = await change(here.access, ALICE_PASSWORD, 'alice-synthetic-pass-2');
    expect(ok.status).toBe(200);
    expect((await get('/me', there.access)).status).toBe(401);
    expect((await refresh(there)).status).toBe(401);
    expect((await get('/me', here.access)).status).toBe(200);
    expect((await refresh(here)).status).toBe(200);
  });

  it('counts wrong current passwords towards the lock', async () => {
    const s = await login(slugA, 'alice', 'alice-synthetic-pass-2');
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      expect(
        (await change(s.access, `wrong-current-${String(i)}`, 'alice-synthetic-pass-3')).status,
      ).toBe(422);
    }
    expect((await login(slugA, 'alice', 'alice-synthetic-pass-2')).status).toBe(401);
    await unlock(f.userA);
  });
});
