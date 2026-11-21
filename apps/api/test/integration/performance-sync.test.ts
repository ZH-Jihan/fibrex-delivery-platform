/**
 * Row 4.3: the sync engine run the way the app runs it. Every run goes through the real
 * routes (Run now, Re-import, Upload), the real BullMQ sync queue and its worker, and the
 * real permission service; the scheduled run is the job the per-source scheduler writes.
 * The sheet is the fake Snoonu fixture (no real names or numbers), read through an
 * in-memory reader registered for `sheet` sources, as the Google reader will be in row 4.4.
 *
 * Checked: every filled block is stored; re-runs are idempotent (snapshot reused, nothing
 * rewritten); a changed figure retires the old row and keeps it (is_current history); a
 * reset sheet never replaces stored figures; the Public ID is matched to the `falcon_id`
 * identifier and unmatched IDs are queued; raw snapshots are kept; an unreachable source is
 * retried and admins are alerted once; an empty sheet and a changed layout alert admins; the
 * Excel upload and the re-import range; schedules use the source's cron and time zone; the
 * audit trail names the person who clicked (and nobody for the scheduled run).
 * Everything is invented: tenant A, company A1, user alice (super admin).
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
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
import { EventOutbox } from '../../src/kernel/events/outbox.js';
import { ModuleRegistry } from '../../src/kernel/module-registry/index.js';
import { createLogger } from '../../src/kernel/observability/logger.js';
import {
  KERNEL_PERMISSIONS,
  syncPermissionCatalogue,
} from '../../src/kernel/permissions/catalogue.js';
import { PermissionService } from '../../src/kernel/permissions/permission-service.js';
import { createRedis } from '../../src/kernel/redis/client.js';
import { syncEventTypes } from '../../src/modules/notify/index.js';
import { PartyService, PartyVault } from '../../src/modules/party/index.js';
import {
  PERFORMANCE_PERMISSIONS,
  ReportSourceError,
  ReportSourceProviders,
  SYNC_PROBLEM_EVENT,
  SyncQueue,
  SyncService,
  XLSX_MIME,
  createPerformanceModule,
  seedClientPlatforms,
  seedSyncAlertRule,
  type SheetGrid,
} from '../../src/modules/performance/index.js';
import {
  FAKE_PEOPLE,
  REAL_FILLED_DAYS,
  blockColumn,
  fakeFigures,
  gridToXlsx,
  snoonuGrid,
} from '../fixtures/snoonu-daily-report.js';
import { createFixture, type Fixture } from './fixtures.js';
import { connectionUrl } from './global-setup.js';
import { connect, testDatabase } from './helpers.js';
import { TEST_AUTH_ENV } from './test-env.js';

const PASSWORD = 'synthetic-pass-4-3';
const READ_ON = '2026-11-20';
/** 04:30 in Asia/Qatar on READ_ON (UTC+3): the scheduled run's "today". */
const NOW = new Date('2026-11-20T01:30:00.000Z');

let owner: pg.Client;
let pool: Pool;
let redis: Redis;
let f: Fixture;
let app: Express;
let queue: SyncQueue;
let storage: MemoryStorageAdapter;
let alice: string;
let sheetSource: string;
let excelSource: string;
let platformId: string;
let matchedParty: string;

/** What the in-memory reader returns next (a grid, or a read failure). */
let sheet: SheetGrid | 'unreachable' = snoonuGrid();

type Json = Record<string, unknown>;
const auth = (req: request.Test) => req.set('Authorization', `Bearer ${alice}`);
const get = (path: string) => auth(request(app).get(`${API_PREFIX}${path}`));
const post = (path: string, body: Json = {}) =>
  auth(request(app).post(`${API_PREFIX}${path}`))
    .set('Idempotency-Key', randomUUID())
    .send(body);

interface RunItem {
  id: string;
  status: string;
  trigger: string;
  rowsRead: number;
  matched: number;
  unmatched: number;
  errorsCount: number;
  rawInputId: string | null;
  snapshotReused: boolean;
  layoutChanged: boolean;
  supersededByRunId: string | null;
  createdBy: string | null;
  businessDate: string;
}

/** Waits until the source has `count` finished runs; returns them newest first. */
async function finishedRuns(sourceId: string, count: number): Promise<RunItem[]> {
  const deadline = Date.now() + 20_000;
  let items: RunItem[] = [];
  while (Date.now() < deadline) {
    const res = await get(`/sync-runs?syncSourceId=${sourceId}&pageSize=200`);
    items = (res.body as { items: RunItem[] }).items;
    if (items.length >= count && items.every((r) => r.status !== 'running')) return items;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${String(items.length)} runs, wanted ${String(count)}`);
}

/** Queues Run now and returns the run it made. */
async function runNow(expectedTotal: number): Promise<RunItem> {
  const res = await post(`/sync-sources/${sheetSource}/run`, { readOn: READ_ON });
  expect(res.status).toBe(202);
  const runs = await finishedRuns(sheetSource, expectedTotal);
  const [newest] = runs;
  if (newest === undefined) throw new Error('no run');
  return newest;
}

async function currentRows(): Promise<number> {
  const r = await owner.query<{ n: string }>(
    `SELECT count(*) AS n FROM performance.daily_performance
      WHERE client_platform_id = $1 AND is_current`,
    [platformId],
  );
  return Number(r.rows[0]?.n);
}

async function alertsFor(runId: string): Promise<number> {
  const r = await owner.query<{ n: string }>(
    `SELECT count(*) AS n FROM integration.outbox_event
      WHERE event_type_key = $1 AND aggregate_id = $2`,
    [SYNC_PROBLEM_EVENT, runId],
  );
  return Number(r.rows[0]?.n);
}

/** Person-days of the fixture that carry figures (blocks 26 to 19, day offs left out). */
const FILLED_PERSON_DAYS = FAKE_PEOPLE.reduce(
  (n, p) => n + REAL_FILLED_DAYS.filter((d) => fakeFigures(p, d) !== null).length,
  0,
);
const first = FAKE_PEOPLE[0];
if (first === undefined) throw new Error('fixture has no people');

beforeAll(async () => {
  owner = await connect('owner');
  f = await createFixture(owner);
  const db = testDatabase();
  pool = createPool(connectionUrl(db, db.app), 4);
  redis = createRedis(inject('redisUrl'), 'fibrex-test-performance-sync');
  const prisma = createPrisma(pool);
  await syncPermissionCatalogue(prisma, [...KERNEL_PERMISSIONS, ...PERFORMANCE_PERMISSIONS]);
  await syncEventTypes(prisma, createPerformanceModule().eventTypes ?? []);
  const slug =
    (
      await owner.query<{ slug: string }>(`SELECT slug FROM platform.tenant WHERE id = $1`, [
        f.tenantA,
      ])
    ).rows[0]?.slug ?? '';

  // alice: super admin in company A1.
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO iam.role (id, tenant_id, key, name, is_builtin)
     VALUES ($1, $2, 'super_admin', 'Super Admin', true)`,
    [roleId, f.tenantA],
  );
  await owner.query(
    `INSERT INTO iam.role_permission (tenant_id, role_id, permission_id)
     SELECT $1, $2, id FROM iam.permission`,
    [f.tenantA, roleId],
  );
  await owner.query(
    `INSERT INTO iam.user_account (id, tenant_id, username, display_name, must_change_password)
     VALUES ($1, $2, 'alice', 'alice test', false)
     ON CONFLICT (id) DO UPDATE SET must_change_password = false`,
    [f.userA, f.tenantA],
  );
  await owner.query(
    `INSERT INTO iam.credential (tenant_id, user_id, kind, hash) VALUES ($1, $2, 'password', $3)`,
    [f.tenantA, f.userA, await hashPassword(PASSWORD)],
  );
  const membershipId = randomUUID();
  await owner.query(
    `INSERT INTO iam.company_membership (id, tenant_id, user_id, company_id, is_default)
     VALUES ($1, $2, $3, $4, true)`,
    [membershipId, f.tenantA, f.userA, f.companyA1],
  );
  await owner.query(
    `INSERT INTO iam.membership_role (tenant_id, membership_id, role_id) VALUES ($1, $2, $3)`,
    [f.tenantA, membershipId, roleId],
  );

  platformId = await seedClientPlatforms(owner, f.tenantA, f.companyA1);
  expect(await seedSyncAlertRule(owner, f.tenantA)).toBe(1);
  expect(await seedSyncAlertRule(owner, f.tenantA)).toBe(0);

  const env = loadEnv({
    DATABASE_URL: 'postgresql://unused@localhost:1/x',
    REDIS_URL: 'redis://localhost:1',
    ...TEST_AUTH_ENV,
    RATE_LIMIT_ANONYMOUS: '10000',
    RATE_LIMIT_AUTHENTICATED: '10000',
    AUTH_RATE_LIMIT: '10000',
  });
  const vault = new PartyVault(new SecretBox(env.DATA_ENCRYPTION_KEY), env.DATA_ENCRYPTION_KEY);

  // One fake person holds the first fixture Falcon ID; the others stay unmatched.
  const party = await owner.query<{ id: string }>(
    `INSERT INTO party.party (tenant_id, company_id, kind, display_name, names)
     VALUES ($1, $2, 'person', 'Sync Matched Person', '{"en": "Sync Matched Person"}') RETURNING id`,
    [f.tenantA, f.companyA1],
  );
  matchedParty = party.rows[0]?.id ?? '';
  const falcon = String(first.falconId);
  await owner.query(
    `INSERT INTO party.party_identifier
       (tenant_id, company_id, party_id, type, client_platform_id, value_encrypted, value_hash,
        value_masked, value_plain, valid_from)
     VALUES ($1, $2, $3, 'falcon_id', $4, $5, $6, $7, $8, '2026-01-01')`,
    [
      f.tenantA,
      f.companyA1,
      matchedParty,
      platformId,
      vault.seal(falcon, 'party.identifier'),
      vault.hash(f.tenantA, 'identifier:falcon_id', falcon),
      `*${falcon.slice(-4)}`,
      falcon,
    ],
  );

  const sources = await owner.query<{ id: string; adapter_kind: string }>(
    `INSERT INTO performance.sync_source (tenant_id, company_id, client_platform_id, name, adapter_kind)
     VALUES ($1, $2, $3, 'Snoonu daily report', 'sheet'), ($1, $2, $3, 'Snoonu uploads', 'excel')
     RETURNING id, adapter_kind`,
    [f.tenantA, f.companyA1, platformId],
  );
  sheetSource = sources.rows.find((r) => r.adapter_kind === 'sheet')?.id ?? '';
  excelSource = sources.rows.find((r) => r.adapter_kind === 'excel')?.id ?? '';

  const logger = createLogger({ level: 'silent', pretty: false, serviceName: 'test' });
  const uow = new UnitOfWork(prisma);
  const providers = new ReportSourceProviders();
  providers.register({
    adapterKind: 'sheet',
    open: () => ({
      read: (tab) => {
        if (sheet === 'unreachable') {
          return Promise.reject(new Error('connect ETIMEDOUT (fake)'));
        }
        if (sheet.tab !== tab) {
          return Promise.reject(new ReportSourceError('missing_tab', `No tab "${tab}".`));
        }
        return Promise.resolve(sheet);
      },
    }),
  });
  storage = new MemoryStorageAdapter();
  const service = new SyncService({
    uow,
    storage,
    parties: new PartyService(vault),
    providers,
    outbox: new EventOutbox(),
    box: new SecretBox(env.DATA_ENCRYPTION_KEY),
    logger,
    now: () => NOW,
  });
  queue = new SyncQueue({
    redisUrl: inject('redisUrl'),
    service,
    prisma,
    logger,
    attempts: 2,
    backoffMs: 50,
    queueName: `performance-sync-test-${randomUUID()}`,
  });
  // The real worker: every run below happens in it, as in main.ts.
  queue.startWorker();

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
      const modules = new ModuleRegistry({ kernelPermissions: KERNEL_PERMISSIONS });
      modules.register(
        createPerformanceModule({ uow, registry, permissions, sync: service, syncQueue: queue }),
      );
      modules.mount(api);
    },
  });

  const login = await request(app)
    .post(`${API_PREFIX}/auth/login`)
    .send({ tenant: slug, identifier: 'alice', password: PASSWORD });
  expect(login.status).toBe(200);
  alice = (login.body as { accessToken: string }).accessToken;
}, 60_000);

afterAll(async () => {
  await queue.getQueue().obliterate({ force: true });
  await queue.close();
  const counters = await redis.keys('rl:*');
  if (counters.length > 0) await redis.del(...counters);
  await redis.quit();
  await pool.end();
  await owner.end();
});

describe('performance sync engine (row 4.3)', () => {
  it('Run now (route, queue, worker) stores every filled block, matches and queues IDs, audits alice', async () => {
    sheet = snoonuGrid();
    const run = await runNow(1);
    expect(run).toMatchObject({
      status: 'succeeded',
      trigger: 'manual',
      businessDate: READ_ON,
      rowsRead: FAKE_PEOPLE.length,
      matched: 1,
      unmatched: FAKE_PEOPLE.length - 1,
      snapshotReused: false,
      createdBy: f.userA,
    });
    expect(await currentRows()).toBe(FILLED_PERSON_DAYS);

    // Every filled block, 26 Oct to 19 Nov, not only yesterday.
    const dates = await owner.query<{ d: string }>(
      `SELECT DISTINCT business_date::text AS d FROM performance.daily_performance
        WHERE sync_run_id = $1 ORDER BY 1`,
      [run.id],
    );
    expect(dates.rows.length).toBe(25);
    expect(dates.rows[0]?.d).toBe('2026-10-26');
    expect(dates.rows.at(-1)?.d).toBe('2026-11-19');

    // The first person's figures are on their party, Delivered as orders.
    const day5 = fakeFigures(first, 5);
    const mine = await owner.query<{
      party_id: string | null;
      orders_completed: number;
      working_minutes: number;
      created_by: string | null;
    }>(
      `SELECT party_id, orders_completed, working_minutes, created_by
         FROM performance.daily_performance
        WHERE client_platform_id = $1 AND external_id = $2 AND business_date = '2026-11-05' AND is_current`,
      [platformId, String(first.falconId)],
    );
    expect(mine.rows[0]).toEqual({
      party_id: matchedParty,
      orders_completed: day5?.delivered,
      working_minutes: Math.round((day5?.workingHours ?? 0) * 60),
      created_by: f.userA,
    });

    // The other IDs are in the unmatched queue with the dates they were seen.
    const queued = await owner.query<{ external_id: string; status: string; last_seen: string }>(
      `SELECT external_id, status, last_seen::text AS last_seen FROM performance.unmatched_identifier
        WHERE client_platform_id = $1 ORDER BY external_id`,
      [platformId],
    );
    expect(queued.rows.map((r) => r.external_id)).toEqual(
      FAKE_PEOPLE.slice(1).map((p) => String(p.falconId)),
    );
    expect(queued.rows.every((r) => r.status === 'open')).toBe(true);

    // The raw snapshot is kept and can be read back.
    const raw = await get(`/sync-runs/${run.id}/raw`);
    expect(raw.status).toBe(200);
    expect(raw.body).toMatchObject({ kind: 'sheet_snapshot', reused: false });

    // Audit rows written by the background run name alice.
    const audited = await owner.query<{ user_id: string | null }>(
      `SELECT DISTINCT user_id FROM audit.audit_log WHERE entity_id = $1`,
      [run.id],
    );
    expect(audited.rows.length).toBeGreaterThan(0);
    expect(audited.rows.every((r) => r.user_id === f.userA)).toBe(true);
  }, 40_000);

  it('a second run of the same sheet reuses the snapshot and writes nothing', async () => {
    const before = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM performance.daily_performance WHERE client_platform_id = $1`,
      [platformId],
    );
    const run = await runNow(2);
    expect(run).toMatchObject({ status: 'succeeded', snapshotReused: true });
    const after = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM performance.daily_performance WHERE client_platform_id = $1`,
      [platformId],
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    const runs = await finishedRuns(sheetSource, 2);
    expect(runs[1]?.supersededByRunId).toBe(run.id);
  }, 40_000);

  it('a changed figure retires the old row and keeps it as history', async () => {
    const grid = snoonuGrid();
    const row = grid.rows[3];
    if (row === undefined) throw new Error('no first person row');
    row[blockColumn(5) + 1] = 99; // Delivered, 5 Nov, first person
    sheet = grid;
    const run = await runNow(3);
    expect(run.status).toBe('succeeded');
    const history = await owner.query<{ orders_completed: number; is_current: boolean }>(
      `SELECT orders_completed, is_current FROM performance.daily_performance
        WHERE client_platform_id = $1 AND external_id = $2 AND business_date = '2026-11-05'
        ORDER BY created_at, id`,
      [platformId, String(first.falconId)],
    );
    expect(history.rows).toEqual([
      { orders_completed: fakeFigures(first, 5)?.delivered, is_current: false },
      { orders_completed: 99, is_current: true },
    ]);
    const written = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM performance.daily_performance WHERE sync_run_id = $1`,
      [run.id],
    );
    expect(written.rows[0]?.n).toBe('1');
    expect(await currentRows()).toBe(FILLED_PERSON_DAYS);
  }, 40_000);

  it('a reset (all zero) sheet never replaces stored figures', async () => {
    sheet = snoonuGrid({ reset: true });
    const run = await runNow(4);
    expect(run.status).toBe('succeeded');
    const errors = await get(`/sync-runs/${run.id}/errors`);
    expect((errors.body as { items: { code: string }[] }).items.map((e) => e.code)).toEqual([
      'reset_detected',
    ]);
    const written = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM performance.daily_performance WHERE sync_run_id = $1`,
      [run.id],
    );
    expect(written.rows[0]?.n).toBe('0');
    expect(await currentRows()).toBe(FILLED_PERSON_DAYS);
    expect(await alertsFor(run.id)).toBe(0);
    // The reset sheet itself is still kept.
    expect(run.rawInputId).not.toBeNull();
  }, 40_000);

  it('a changed layout fails the run, keeps the snapshot and alerts admins', async () => {
    const grid = snoonuGrid();
    const labels = grid.rows[1] ?? [];
    for (let i = 0; i < labels.length; i += 1) {
      if (labels[i] === 'Delivered') labels[i] = 'Completed';
    }
    sheet = grid;
    const run = await runNow(5);
    expect(run).toMatchObject({ status: 'failed', layoutChanged: true });
    expect(run.rawInputId).not.toBeNull();
    expect(await alertsFor(run.id)).toBe(1);
    expect(await currentRows()).toBe(FILLED_PERSON_DAYS);
  }, 40_000);

  it('an empty sheet fails the run and alerts admins', async () => {
    sheet = snoonuGrid({ people: [] });
    const run = await runNow(6);
    expect(run.status).toBe('failed');
    expect(await alertsFor(run.id)).toBe(1);
  }, 40_000);

  it('an unreachable source is retried, and admins are alerted once after the last try', async () => {
    sheet = 'unreachable';
    const res = await post(`/sync-sources/${sheetSource}/run`, { readOn: READ_ON });
    expect(res.status).toBe(202);
    const runs = await finishedRuns(sheetSource, 8);
    const [last, firstTry] = runs;
    expect(last?.status).toBe('failed');
    expect(firstTry?.status).toBe('failed');
    expect(await alertsFor(firstTry?.id ?? '')).toBe(0);
    expect(await alertsFor(last?.id ?? '')).toBe(1);
    const errors = await get(`/sync-runs/${last?.id ?? ''}/errors`);
    expect((errors.body as { items: { code: string }[] }).items[0]?.code).toBe(
      'source_unreachable',
    );
  }, 40_000);

  it("uploads a day's Excel file (same layout) through the queue", async () => {
    const bytes = await gridToXlsx(snoonuGrid());
    const key = `${f.tenantA}/${f.companyA1}/test/${randomUUID()}`;
    storage.put(key, bytes);
    const file = await owner.query<{ id: string }>(
      `INSERT INTO files.file_object (tenant_id, company_id, bucket, object_key, sha256, size_bytes, mime_type, original_name)
       VALUES ($1, $2, 'memory', $3, $4, $5, $6, 'daily-report.xlsx') RETURNING id`,
      [
        f.tenantA,
        f.companyA1,
        key,
        createHash('sha256').update(bytes).digest('hex'),
        bytes.length,
        XLSX_MIME,
      ],
    );
    const res = await post(`/sync-sources/${excelSource}/upload`, {
      fileObjectId: file.rows[0]?.id,
      readOn: READ_ON,
    });
    expect(res.status).toBe(202);
    const [run] = await finishedRuns(excelSource, 1);
    expect(run).toMatchObject({ status: 'succeeded', trigger: 'upload', createdBy: f.userA });
    // The upload restores 5 Nov to the sheet's figure: one row changes, the rest are equal.
    const written = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM performance.daily_performance WHERE sync_run_id = $1`,
      [run?.id],
    );
    expect(written.rows[0]?.n).toBe('1');
    const raw = await get(`/sync-runs/${run?.id ?? ''}/raw`);
    expect(raw.body).toMatchObject({ kind: 'excel_upload', fileObjectId: file.rows[0]?.id });

    // An Excel source cannot "Run now", and an upload must be an .xlsx file.
    expect((await post(`/sync-sources/${excelSource}/run`, {})).status).toBe(422);
  }, 40_000);

  it('re-imports only the dates of the range and reports dates the sheet does not hold', async () => {
    const grid = snoonuGrid({ filledDays: REAL_FILLED_DAYS.filter((d) => d !== 3) });
    for (const row of grid.rows.slice(3)) {
      if (row[0] === null || row[0] === undefined) continue;
      const c = blockColumn(2) + 1;
      if (typeof row[c] === 'number') row[c] = row[c] + 1; // 2 Nov changed
      const c19 = blockColumn(19) + 1;
      if (typeof row[c19] === 'number') row[c19] = row[c19] + 1; // outside range
    }
    sheet = grid;
    const bad = await post(`/sync-sources/${sheetSource}/reimport`, {
      from: '2026-11-04',
      to: '2026-11-02',
    });
    expect(bad.status).toBe(400);
    const res = await post(`/sync-sources/${sheetSource}/reimport`, {
      from: '2026-11-02',
      to: '2026-11-03',
      readOn: READ_ON,
    });
    expect(res.status).toBe(202);
    const [run] = await finishedRuns(sheetSource, 9);
    expect(run).toMatchObject({ trigger: 'reimport', status: 'succeeded' });
    const dates = await owner.query<{ d: string }>(
      `SELECT DISTINCT business_date::text AS d FROM performance.daily_performance WHERE sync_run_id = $1`,
      [run?.id],
    );
    expect(dates.rows.map((r) => r.d)).toEqual(['2026-11-02']);
    const errors = await get(`/sync-runs/${run?.id ?? ''}/errors`);
    expect((errors.body as { items: { code: string }[] }).items.map((e) => e.code)).toEqual([
      'date_not_in_sheet',
    ]);
    // 3 Nov is blank in this sheet, and its stored figures stay.
    expect(await currentRows()).toBe(FILLED_PERSON_DAYS);
  }, 40_000);

  it('schedules each source at 04:00 Asia/Qatar and runs the scheduled job as the system', async () => {
    expect(await queue.syncSchedules()).toBeGreaterThanOrEqual(1);
    const schedulers = await queue.getQueue().getJobSchedulers(0, -1);
    const mine = schedulers.find((s) => (s.id ?? s.key) === `performance-sync:${sheetSource}`);
    expect(mine).toMatchObject({ pattern: '0 4 * * *', tz: 'Asia/Qatar' });
    expect(schedulers.some((s) => (s.id ?? s.key) === `performance-sync:${excelSource}`)).toBe(
      false,
    );

    // The job exactly as the scheduler writes it (no readOn, no user).
    const template = mine?.template?.data;
    expect(template).toEqual({
      tenantId: f.tenantA,
      companyId: f.companyA1,
      request: { syncSourceId: sheetSource, trigger: 'scheduled' },
    });
    await queue.getQueue().removeJobScheduler(`performance-sync:${sheetSource}`);
    sheet = snoonuGrid();
    await queue.getQueue().add('scheduled', template as never, { attempts: 1 });
    const [run] = await finishedRuns(sheetSource, 10);
    // "Today" in Asia/Qatar at NOW, and nobody as the author.
    expect(run).toMatchObject({ trigger: 'scheduled', businessDate: READ_ON, createdBy: null });
    expect(run?.status).toBe('succeeded');
  }, 40_000);
});
