/**
 * Row 4.6b: the daily performance summary email, driven through the real job
 * (`SummaryService.runDue`, the function the scheduler calls), the real routes and the real
 * permission service, against PostgreSQL and Redis with a fixed clock and a capturing mailer.
 *
 * Checked: not sent before the local send time; the full summary with hand-computed figures
 * (people with orders, orders, hours, best, weakest, zero-order people, unmatched IDs note);
 * one send per company and date (second tick, "Send now" after the schedule); the "data
 * incomplete" variant for a partial sync (scheduled) and a failed sync and a missing sync
 * (manual), with no figures in it; no recipients (nothing sent or logged, 422 on "Send now",
 * and adding an address later still sends); a failed send rolls the claim back and the next
 * tick sends; settings validation and permissions.
 * Everything is invented: tenant A, company A1, people ana..ivy, addresses on example.test.
 * Users: alice (all permissions), vera (report view only).
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
  KERNEL_PERMISSIONS,
  syncPermissionCatalogue,
} from '../../src/kernel/permissions/catalogue.js';
import { PermissionService } from '../../src/kernel/permissions/permission-service.js';
import { createRedis } from '../../src/kernel/redis/client.js';
import { TemplateService } from '../../src/kernel/templates/template-service.js';
import {
  PERFORMANCE_PERMISSIONS,
  SummaryService,
  seedClientPlatforms,
  seedPerformanceSummary,
} from '../../src/modules/performance/index.js';
import { createSummaryRouter } from '../../src/modules/performance/summary-router.js';
import { createFixture, type Fixture } from './fixtures.js';
import { connectionUrl } from './global-setup.js';
import { connect, testDatabase } from './helpers.js';
import { TEST_AUTH_ENV } from './test-env.js';

const PASSWORD = 'synthetic-pass-4-6b';
const LIST = ['ops@example.test', 'boss@example.test'];
/** 07:00 in Asia/Qatar (UTC+3) is 04:00 UTC. */
const at = (day: string, time = '04:00') => Date.parse(`${day}T${time}:00Z`);

let owner: pg.Client;
let pool: Pool;
let redis: Redis;
let f: Fixture;
let app: Express;
let summary: SummaryService;
let slug = '';
let platformId = '';
let sourceId = '';
let clock = at('2026-11-20');
let failNextSend = false;
const sent: OutboundMessage[] = [];
const token: Record<string, string> = {};
const people: Record<string, string> = {};

type Json = Record<string, unknown>;
const auth = (req: request.Test, who: string) =>
  req.set('Authorization', `Bearer ${token[who] ?? ''}`);
const get = (path: string, who: string) => auth(request(app).get(`${API_PREFIX}${path}`), who);
const send = (method: 'post' | 'put', path: string, who: string, body: Json = {}) =>
  auth(request(app)[method](`${API_PREFIX}${path}`), who)
    .set('Idempotency-Key', randomUUID())
    .send(body);

async function addUser(username: string, permissionKeys: readonly string[] | 'all', id?: string) {
  const userId = id ?? randomUUID();
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO iam.role (id, tenant_id, key, name, is_builtin) VALUES ($1, $2, $3, $3, false)`,
    [roleId, f.tenantA, `${username}_role`],
  );
  await owner.query(
    `INSERT INTO iam.role_permission (tenant_id, role_id, permission_id)
     SELECT $1, $2, id FROM iam.permission WHERE $3::text[] IS NULL OR key = ANY ($3::text[])`,
    [f.tenantA, roleId, permissionKeys === 'all' ? null : permissionKeys],
  );
  await owner.query(
    `INSERT INTO iam.user_account (id, tenant_id, username, display_name, must_change_password)
     VALUES ($1, $2, $3, $3, false) ON CONFLICT (id) DO UPDATE SET must_change_password = false`,
    [userId, f.tenantA, username],
  );
  await owner.query(
    `INSERT INTO iam.credential (tenant_id, user_id, kind, hash) VALUES ($1, $2, 'password', $3)`,
    [f.tenantA, userId, await hashPassword(PASSWORD)],
  );
  const membership = randomUUID();
  await owner.query(
    `INSERT INTO iam.company_membership (id, tenant_id, user_id, company_id, is_default)
     VALUES ($1, $2, $3, $4, true)`,
    [membership, f.tenantA, userId, f.companyA1],
  );
  await owner.query(
    `INSERT INTO iam.membership_role (tenant_id, membership_id, role_id) VALUES ($1, $2, $3)`,
    [f.tenantA, membership, roleId],
  );
  const res = await request(app)
    .post(`${API_PREFIX}/auth/login`)
    .send({ tenant: slug, identifier: username, password: PASSWORD });
  expect(res.status).toBe(200);
  token[username] = (res.body as { accessToken: string }).accessToken;
}

/** A person (party plus an active employee). */
async function person(key: string, name: string): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO party.party (id, tenant_id, company_id, kind, display_name)
     VALUES ($1, $2, $3, 'person', $4)`,
    [id, f.tenantA, f.companyA1, name],
  );
  await owner.query(
    `INSERT INTO people.employee (tenant_id, company_id, party_id, employee_code, sponsorship)
     VALUES ($1, $2, $3, $4, 'company')`,
    [f.tenantA, f.companyA1, id, `E${key}`],
  );
  people[key] = id;
  return id;
}

/** A sync run read on `readOn` with a status; returns its id. */
async function syncRun(readOn: string, status: 'succeeded' | 'partial' | 'failed') {
  const res = await owner.query<{ id: string }>(
    `INSERT INTO performance.sync_run
       (tenant_id, company_id, sync_source_id, business_date, trigger, status, finished_at)
     VALUES ($1, $2, $3, $4, 'scheduled', $5, now()) RETURNING id`,
    [f.tenantA, f.companyA1, sourceId, readOn, status],
  );
  return res.rows[0]?.id ?? '';
}

async function figure(
  runId: string,
  date: string,
  externalId: string,
  partyId: string | null,
  orders: number,
  minutes: number,
) {
  await owner.query(
    `INSERT INTO performance.daily_performance
       (tenant_id, company_id, sync_run_id, client_platform_id, business_date, party_id,
        external_id, orders_completed, working_minutes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [f.tenantA, f.companyA1, runId, platformId, date, partyId, externalId, orders, minutes],
  );
}

const logRows = async () =>
  (
    await owner.query<{ summary_date: string; variant: string; reason: string | null }>(
      `SELECT to_char(summary_date, 'YYYY-MM-DD') AS summary_date, variant, reason FROM performance.summary_log
        WHERE company_id = $1 ORDER BY summary_date`,
      [f.companyA1],
    )
  ).rows.map((r) => ({
    date: r.summary_date,
    variant: r.variant,
    reason: r.reason,
  }));

const putSettings = (who: string, body: Json) => send('put', '/performance/summary', who, body);
const settings = (recipients: string[], enabled = true) => ({
  recipients,
  sendTime: '07:00',
  timeZone: 'Asia/Qatar',
  enabled,
});

beforeAll(async () => {
  owner = await connect('owner');
  f = await createFixture(owner);
  const db = testDatabase();
  pool = createPool(connectionUrl(db, db.app), 4);
  redis = createRedis(inject('redisUrl'), 'fibrex-test-performance-summary');
  const prisma = createPrisma(pool);
  await syncPermissionCatalogue(prisma, [...KERNEL_PERMISSIONS, ...PERFORMANCE_PERMISSIONS]);
  slug =
    (
      await owner.query<{ slug: string }>(`SELECT slug FROM platform.tenant WHERE id = $1`, [
        f.tenantA,
      ])
    ).rows[0]?.slug ?? '';

  platformId = await seedClientPlatforms(owner, f.tenantA, f.companyA1);
  sourceId =
    (
      await owner.query<{ id: string }>(
        `INSERT INTO performance.sync_source (tenant_id, company_id, client_platform_id, name, adapter_kind)
         VALUES ($1, $2, $3, 'Snoonu daily report', 'sheet') RETURNING id`,
        [f.tenantA, f.companyA1, platformId],
      )
    ).rows[0]?.id ?? '';
  // Settings and the two templates, through the real seed function (synthetic recipients).
  await seedPerformanceSummary(owner, f.tenantA, f.companyA1, LIST);

  const env = loadEnv({
    DATABASE_URL: 'postgresql://unused@localhost:1/x',
    REDIS_URL: 'redis://localhost:1',
    ...TEST_AUTH_ENV,
    RATE_LIMIT_ANONYMOUS: '10000',
    RATE_LIMIT_AUTHENTICATED: '10000',
    AUTH_RATE_LIMIT: '10000',
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
  summary = new SummaryService({
    uow,
    templates: new TemplateService(),
    messaging: {
      send: (message) => {
        if (failNextSend) {
          failNextSend = false;
          return Promise.reject(new Error('mail server down'));
        }
        sent.push(message);
        return Promise.resolve();
      },
    },
    logger,
    prisma,
    now: () => new Date(clock),
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
      api.use(createSummaryRouter({ uow, registry, permissions, summary }));
    },
  });

  await addUser('alice', 'all', f.userA);
  await addUser('vera', ['performance.report.view']);

  // Invented people. Ivy was seen on 10 Nov (so she is a listed person) and has nothing on the 19th.
  const ana = await person('ana', 'Ana Example');
  const ben = await person('ben', 'Ben Example');
  const cy = await person('cy', 'Cy Example');
  const dee = await person('dee', 'Dee Example');
  const eli = await person('eli', 'Eli Example');
  const fay = await person('fay', 'Fay Example');
  const gus = await person('gus', 'Gus Example');
  const hal = await person('hal', 'Hal Example');
  const ivy = await person('ivy', 'Ivy Example');

  // The 04:00 run of 20 Nov read the sheet and succeeded; it holds the figures of the 19th.
  const run20 = await syncRun('2026-11-20', 'succeeded');
  await figure(run20, '2026-11-10', 'F9', ivy, 3, 120);
  await figure(run20, '2026-11-19', 'F1', ana, 12, 480);
  await figure(run20, '2026-11-19', 'F2', ben, 9, 420);
  await figure(run20, '2026-11-19', 'F3', cy, 0, 300);
  await figure(run20, '2026-11-19', 'F4', dee, 5, 240);
  await figure(run20, '2026-11-19', 'F5', eli, 4, 180);
  await figure(run20, '2026-11-19', 'F6', fay, 3, 120);
  await figure(run20, '2026-11-19', 'F7', gus, 2, 60);
  await figure(run20, '2026-11-19', 'F8', hal, 1, 60);
  // An ID nobody has claimed: not in the lists, counted in the note.
  await figure(run20, '2026-11-19', 'F99', null, 40, 600);
  await owner.query(
    `INSERT INTO performance.unmatched_identifier
       (tenant_id, company_id, client_platform_id, external_id, first_seen, last_seen)
     VALUES ($1, $2, $3, 'F99', '2026-11-19', '2026-11-19')`,
    [f.tenantA, f.companyA1, platformId],
  );
  // 21 Nov: a partial run read on the 21st, figures on the 20th.
  const run21 = await syncRun('2026-11-21', 'partial');
  await figure(run21, '2026-11-20', 'F1', ana, 7, 300);
  // 22 Nov: a failed run read on the 22nd (the summary date is the 21st).
  await syncRun('2026-11-22', 'failed');
});

afterAll(async () => {
  const counters = await redis.keys('rl:*');
  if (counters.length > 0) await redis.del(...counters);
  await redis.quit();
  await pool.end();
  await owner.end();
});

describe('the scheduled summary', () => {
  it('sends nothing before the local send time', async () => {
    clock = at('2026-11-20', '03:59');
    const out = await summary.runDue();
    expect(out.sent).toBe(0);
    expect(sent).toHaveLength(0);
    expect(await logRows()).toEqual([]);
  });

  it('sends the full summary once, with the hand-computed figures', async () => {
    clock = at('2026-11-20');
    const out = await summary.runDue();
    expect(out).toMatchObject({ sent: 1, failedCompanies: 0 });
    // One email per recipient, same text.
    expect(sent.map((m) => m.to)).toEqual(LIST);
    const mail = sent[0];
    expect(mail?.channel).toBe('email');
    expect(mail?.subject).toBe('Performance summary 2026-11-19: 36 orders');
    const text = mail?.text ?? '';
    // 7 people with orders; orders 12+9+5+4+3+2+1 = 36; minutes 1860 = 31 h; Cy and Ivy have none.
    expect(text).toContain('Date: 2026-11-19');
    expect(text).toContain('People with orders: 7');
    expect(text).toContain('Total orders: 36');
    expect(text).toContain('Total active hours: 31');
    expect(text).toContain('People with zero orders: 2');
    expect(text).toContain('1  | Ana Example | 12 | 8');
    expect(text).toContain('5  | Fay Example | 3 | 2');
    // Best 5 are Ana..Fay; the weakest come from the rest, fewest first (Cy, Ivy, Hal, Gus).
    const weakest = text.slice(text.indexOf('5 weakest by orders'));
    expect(weakest.indexOf('Cy Example')).toBeLessThan(weakest.indexOf('Ivy Example'));
    expect(weakest.indexOf('Ivy Example')).toBeLessThan(weakest.indexOf('Hal Example'));
    expect(weakest.indexOf('Hal Example')).toBeLessThan(weakest.indexOf('Gus Example'));
    // The unmatched ID is counted in the note, never in the figures.
    expect(text).toContain('1 platform ID(s) are still unmatched');
    expect(await logRows()).toEqual([{ date: '2026-11-19', variant: 'full', reason: null }]);
  });

  it('never sends twice for the same date: a second tick and "Send now" send nothing', async () => {
    const before = sent.length;
    clock = at('2026-11-20', '09:00');
    expect(await summary.runDue()).toMatchObject({ sent: 0 });
    const res = await send('post', '/performance/summary/send-now', 'alice');
    expect(res.status).toBe(409);
    expect((res.body as { code: string }).code).toBe('summary_already_sent');
    expect(sent).toHaveLength(before);
    expect(await logRows()).toHaveLength(1);
  });

  it('sends the "data incomplete" variant for a partial sync, with no figures', async () => {
    const before = sent.length;
    clock = at('2026-11-21');
    expect(await summary.runDue()).toMatchObject({ sent: 1 });
    expect(sent).toHaveLength(before + 2);
    const mail = sent[before];
    expect(mail?.subject).toBe('Performance summary 2026-11-20: data incomplete');
    expect(mail?.text).toContain('DATA INCOMPLETE');
    expect(mail?.text).toContain('partial');
    expect(mail?.text).not.toContain('Total orders');
    expect(mail?.text).not.toContain('Ana Example');
    expect((await logRows()).at(-1)).toEqual({
      date: '2026-11-20',
      variant: 'incomplete',
      reason: 'partial',
    });
  });
});

describe('Send now and the settings', () => {
  it('sends the incomplete variant for a failed sync and for a date with no sync', async () => {
    const failed = await send('post', '/performance/summary/send-now', 'alice', {
      date: '2026-11-21',
    });
    expect(failed.status, JSON.stringify(failed.body)).toBe(200);
    expect(failed.body).toMatchObject({
      date: '2026-11-21',
      variant: 'incomplete',
      reason: 'failed',
      recipients: 2,
    });
    const none = await send('post', '/performance/summary/send-now', 'alice', {
      date: '2026-11-30',
    });
    expect(none.body).toMatchObject({ variant: 'incomplete', reason: 'no_run' });
    expect(sent.at(-1)?.text).toContain('No finished sync was found');
    expect((await logRows()).map((r) => r.reason)).toEqual([null, 'partial', 'failed', 'no_run']);
  });

  it('shows the settings and the last sent summaries', async () => {
    const res = await get('/performance/summary', 'alice');
    expect(res.status).toBe(200);
    const body = res.body as { recipients: string[]; sendTime: string; recent: { date: string }[] };
    expect(body.recipients).toEqual(LIST);
    expect(body.sendTime).toBe('07:00');
    expect(body.recent.map((r) => r.date)).toEqual([
      '2026-11-30',
      '2026-11-21',
      '2026-11-20',
      '2026-11-19',
    ]);
  });

  it('with no recipients sends and logs nothing; adding one later still sends that date', async () => {
    const before = sent.length;
    expect((await putSettings('alice', settings([]))).status).toBe(200);
    clock = at('2026-11-23');
    expect(await summary.runDue()).toMatchObject({ sent: 0 });
    const res = await send('post', '/performance/summary/send-now', 'alice');
    expect(res.status).toBe(422);
    expect((res.body as { code: string }).code).toBe('no_recipients');
    expect(sent).toHaveLength(before);
    expect((await logRows()).some((r) => r.date === '2026-11-22')).toBe(false);

    expect((await putSettings('alice', settings(['late@example.test']))).status).toBe(200);
    expect(await summary.runDue()).toMatchObject({ sent: 1 });
    expect(sent.at(-1)?.to).toBe('late@example.test');
    expect((await logRows()).some((r) => r.date === '2026-11-22')).toBe(true);
  });

  it('does not send on schedule when switched off, and "Send now" still works', async () => {
    expect((await putSettings('alice', settings(LIST, false))).status).toBe(200);
    clock = at('2026-11-24');
    const before = sent.length;
    expect(await summary.runDue()).toMatchObject({ sent: 0 });
    expect(sent).toHaveLength(before);
    const now = await send('post', '/performance/summary/send-now', 'alice');
    expect(now.status).toBe(200);
    expect(sent).toHaveLength(before + 2);
  });

  it('rolls the claim back when sending fails, so the next tick sends', async () => {
    expect((await putSettings('alice', settings(LIST))).status).toBe(200);
    clock = at('2026-11-25');
    const before = sent.length;
    failNextSend = true;
    await expect(summary.runDue()).rejects.toThrow(/failed/);
    expect((await logRows()).some((r) => r.date === '2026-11-24')).toBe(false);
    expect(await summary.runDue()).toMatchObject({ sent: 1 });
    expect(sent).toHaveLength(before + 2);
    expect((await logRows()).some((r) => r.date === '2026-11-24')).toBe(true);
  });

  it('refuses bad settings', async () => {
    const bad = (body: Json) => putSettings('alice', body).then((r) => r.status);
    expect(await bad({ ...settings(['not-an-email']) })).toBe(400);
    expect(await bad({ ...settings(['a@example.test', 'A@example.test']) })).toBe(400);
    expect(await bad({ ...settings(LIST), sendTime: '7am' })).toBe(400);
    expect(await bad({ ...settings(LIST), timeZone: 'Mars/Base' })).toBe(400);
  });

  it('needs performance.summary.manage', async () => {
    expect((await get('/performance/summary', 'vera')).status).toBe(403);
    expect((await putSettings('vera', settings(LIST))).status).toBe(403);
    expect((await send('post', '/performance/summary/send-now', 'vera')).status).toBe(403);
    const none = await request(app).get(`${API_PREFIX}/performance/summary`);
    expect(none.status).toBe(401);
  });
});
