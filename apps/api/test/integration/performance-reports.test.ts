/**
 * Row 4.6a: performance reports, driven through the real report routes (`/reports/{key}/run`
 * and `/export`), the performance helper routes and the real permission service.
 *
 * Checked: the daily report (one day, default yesterday, a reset or missed day is empty); the
 * cycle summary by hand-computed figures, with the 25th and 26th cycle boundaries (the day
 * before the cycle and the day after it are left out), the reset guard (an unreported date is
 * never a zero), a person with two Falcon IDs counted once, a person with no figures shown as
 * zeros and an unmatched ID left out; the top and bottom lists and runs of no orders; the
 * person history route; CSV and Excel export; permissions (no permission 403, view without
 * export 403 on export).
 * Everything is invented: tenant A, company A1, users alice (all), vera (view only), dave (none).
 */
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { StubPdfRenderer } from '../../src/adapters/pdf/stub.js';
import { MemoryStorageAdapter } from '../../src/adapters/storage/memory.js';
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
import { createReportRouter } from '../../src/kernel/reports/report-router.js';
import { ReportService } from '../../src/kernel/reports/report-service.js';
import { syncReportDefinitions } from '../../src/kernel/reports/report-sync.js';
import {
  PERFORMANCE_PERMISSIONS,
  PERFORMANCE_REPORTS,
  seedClientPlatforms,
  thisAndLastCycle,
  yesterdayInQatar,
} from '../../src/modules/performance/index.js';
import { createPerformanceReportRouter } from '../../src/modules/performance/performance-report-router.js';
import { createFixture, type Fixture } from './fixtures.js';
import { connectionUrl } from './global-setup.js';
import { connect, testDatabase } from './helpers.js';
import { TEST_AUTH_ENV } from './test-env.js';

const PASSWORD = 'synthetic-pass-4-6a';

let owner: pg.Client;
let pool: Pool;
let redis: Redis;
let f: Fixture;
let app: Express;
let slug = '';
let platformId = '';
let sourceId = '';
let runId = '';
const storage = new MemoryStorageAdapter();
const token: Record<string, string> = {};
const people: Record<string, string> = {};

type Json = Record<string, unknown>;
type Row = Record<string, string | number | null>;
const auth = (req: request.Test, who: string) =>
  req.set('Authorization', `Bearer ${token[who] ?? ''}`);
const get = (path: string, who: string) => auth(request(app).get(`${API_PREFIX}${path}`), who);
const post = (path: string, who: string, body: Json = {}) =>
  auth(request(app).post(`${API_PREFIX}${path}`), who)
    .set('Idempotency-Key', randomUUID())
    .send(body);
const run = (key: string, who: string, filters: Record<string, string> = {}, extra: Json = {}) =>
  post(`/reports/${key}/run`, who, { filters, pageSize: 200, ...extra });
const rowsOf = async (key: string, filters: Record<string, string>, who = 'alice') => {
  const res = await run(key, who, filters);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body as { rows: Row[]; total: number }).rows;
};

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

/** A person (party plus an active employee) with a name; employees default to active. */
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

/** One stored current figure row. `partyId` null = an unmatched ID. */
async function figure(
  date: string,
  externalId: string,
  partyId: string | null,
  orders: number,
  minutes: number,
  extra: { late?: number; metrics?: Json } = {},
  platform = platformId,
) {
  await owner.query(
    `INSERT INTO performance.daily_performance
       (tenant_id, company_id, sync_run_id, client_platform_id, business_date, party_id, external_id,
        orders_completed, working_minutes, late_minutes, metrics)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      f.tenantA,
      f.companyA1,
      runId,
      platform,
      date,
      partyId,
      externalId,
      orders,
      minutes,
      extra.late ?? null,
      JSON.stringify(extra.metrics ?? {}),
    ],
  );
}

beforeAll(async () => {
  owner = await connect('owner');
  f = await createFixture(owner);
  const db = testDatabase();
  pool = createPool(connectionUrl(db, db.app), 4);
  redis = createRedis(inject('redisUrl'), 'fibrex-test-performance-reports');
  const prisma = createPrisma(pool);
  await syncPermissionCatalogue(prisma, [...KERNEL_PERMISSIONS, ...PERFORMANCE_PERMISSIONS]);
  await syncReportDefinitions(prisma, PERFORMANCE_REPORTS);
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
  runId =
    (
      await owner.query<{ id: string }>(
        `INSERT INTO performance.sync_run (tenant_id, company_id, sync_source_id, business_date, trigger)
         VALUES ($1, $2, $3, '2026-11-20', 'manual') RETURNING id`,
        [f.tenantA, f.companyA1, sourceId],
      )
    ).rows[0]?.id ?? '';

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
  const reports = new ReportService({
    permissions,
    storage,
    renderer: new StubPdfRenderer(),
    definitions: () => PERFORMANCE_REPORTS,
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
      api.use(createPerformanceReportRouter({ uow, registry, permissions }));
      api.use(createReportRouter({ uow, registry, permissions, reports }));
    },
  });

  await addUser('alice', 'all', f.userA);
  await addUser('vera', ['performance.report.view']);
  await addUser('dave', []);

  // Invented people. Ana holds two Falcon IDs (F1 until 31 Oct, F2 from 1 Nov); Ben works some
  // days only; Cy has no figures in the cycle but was seen (and is active) on 25 Oct.
  const ana = await person('ana', 'Ana Example');
  const ben = await person('ben', 'Ben Example');
  const cy = await person('cy', 'Cy Example');

  // The day before the cycle (the 25th) and the first day after it (26 Nov) must stay out.
  await figure('2026-10-25', 'F1', ana, 10, 600, { metrics: { kms: 99 } });
  await figure('2026-10-25', 'F3', ben, 8, 480);
  await figure('2026-10-25', 'F4', cy, 1, 60);
  await figure('2026-11-26', 'F2', ana, 9, 540);
  // The cycle 26 Oct to 25 Nov. 28 Oct, 30 and 31 Oct and 4 to 24 Nov: nobody has figures
  // (a reset or a missed sync), so those dates are not zeros for anyone.
  await figure('2026-10-26', 'F1', ana, 5, 300, {
    late: 7,
    metrics: { acceptance_rate: 0.9, kms: 40 },
  });
  await figure('2026-10-26', 'F3', ben, 3, 120);
  await figure('2026-10-27', 'F1', ana, 0, 60);
  await figure('2026-10-27', 'F3', ben, 4, 240);
  await figure('2026-10-29', 'F1', ana, 6, 360);
  await figure('2026-11-01', 'F2', ana, 7, 420, { metrics: { acceptance_rate: 0.95 } });
  await figure('2026-11-02', 'F2', ana, 2, 120);
  await figure('2026-11-03', 'F2', ana, 1, 60);
  await figure('2026-11-25', 'F2', ana, 2, 120, {
    metrics: {
      _fields: {
        day_off: 'Wed',
        schedule: '10:00-20:00',
        break_start: '14:00',
        break_end: '15:00',
        pending_amount: 75.25,
        balance_amount: 12,
      },
    },
  });
  // An ID nobody has claimed yet: stored without a person, never a row in the reports.
  await figure('2026-11-01', 'F9', null, 50, 600);
});

afterAll(async () => {
  const counters = await redis.keys('rl:*');
  if (counters.length > 0) await redis.del(...counters);
  await redis.quit();
  await pool.end();
  await owner.end();
});

const CYCLE = { from: '2026-10-26', to: '2026-11-25' };
const byName = (rows: Row[], name: string) => {
  const row = rows.find((r) => r.personName === name);
  if (row === undefined) throw new Error(`no row for ${name}`);
  return row;
};

describe('performance.cycle_summary', () => {
  it('matches the hand-computed figures for the 26 Oct to 25 Nov cycle', async () => {
    const rows = await rowsOf('performance.cycle_summary', CYCLE);
    // Ana, Ben and Cy only: the unmatched ID is not a person.
    expect(rows.map((r) => r.personName)).toEqual(['Ana Example', 'Ben Example', 'Cy Example']);

    // Reported days: 26, 27, 29 Oct, 1, 2, 3 Nov, 25 Nov = 7. 25 Oct and 26 Nov are outside.
    // Ana: orders 5+0+6+7+2+1+2 = 23; minutes 300+60+360+420+120+60+120 = 1440 = 24 h;
    // every reported day has orders or hours (7 worked); one zero-order day (27 Oct).
    expect(byName(rows, 'Ana Example')).toMatchObject({
      cycleStart: '2026-10-26',
      cycleEnd: '2026-11-25',
      totalOrders: 23,
      totalHours: 24,
      daysWorked: 7,
      zeroDays: 1,
      avgOrdersPerActiveDay: 3.29,
      ordersPerHour: 0.96,
    });
    // Ben: orders 3+4 = 7; 360 min = 6 h; 2 days worked, 5 reported days with no orders.
    expect(byName(rows, 'Ben Example')).toMatchObject({
      totalOrders: 7,
      totalHours: 6,
      daysWorked: 2,
      zeroDays: 5,
      avgOrdersPerActiveDay: 3.5,
      ordersPerHour: 1.17,
    });
    // Cy has no figures in the cycle: all zeros, listed, no division by zero.
    expect(byName(rows, 'Cy Example')).toMatchObject({
      totalOrders: 0,
      totalHours: 0,
      daysWorked: 0,
      zeroDays: 7,
      avgOrdersPerActiveDay: 0,
      ordersPerHour: 0,
    });
  });

  it('counts a person with two Falcon IDs once and shows both IDs', async () => {
    const rows = await rowsOf('performance.cycle_summary', CYCLE);
    expect(rows.filter((r) => r.personName === 'Ana Example')).toHaveLength(1);
    expect(byName(rows, 'Ana Example').falconId).toBe('F1, F2');
  });

  it('puts the 25th and the 26th in different cycles', async () => {
    // The 25th alone (end of the cycle before): Ana 10, Ben 8, Cy 1.
    const before = await rowsOf('performance.cycle_summary', {
      from: '2026-10-25',
      to: '2026-10-25',
    });
    expect(byName(before, 'Ana Example').totalOrders).toBe(10);
    expect(byName(before, 'Ben Example').totalOrders).toBe(8);
    expect(byName(before, 'Cy Example').totalOrders).toBe(1);
    // The 26th of November is the first day of the next cycle: only Ana has figures that day.
    const after = await rowsOf('performance.cycle_summary', {
      from: '2026-11-26',
      to: '2026-12-25',
    });
    expect(byName(after, 'Ana Example').totalOrders).toBe(9);
    expect(byName(after, 'Ben Example').totalOrders).toBe(0);
    // And the last day of the cycle (25 Nov) belongs to the cycle ending that day.
    const lastDay = await rowsOf('performance.cycle_summary', {
      from: '2026-11-25',
      to: '2026-11-25',
    });
    expect(byName(lastDay, 'Ana Example').totalOrders).toBe(2);
  });

  it('is empty, not zeros, when the platform reported nothing in the range', async () => {
    expect(
      await rowsOf('performance.cycle_summary', { from: '2026-11-05', to: '2026-11-24' }),
    ).toEqual([]);
  });

  it('works out this and last cycle from the platform start day', async () => {
    const options = await get('/performance/report-options', 'vera');
    expect(options.status).toBe(200);
    const body = options.body as {
      yesterday: string;
      platforms: { id: string; thisCycle: Json; lastCycle: Json; cycleStartDay: number }[];
    };
    expect(body.yesterday).toBe(yesterdayInQatar());
    const snoonu = body.platforms.find((p) => p.id === platformId);
    const expected = thisAndLastCycle(26);
    expect(snoonu?.thisCycle).toEqual(expected.thisCycle);
    expect(snoonu?.lastCycle).toEqual(expected.lastCycle);
    // The cycle filters take the same dates (the report returns no rows, there are no figures
    // for the real current cycle, but the person route always lists every date).
    for (const [cycle, want] of [
      ['this', expected.thisCycle],
      ['last', expected.lastCycle],
    ] as const) {
      const res = await get(`/performance/person/${people.ana ?? ''}?cycle=${cycle}`, 'vera');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ from: want.start, to: want.end });
    }
  });

  it('refuses a half range, a backwards range, a long range and bad ids', async () => {
    const bad: Record<string, string>[] = [
      { from: '2026-10-26' },
      { from: '2026-11-25', to: '2026-10-26' },
      { from: '2025-01-01', to: '2026-11-25' },
      { platformId: 'not-a-uuid' },
      { companyId: 'nope' },
    ];
    for (const filters of bad) {
      const res = await run('performance.cycle_summary', 'alice', filters);
      expect(res.status, JSON.stringify(filters)).toBe(400);
    }
    expect(
      (await run('performance.cycle_summary', 'alice', { platformId: randomUUID() })).status,
    ).toBe(404);
  });
});

describe('performance.daily', () => {
  it("shows each person's day with the acceptance rate as a percentage", async () => {
    const rows = await rowsOf('performance.daily', { date: '2026-10-26' });
    expect(byName(rows, 'Ana Example')).toMatchObject({
      date: '2026-10-26',
      orders: 5,
      hoursActive: 5,
      acceptanceRate: 90,
      lateMinutes: 7,
      km: 40,
      falconId: 'F1, F2',
    });
    expect(byName(rows, 'Ben Example')).toMatchObject({ orders: 3, hoursActive: 2 });
  });

  it('lists a person with no figures that day as zeros once the platform reported the day', async () => {
    const rows = await rowsOf('performance.daily', { date: '2026-11-01' });
    expect(byName(rows, 'Ben Example')).toMatchObject({ orders: 0, hoursActive: 0 });
    expect(byName(rows, 'Ana Example').acceptanceRate).toBe(95);
    // 50 orders on the unmatched ID are not anybody's.
    expect(rows.reduce((sum, r) => sum + Number(r.orders), 0)).toBe(7);
  });

  it('shows nothing for a day the platform reset or did not report', async () => {
    expect(await rowsOf('performance.daily', { date: '2026-10-28' })).toEqual([]);
  });

  it('defaults to yesterday (Qatar date)', async () => {
    const yesterday = yesterdayInQatar();
    await figure(yesterday, 'F1', people.ben ?? null, 4, 90);
    const rows = await rowsOf('performance.daily', {});
    expect(byName(rows, 'Ben Example')).toMatchObject({
      date: yesterday,
      orders: 4,
      hoursActive: 1.5,
    });
    await owner.query(
      `UPDATE performance.daily_performance SET is_current = false
        WHERE business_date = $1 AND client_platform_id = $2`,
      [yesterday, platformId],
    );
  });

  it('sorts by a column', async () => {
    const res = await run(
      'performance.daily',
      'alice',
      { date: '2026-10-26' },
      {
        sort: { key: 'orders', direction: 'desc' },
      },
    );
    expect((res.body as { rows: Row[] }).rows.map((r) => r.personName)).toEqual([
      'Ana Example',
      'Ben Example',
      'Cy Example',
    ]);
  });
});

describe('performance.top_bottom', () => {
  it('lists the best, no duplicates in the worst, and runs of no orders', async () => {
    const rows = await rowsOf('performance.top_bottom', CYCLE);
    const list = (name: string) =>
      rows.filter((r) => r.list === name).map((r) => [r.rank, r.personName, r.totalOrders]);
    expect(list('top')).toEqual([
      [1, 'Ana Example', 23],
      [2, 'Ben Example', 7],
      [3, 'Cy Example', 0],
    ]);
    // Everybody is already on the top list, so nobody repeats on the bottom one.
    expect(list('bottom')).toEqual([]);
    // Ben and Cy: 1, 2 and 3 Nov are consecutive reported days with no orders (3 days). 29 Oct
    // to 1 Nov is NOT a run, because 30 and 31 Oct were not reported by the platform.
    const streaks = rows.filter((r) => r.list === 'streak');
    expect(streaks.map((r) => r.personName)).toEqual(['Ben Example', 'Cy Example']);
    expect(streaks[0]).toMatchObject({
      streakDays: 3,
      streakFrom: '2026-11-01',
      streakTo: '2026-11-03',
    });
  });

  it('limits each list to 10 people and keeps the weakest apart from the best', async () => {
    // A second platform (named so that it sorts after Snoonu, the default platform) with 13 invented riders (orders 1 to 13), on 10 and 11 Nov.
    const org = randomUUID();
    await owner.query(
      `INSERT INTO party.party (id, tenant_id, company_id, kind, display_name)
       VALUES ($1, $2, $3, 'organisation', 'Zulu Example')`,
      [org, f.tenantA, f.companyA1],
    );
    const second = (
      await owner.query<{ id: string }>(
        `INSERT INTO performance.client_platform
           (tenant_id, company_id, party_id, code, name, adapter_kind, cycle_start_day)
         VALUES ($1, $2, $3, 'zulu_example', 'Zulu Example', 'sheet', 1) RETURNING id`,
        [f.tenantA, f.companyA1, org],
      )
    ).rows[0]?.id;
    if (second === undefined) throw new Error('platform not created');
    for (let i = 1; i <= 13; i += 1) {
      const id = await person(`k${String(i)}`, `Rider ${String(i).padStart(2, '0')}`);
      await figure('2026-11-10', `K${String(i)}`, id, i, 60, {}, second);
      await figure('2026-11-11', `K${String(i)}`, id, i, 60, {}, second);
    }
    const rows = await rowsOf('performance.top_bottom', {
      platformId: second,
      from: '2026-11-01',
      to: '2026-11-30',
    });
    const tops = rows.filter((r) => r.list === 'top');
    const bottoms = rows.filter((r) => r.list === 'bottom');
    expect(tops).toHaveLength(10);
    expect(tops[0]).toMatchObject({ personName: 'Rider 13', totalOrders: 26 });
    expect(tops[9]).toMatchObject({ personName: 'Rider 04', totalOrders: 8 });
    expect(bottoms.map((r) => [r.rank, r.personName, r.totalOrders])).toEqual([
      [1, 'Rider 01', 2],
      [2, 'Rider 02', 4],
      [3, 'Rider 03', 6],
    ]);
    // Everyone worked on both reported days, so there is no run of no orders.
    expect(rows.some((r) => r.list === 'streak')).toBe(false);
  });
});

describe('GET /performance/person/{partyId}', () => {
  it('lists every date of the range, marks reported days and keeps gaps as gaps', async () => {
    const res = await get(
      `/performance/person/${people.ana ?? ''}?from=2026-10-25&to=2026-11-03`,
      'vera',
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as {
      reportedDays: number;
      totals: Json;
      days: { date: string; reported: boolean; orders: number | null; hours: number | null }[];
    };
    expect(body.days).toHaveLength(10);
    const day = (date: string) => body.days.find((d) => d.date === date);
    expect(day('2026-10-25')).toMatchObject({ reported: true, orders: 10, hours: 10 });
    expect(day('2026-10-28')).toMatchObject({ reported: false, orders: null, hours: null });
    expect(day('2026-10-27')).toMatchObject({ reported: true, orders: 0, hours: 1 });
    // Reported: 25, 26, 27, 29 Oct and 1, 2, 3 Nov.
    expect(body.reportedDays).toBe(7);
    expect(body.totals).toMatchObject({ orders: 31, hours: 32, daysWorked: 7, zeroDays: 1 });
  });

  it('needs the view permission and a real person', async () => {
    expect((await get(`/performance/person/${people.ana ?? ''}`, 'dave')).status).toBe(403);
    expect((await get(`/performance/person/${randomUUID()}`, 'vera')).status).toBe(404);
  });
});

describe('GET /performance/person/{partyId}/platform-details (row 4.8c)', () => {
  const url = (date: string) =>
    `/performance/person/${people.ana ?? ''}/platform-details?date=${date}`;
  interface Details {
    amountsVisible: boolean;
    sheet: {
      found: boolean;
      asOfDate: string | null;
      dayOff: { isToday: boolean };
      dutyTime: { from: string | null; to: string | null };
      cod: { amount: string } | null;
      balance: { amount: string } | null;
    };
    platformIds: { value: string }[];
    recentDays: { date: string; orders: number | null }[];
  }

  it('reads the latest stored sheet row of the cycle, with amounts for people who may see them', async () => {
    // 25 Nov 2026 is a Wednesday; the row of that day says the day off is Wed.
    const res = await get(url('2026-11-25'), 'alice');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as Details;
    expect(body.sheet).toMatchObject({ found: true, asOfDate: '2026-11-25' });
    expect(body.sheet.dayOff.isToday).toBe(true);
    expect(body.sheet.dutyTime).toMatchObject({ from: '10:00', to: '20:00' });
    expect(body.sheet.cod?.amount).toBe('75.2500');
    expect(body.sheet.balance?.amount).toBe('12.0000');
    expect(body.recentDays).toHaveLength(7);
    // A later cycle with no stored row for the person has no details (nothing carried over).
    expect(((await get(url('2027-01-15'), 'alice')).body as Details).sheet.found).toBe(false);
  });

  it('leaves the amounts out for people who only hold the report permission', async () => {
    const res = await get(url('2026-11-25'), 'vera');
    expect(res.status).toBe(200);
    const body = res.body as Details;
    expect(body.amountsVisible).toBe(false);
    expect(body.sheet.cod).toBeNull();
    expect(body.sheet.balance).toBeNull();
    expect(JSON.stringify(body)).not.toContain('75.25');
    expect(body.sheet.dutyTime.from).toBe('10:00');
    expect((await get(url('2026-11-25'), 'dave')).status).toBe(403);
  });
});

describe('permissions and export', () => {
  it('refuses people without performance.report.view on every route', async () => {
    for (const key of [
      'performance.daily',
      'performance.cycle_summary',
      'performance.top_bottom',
    ]) {
      expect((await run(key, 'dave', CYCLE)).status, key).toBe(403);
      expect((await get(`/reports/${key}/meta`, 'dave')).status, key).toBe(403);
    }
    expect((await get('/performance/report-options', 'dave')).status).toBe(403);
    expect((await get('/performance/report-options', 'vera')).status).toBe(200);
  });

  it('lets a viewer run but not export; an exporter gets CSV and Excel through the engine', async () => {
    expect((await run('performance.cycle_summary', 'vera', CYCLE)).status).toBe(200);
    expect(
      (
        await post('/reports/performance.cycle_summary/export', 'vera', {
          format: 'csv',
          filters: CYCLE,
        })
      ).status,
    ).toBe(403);

    const csv = await post('/reports/performance.cycle_summary/export', 'alice', {
      format: 'csv',
      filters: CYCLE,
    });
    expect(csv.status, JSON.stringify(csv.body)).toBe(201);
    const { fileId, rowCount } = csv.body as { fileId: string; rowCount: number };
    expect(rowCount).toBe(3);
    const file = await owner.query<{ object_key: string }>(
      `SELECT object_key FROM files.file_object WHERE id = $1`,
      [fileId],
    );
    const bytes = await storage.read(file.rows[0]?.object_key ?? '');
    // The file starts with a byte-order mark so Excel reads it as UTF-8.
    const text = (bytes?.toString('utf8') ?? '').replace(/^\uFEFF/, '');
    expect(text.split(/\r?\n/)[0]).toBe(
      'Person,Platform ID,Cycle start,Cycle end,Total orders,Total hours,Avg orders per active day,Days worked,Days with zero orders,Orders per hour',
    );
    expect(text).toContain('Ana Example,"F1, F2",2026-10-26,2026-11-25,23,24,3.29,7,1,0.96');

    const xlsx = await post('/reports/performance.top_bottom/export', 'alice', {
      format: 'xlsx',
      filters: CYCLE,
    });
    expect(xlsx.status, JSON.stringify(xlsx.body)).toBe(201);
  });
});
