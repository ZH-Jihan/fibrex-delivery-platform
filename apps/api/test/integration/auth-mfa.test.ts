/**
 * Authentication part 7b, end to end over HTTP against real PostgreSQL and Redis:
 * two-step verification (set up, sign in, replay, recovery codes, lockout, removal),
 * re-authentication, phone sign-in codes, and forgot/reset password.
 *
 * Messages are captured in memory instead of being sent. The authenticator "app" is the
 * test itself: it computes codes from the seed with a clock it can move forward, so no
 * test has to wait 30 seconds for a new code. All users are invented.
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
import {
  createAuthRouter,
  CSRF_COOKIE,
  REFRESH_COOKIE,
} from '../../src/kernel/auth/auth-router.js';
import { AuthService } from '../../src/kernel/auth/auth-service.js';
import { authenticate } from '../../src/kernel/auth/authenticate.js';
import { MfaFactors } from '../../src/kernel/auth/mfa.js';
import { hashPassword } from '../../src/kernel/auth/password-hasher.js';
import { totpCode, totpStep } from '../../src/kernel/auth/totp.js';
import { loadEnv } from '../../src/kernel/config/env.js';
import { SecretBox } from '../../src/kernel/crypto/secret-box.js';
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
const BOB_PHONE = '+97455500001';
const MAX_ATTEMPTS = 3;
const RESEND_SECONDS = 1;

/**
 * Waits until another code or link may be sent. Audit columns cannot be back-dated (the
 * database keeps created_at fixed), so the tests use a one-second gap and really wait.
 */
const waitForResendGap = () =>
  new Promise<void>((resolve) => setTimeout(resolve, RESEND_SECONDS * 1000 + 150));

let owner: pg.Client;
let pool: Pool;
let redis: Redis;
let f: Fixture;
let app: Express;
let slugA: string;
let slugB: string;
const sent: OutboundMessage[] = [];

// The clock the server's TOTP check uses. Moving it forward gives a brand-new code.
let skewMs = 0;
const clock = () => Date.now() + skewMs;

type Json = Record<string, unknown>;
const cookies = (res: request.Response): string[] => {
  const raw = res.headers['set-cookie'] as string[] | string | undefined;
  return raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
};
const post = (path: string, body: Json = {}, access?: string) => {
  const req = request(app).post(`${API_PREFIX}${path}`).send(body);
  return access === undefined ? req : req.set('Authorization', `Bearer ${access}`);
};
const get = (path: string, access: string) =>
  request(app).get(`${API_PREFIX}${path}`).set('Authorization', `Bearer ${access}`);
const del = (path: string, access: string) =>
  request(app).delete(`${API_PREFIX}${path}`).set('Authorization', `Bearer ${access}`);
const login = (tenant: string, identifier: string, password: string) =>
  post('/auth/login', { tenant, identifier, password });
const accessOf = (res: request.Response) => (res.body as { accessToken: string }).accessToken;
const codeOf = (res: request.Response) => (res.body as { code?: string }).code;

const unlock = (userId: string) =>
  owner.query(
    `UPDATE iam.user_account SET locked_until = NULL, failed_attempts = 0 WHERE id = $1`,
    [userId],
  );

function base32Decode(text: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of text) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** A code the app would show after the clock moved on one period (never seen before). */
function nextCode(seed: Buffer): string {
  skewMs += 30_000;
  return totpCode(seed, totpStep(clock()));
}

/** Six digits that are certainly not valid now. */
function wrongCode(seed: Buffer): string {
  const step = totpStep(clock());
  const valid = new Set([-2, -1, 0, 1, 2].map((d) => totpCode(seed, step + d)));
  let n = 0;
  while (valid.has(String(n).padStart(6, '0'))) n += 1;
  return String(n).padStart(6, '0');
}

/** Password sign-in for a user with an authenticator app: returns the MFA token. */
async function passwordStep(): Promise<string> {
  const res = await login(slugA, 'alice', ALICE_PASSWORD);
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ mfaRequired: true });
  return (res.body as { mfaToken: string }).mfaToken;
}

beforeAll(async () => {
  owner = await connect('owner');
  f = await createFixture(owner);
  const db = testDatabase();
  pool = createPool(connectionUrl(db, db.app), 3);
  redis = createRedis(inject('redisUrl'), 'fibrex-test-auth-mfa');

  const slugs = await owner.query<{ id: string; slug: string }>(
    `SELECT id, slug FROM platform.tenant WHERE id IN ($1, $2)`,
    [f.tenantA, f.tenantB],
  );
  slugA = slugs.rows.find((r) => r.id === f.tenantA)?.slug ?? '';
  slugB = slugs.rows.find((r) => r.id === f.tenantB)?.slug ?? '';

  // Alice: owner of company A1, a role that demands two-step verification.
  // Bob: no roles, has a phone and an email; signs in by phone code too.
  for (const [userId, tenantId, password] of [
    [f.userA, f.tenantA, ALICE_PASSWORD],
    [f.userB, f.tenantB, BOB_PASSWORD],
  ] as const) {
    await owner.query(
      `INSERT INTO iam.credential (tenant_id, user_id, kind, hash) VALUES ($1, $2, 'password', $3)`,
      [tenantId, userId, await hashPassword(password)],
    );
    await owner.query(`UPDATE iam.user_account SET must_change_password = false WHERE id = $1`, [
      userId,
    ]);
  }
  await owner.query(
    `UPDATE iam.user_account SET phone = $2, email = 'bob@example.test' WHERE id = $1`,
    [f.userB, BOB_PHONE],
  );
  const roleId = randomUUID();
  const membershipId = randomUUID();
  await owner.query(
    `INSERT INTO iam.role (id, tenant_id, key, name, mfa_required) VALUES ($1, $2, 'owner', 'Owner', true)`,
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

  const env = loadEnv({
    DATABASE_URL: 'postgresql://unused@localhost:1/x',
    REDIS_URL: 'redis://localhost:1',
    ...TEST_AUTH_ENV,
    RATE_LIMIT_ANONYMOUS: '10000',
    AUTH_RATE_LIMIT: '10000',
    AUTH_MAX_FAILED_ATTEMPTS: String(MAX_ATTEMPTS),
    AUTH_OTP_RESEND_SECONDS: String(RESEND_SECONDS),
    WEB_BASE_URL: 'https://app.example.test',
  });
  const logger = createLogger({ level: 'silent', pretty: false, serviceName: 'test' });
  const prisma = createPrisma(pool);
  const tokens = new AccessTokens(env.AUTH_TOKEN_SECRET, env.AUTH_ACCESS_TTL_SECONDS);
  const mfa = new MfaFactors({
    box: new SecretBox(env.DATA_ENCRYPTION_KEY),
    tokenSecret: env.AUTH_TOKEN_SECRET,
    issuer: env.AUTH_TOTP_ISSUER,
    now: clock,
  });
  const auth = new AuthService({
    prisma,
    uow: new UnitOfWork(prisma),
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
    },
  });
});

afterAll(async () => {
  await redis.quit();
  await pool.end();
  await owner.end();
});

describe('two-step verification', () => {
  let seed: Buffer;
  let lastAccepted = '';
  let recoveryCodes: string[] = [];

  it('makes a privileged user set it up before anything else', async () => {
    const s = await login(slugA, 'alice', ALICE_PASSWORD);
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ mfaEnrolmentRequired: true, roles: ['owner'] });
    const restricted = accessOf(s);
    expect((await get('/me', restricted)).status).toBe(200);
    const blocked = await get('/me/sessions', restricted);
    expect(blocked.status).toBe(403);
    expect(codeOf(blocked)).toBe('mfa_enrolment_required');

    // Starting twice is fine: only the latest seed counts.
    const first = await post('/auth/mfa/totp/setup', {}, restricted);
    const setup = await post('/auth/mfa/totp/setup', {}, restricted);
    expect(setup.status).toBe(200);
    const { secret, otpauthUrl } = setup.body as { secret: string; otpauthUrl: string };
    expect(secret).not.toBe((first.body as { secret: string }).secret);
    expect(otpauthUrl).toContain(`secret=${secret}`);
    seed = base32Decode(secret);

    // The old seed no longer confirms; neither does a wrong code.
    const oldSeed = base32Decode((first.body as { secret: string }).secret);
    const stale = await post('/auth/mfa/totp/confirm', { code: nextCode(oldSeed) }, restricted);
    expect(stale.status).toBe(422);
    expect(codeOf(stale)).toBe('mfa_code_incorrect');
    await unlock(f.userA);

    lastAccepted = nextCode(seed);
    const confirmed = await post('/auth/mfa/totp/confirm', { code: lastAccepted }, restricted);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({ mfaEnrolmentRequired: false });
    recoveryCodes = (confirmed.body as { recoveryCodes: string[] }).recoveryCodes;
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    expect(recoveryCodes[0]).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);

    // The fresh token is unrestricted, and /me reports the factor.
    const fresh = accessOf(confirmed);
    expect((await get('/me/sessions', fresh)).status).toBe(200);
    expect((await get('/me', fresh)).body).toMatchObject({
      mfaEnabled: true,
      mfaEnrolmentRequired: false,
    });
    // A second app cannot be added on top of a working one.
    const again = await post('/auth/mfa/totp/setup', {}, fresh);
    expect(again.status).toBe(409);
    expect(codeOf(again)).toBe('mfa_already_enabled');
  });

  it('stores the seed encrypted and recovery codes only as hashes', async () => {
    const factor = await owner.query<{ secret_encrypted: Buffer }>(
      `SELECT secret_encrypted FROM iam.mfa_factor
        WHERE user_id = $1 AND confirmed_at IS NOT NULL AND deleted_at IS NULL`,
      [f.userA],
    );
    expect(factor.rows).toHaveLength(1);
    expect(factor.rows[0]?.secret_encrypted.includes(seed)).toBe(false);
    const hashes = await owner.query<{ code_hash: string }>(
      `SELECT code_hash FROM iam.mfa_recovery_code WHERE user_id = $1 AND deleted_at IS NULL`,
      [f.userA],
    );
    expect(hashes.rows).toHaveLength(10);
    for (const row of hashes.rows) {
      expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(recoveryCodes.join(' ').replaceAll('-', '')).not.toContain(row.code_hash);
    }
  });

  it('opens no session on the password alone; the code completes the sign-in', async () => {
    const first = await login(slugA, 'alice', ALICE_PASSWORD);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ mfaRequired: true, expiresIn: 300 });
    expect(first.body).not.toHaveProperty('accessToken');
    expect(cookies(first)).toEqual([]);
    const { mfaToken } = first.body as { mfaToken: string };

    const wrong = await post('/auth/mfa/verify', { mfaToken, code: wrongCode(seed) });
    expect(wrong.status).toBe(401);
    expect(codeOf(wrong)).toBe('invalid_credentials');
    // Replay: the code that confirmed the setup is still inside the time window, but
    // was already accepted once.
    const replay = await post('/auth/mfa/verify', { mfaToken, code: lastAccepted });
    expect(replay.status).toBe(401);
    await unlock(f.userA);

    lastAccepted = nextCode(seed);
    const ok = await post('/auth/mfa/verify', { mfaToken, code: lastAccepted });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ companyId: f.companyA1, mfaEnrolmentRequired: false });
    const set = cookies(ok);
    expect(set.some((c) => c.startsWith(`${REFRESH_COOKIE}=`))).toBe(true);
    expect(set.some((c) => c.startsWith(`${CSRF_COOKIE}=`))).toBe(true);
    expect((await get('/me/sessions', accessOf(ok))).status).toBe(200);

    // The MFA token worked once and is gone.
    const reuse = await post('/auth/mfa/verify', { mfaToken, code: nextCode(seed) });
    expect(reuse.status).toBe(401);
    expect(codeOf(reuse)).toBe('mfa_challenge_expired');

    const history = await get('/me/login-history?limit=4', accessOf(ok));
    const results = (history.body as { items: { result: string }[] }).items.map((e) => e.result);
    expect(results).toEqual(['success', 'mfa_failed', 'mfa_failed', 'mfa_required']);
  });

  it('accepts a recovery code once, however it is typed', async () => {
    const code = recoveryCodes[0] ?? '';
    const typed = ` ${code.toLowerCase().replace('-', ' ')} `;
    const ok = await post('/auth/mfa/verify', { mfaToken: await passwordStep(), code: typed });
    expect(ok.status).toBe(200);
    const again = await post('/auth/mfa/verify', { mfaToken: await passwordStep(), code });
    expect(again.status).toBe(401);
    await unlock(f.userA);
  });

  it('locks the account after wrong codes; a correct password does not reset the count', async () => {
    const one = await passwordStep();
    for (let i = 0; i < MAX_ATTEMPTS - 1; i += 1) {
      expect(
        (await post('/auth/mfa/verify', { mfaToken: one, code: wrongCode(seed) })).status,
      ).toBe(401);
    }
    // Signing in with the password again must not buy more guesses.
    const two = await passwordStep();
    expect((await post('/auth/mfa/verify', { mfaToken: two, code: wrongCode(seed) })).status).toBe(
      401,
    );
    // Locked now: the right code and the right password are both refused.
    const right = await post('/auth/mfa/verify', { mfaToken: two, code: nextCode(seed) });
    expect(right.status).toBe(401);
    expect((await login(slugA, 'alice', ALICE_PASSWORD)).status).toBe(401);
    await unlock(f.userA);
  });

  it('needs a fresh re-authentication to remove the app, then demands a new one', async () => {
    const mfaToken = await passwordStep();
    const session = await post('/auth/mfa/verify', { mfaToken, code: nextCode(seed) });
    expect(session.status).toBe(200);
    const access = accessOf(session);

    const early = await del('/auth/mfa/totp', access);
    expect(early.status).toBe(403);
    expect(codeOf(early)).toBe('reauth_required');

    // With an authenticator app, the password alone is not enough to step up.
    expect((await post('/auth/reauth', { password: ALICE_PASSWORD }, access)).status).toBe(400);
    const badCode = await post('/auth/reauth', { code: wrongCode(seed) }, access);
    expect(badCode.status).toBe(422);
    expect(codeOf(badCode)).toBe('reauth_failed');
    await unlock(f.userA);
    const stepUp = await post('/auth/reauth', { code: nextCode(seed) }, access);
    expect(stepUp.status).toBe(200);
    expect(Date.parse((stepUp.body as { validUntil: string }).validUntil)).toBeGreaterThan(
      Date.now(),
    );

    // Another session of the same user has not stepped up.
    const other = await post('/auth/mfa/verify', {
      mfaToken: await passwordStep(),
      code: nextCode(seed),
    });
    expect((await del('/auth/mfa/totp', accessOf(other))).status).toBe(403);

    const removed = await del('/auth/mfa/totp', access);
    expect(removed.status).toBe(200);
    // Her role still demands it, so the new token can only set it up again.
    expect(removed.body).toMatchObject({ mfaEnrolmentRequired: true });
    const blocked = await get('/me/sessions', accessOf(removed));
    expect(codeOf(blocked)).toBe('mfa_enrolment_required');
    expect((await get('/me', accessOf(removed))).body).toMatchObject({ mfaEnabled: false });

    // Rows were retired, not deleted, and old recovery codes no longer work.
    const rows = await owner.query<{ live: string; retired: string }>(
      `SELECT count(*) FILTER (WHERE deleted_at IS NULL) AS live,
              count(*) FILTER (WHERE deleted_at IS NOT NULL) AS retired
         FROM iam.mfa_factor WHERE user_id = $1`,
      [f.userA],
    );
    expect(rows.rows[0]?.live).toBe('0');
    expect(Number(rows.rows[0]?.retired)).toBeGreaterThanOrEqual(2);
    const plain = await login(slugA, 'alice', ALICE_PASSWORD);
    expect(plain.body).toMatchObject({ mfaEnrolmentRequired: true });
    expect(plain.body).not.toHaveProperty('mfaRequired');
  });
});

describe('re-authentication without an authenticator app', () => {
  it('takes the password, and counts wrong ones', async () => {
    const s = await login(slugB, 'bob', BOB_PASSWORD);
    const access = accessOf(s);
    const wrong = await post('/auth/reauth', { password: 'not-bobs-password' }, access);
    expect(wrong.status).toBe(422);
    expect((await post('/auth/reauth', {}, access)).status).toBe(400);
    expect((await post('/auth/reauth', { password: BOB_PASSWORD }, access)).status).toBe(200);
    expect((await post('/auth/reauth', { password: BOB_PASSWORD })).status).toBe(401);
    await unlock(f.userB);
  });
});

describe('phone sign-in codes', () => {
  const request6 = (tenant: string, phone: string) => post('/auth/otp/request', { tenant, phone });
  const verify = (code: string) =>
    post('/auth/otp/verify', { tenant: slugB, phone: BOB_PHONE, code });
  const lastCode = () => /code is (\d{6})/.exec(sent.at(-1)?.text ?? '')?.[1] ?? '';
  const ageChallenges = waitForResendGap;

  it('sends a code by SMS, and answers the same for unknown numbers', async () => {
    sent.length = 0;
    const known = await request6(slugB, BOB_PHONE);
    const unknown = await request6(slugB, '+97455599999');
    const wrongTenant = await request6(slugA, BOB_PHONE);
    for (const res of [known, unknown, wrongTenant]) {
      expect(res.status).toBe(204);
      expect(res.text).toBe('');
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channel: 'sms', to: BOB_PHONE, purpose: 'login_code' });
    expect(lastCode()).toMatch(/^\d{6}$/);

    // Asking again straight away sends nothing more.
    expect((await request6(slugB, BOB_PHONE)).status).toBe(204);
    expect(sent).toHaveLength(1);

    const stored = await owner.query<{ code_hash: string }>(
      `SELECT code_hash FROM iam.otp_challenge WHERE phone = $1`,
      [BOB_PHONE],
    );
    expect(stored.rows[0]?.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await request6(slugB, 'not-a-phone')).status).toBe(400);
  });

  it('signs in with the code, once', async () => {
    const code = lastCode();
    const wrong = await verify(code === '000000' ? '000001' : '000000');
    expect(wrong.status).toBe(401);
    expect(codeOf(wrong)).toBe('invalid_credentials');

    const ok = await verify(code);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ user: { id: f.userB }, mfaEnrolmentRequired: false });
    expect(cookies(ok).some((c) => c.startsWith(`${REFRESH_COOKIE}=`))).toBe(true);
    const history = await get('/me/login-history?limit=2', accessOf(ok));
    expect((history.body as { items: Json[] }).items).toMatchObject([
      { method: 'otp', result: 'success' },
      { method: 'otp', result: 'bad_credentials' },
    ]);

    expect((await verify(code)).status).toBe(401);
    await unlock(f.userB);
  });

  it('only the newest code works, and an expired one does not', async () => {
    await ageChallenges();
    await request6(slugB, BOB_PHONE);
    const older = lastCode();
    await ageChallenges();
    await request6(slugB, BOB_PHONE);
    const newer = lastCode();
    expect(sent).toHaveLength(3);
    if (older !== newer) expect((await verify(older)).status).toBe(401);
    await unlock(f.userB);

    await owner.query(
      `UPDATE iam.otp_challenge SET expires_at = now() - interval '1 second'
        WHERE phone = $1 AND consumed_at IS NULL`,
      [BOB_PHONE],
    );
    expect((await verify(newer)).status).toBe(401);
    await unlock(f.userB);
  });

  it('wrong codes lock the account, and a locked account gets no new code', async () => {
    await ageChallenges();
    await request6(slugB, BOB_PHONE);
    const code = lastCode();
    const bad = code === '111111' ? '222222' : '111111';
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) expect((await verify(bad)).status).toBe(401);
    expect((await verify(code)).status).toBe(401);

    await ageChallenges();
    const before = sent.length;
    expect((await request6(slugB, BOB_PHONE)).status).toBe(204);
    expect(sent).toHaveLength(before);
    await unlock(f.userB);
  });
});

describe('forgotten password', () => {
  const NEW_PASSWORD = 'bob-synthetic-pass-2';
  const forgot = (tenant: string, identifier: string) =>
    post('/auth/password/forgot', { tenant, identifier });
  const reset = (token: string, newPassword: string) =>
    post('/auth/password/reset', { token, newPassword });
  const tokenInLastMessage = () =>
    /#token=([A-Za-z0-9._-]+)/.exec(sent.at(-1)?.text ?? '')?.[1] ?? '';

  it('sends a link to the account email, and answers the same for unknown accounts', async () => {
    sent.length = 0;
    for (const res of [
      await forgot(slugB, 'bob'),
      await forgot(slugB, 'nobody-here'),
      await forgot(slugA, 'bob'),
      await forgot('no-such-tenant', 'bob'),
    ]) {
      expect(res.status).toBe(204);
      expect(res.text).toBe('');
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      channel: 'email',
      to: 'bob@example.test',
      purpose: 'password_reset',
    });
    expect(sent[0]?.text).toContain('https://app.example.test/reset-password#token=');
    // Asking again straight away sends nothing more.
    await forgot(slugB, 'bob');
    expect(sent).toHaveLength(1);

    const stored = await owner.query<{ token_hash: string }>(
      `SELECT token_hash FROM iam.password_reset_token WHERE user_id = $1`,
      [f.userB],
    );
    expect(stored.rows[0]?.token_hash).not.toBe(tokenInLastMessage());
  });

  it('resets once, enforces the policy, and signs every session out', async () => {
    const token = tokenInLastMessage();
    const session = await login(slugB, 'bob', BOB_PASSWORD);
    expect(session.status).toBe(200);

    const bogus = await reset(`${f.tenantB}.${'x'.repeat(43)}`, NEW_PASSWORD);
    expect(bogus.status).toBe(422);
    expect(codeOf(bogus)).toBe('reset_token_invalid');
    // A password that breaks the policy does not use the link up.
    expect((await reset(token, 'short-one')).status).toBe(400);
    const reused = await reset(token, BOB_PASSWORD);
    expect(reused.status).toBe(422);
    expect(codeOf(reused)).toBe('password_reused');

    expect((await reset(token, NEW_PASSWORD)).status).toBe(204);
    expect((await get('/me', accessOf(session))).status).toBe(401);
    expect((await login(slugB, 'bob', BOB_PASSWORD)).status).toBe(401);
    expect((await login(slugB, 'bob', NEW_PASSWORD)).status).toBe(200);

    const again = await reset(token, 'bob-synthetic-pass-3');
    expect(again.status).toBe(422);
    expect(codeOf(again)).toBe('reset_token_invalid');
    await unlock(f.userB);
  });

  it('a newer link retires the older one, and an expired link is refused', async () => {
    const age = waitForResendGap;
    await age();
    await forgot(slugB, 'bob@example.test');
    const older = tokenInLastMessage();
    await age();
    await forgot(slugB, BOB_PHONE);
    const newer = tokenInLastMessage();
    expect(sent).toHaveLength(3);
    expect(newer).not.toBe(older);
    expect((await reset(older, 'bob-synthetic-pass-4')).status).toBe(422);

    await owner.query(
      `UPDATE iam.password_reset_token SET expires_at = now() - interval '1 second'
        WHERE user_id = $1 AND used_at IS NULL`,
      [f.userB],
    );
    expect((await reset(newer, 'bob-synthetic-pass-4')).status).toBe(422);
    expect((await login(slugB, 'bob', NEW_PASSWORD)).status).toBe(200);
  });
});
