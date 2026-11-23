/**
 * Row 4.7: the tracking API for the morning call sheet, driven through the real routes, the
 * real permission service, the real kernel state service with the employee status machine,
 * and the real tracking job.
 *
 * Checked: who is on the sheet (riders and drivers with a placement; office staff and people
 * without a placement left out; a person with two Falcon IDs shown once with both IDs);
 * yesterday's figures and the summary strip; the cross-check (active with no orders, not
 * active with orders, sheet says blocked, sheet says not updated); permissions (none, view
 * only, record without "apply status"); a valid status change applied to the employee with
 * its reason and dated history; reason required; an invalid transition refused with nothing
 * changed; one entry per person per date; a future-dated change left pending and applied by
 * the job once its date has come; the call log; ID-operator periods (overlap refused, ended
 * by PATCH); the history endpoint; and row-level security between two companies.
 * Everything is invented: tenant A, companies A1 and A2; users alice (all, A1), vic (view
 * only), cal (record and call, no status), dave (nothing), ann (all, company A2 only).
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
import { createAuditService } from '../../src/kernel/audit/audit-service.js';
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
import { NotFoundError } from '../../src/kernel/http/errors.js';
import { ImportTargets } from '../../src/kernel/imports/import-targets.js';
import { seedLookups } from '../../src/kernel/lookups/lookup-seed.js';
import { ModuleRegistry } from '../../src/kernel/module-registry/index.js';
import { NumberingService } from '../../src/kernel/numbering/numbering-service.js';
import { createLogger } from '../../src/kernel/observability/logger.js';
import {
  KERNEL_PERMISSIONS,
  syncPermissionCatalogue,
} from '../../src/kernel/permissions/catalogue.js';
import { PermissionService } from '../../src/kernel/permissions/permission-service.js';
import { createReportRouter } from '../../src/kernel/reports/report-router.js';
import { ReportService } from '../../src/kernel/reports/report-service.js';
import { createRedis } from '../../src/kernel/redis/client.js';
import { StateService, StateTargets } from '../../src/kernel/states/state-service.js';
import { AttachableRegistry } from '../../src/modules/files/index.js';
import { PartyService, PartyVault } from '../../src/modules/party/index.js';
import {
  EMPLOYEE_ENTITY,
  PEOPLE_PERMISSIONS,
  createPeopleModule,
  seedEmployeeStatus,
} from '../../src/modules/people/index.js';
import { addDays, seedClientPlatforms } from '../../src/modules/performance/index.js';
import { callSheetReport } from '../../src/modules/tracking/call-sheet-report.js';
import {
  TRACKING_PERMISSIONS,
  TrackingService,
  createTrackingModule,
} from '../../src/modules/tracking/index.js';
import { createFixture, type Fixture } from './fixtures.js';
import { connectionUrl } from './global-setup.js';
import { connect, testDatabase } from './helpers.js';
import { TEST_AUTH_ENV } from './test-env.js';

const PASSWORD = 'synthetic-pass-4-7';
const storage = new MemoryStorageAdapter();
/** The sheet's date: today (UTC, the state service's today), so moves made now are not "future". */
const D = new Date().toISOString().slice(0, 10);
const Y = addDays(D, -1);

let owner: pg.Client;
let pool: Pool;
let redis: Redis;
let f: Fixture;
let app: Express;
let slug = '';
let tracking: TrackingService;
let platformId = '';
let runId = '';
const token: Record<string, string> = {};
const people: Record<string, string> = {};
const employees: Record<string, string> = {};
const identifiers: Record<string, string> = {};
const lookup: Record<string, string> = {};

type Json = Record<string, unknown>;
const as = (req: request.Test, who: string) =>
  req.set('Authorization', `Bearer ${token[who] ?? ''}`);
const get = (path: string, who = 'alice') => as(request(app).get(`${API_PREFIX}${path}`), who);
const post = (path: string, body: Json, who = 'alice') =>
  as(request(app).post(`${API_PREFIX}${path}`), who)
    .set('Idempotency-Key', randomUUID())
    .send(body);
const patch = (path: string, body: Json, who = 'alice') =>
  as(request(app).patch(`${API_PREFIX}${path}`), who)
    .set('Idempotency-Key', randomUUID())
    .send(body);

interface Row {
  partyId: string;
  name: string;
  statusCode: string;
  platformIds: { value: string }[];
  zone: string | null;
  phone: string | null;
  profession: string;
  yesterday: { orders: number | null; hours: number | null; lateMinutes: number | null };
  entry: { id: string; statusState: string } | null;
  calledToday: boolean;
  lastCall: { outcomeCode: string } | null;
  operator: { operatorName: string } | null;
  crossCheck: string[];
}
interface Sheet {
  date: string;
  figuresDate: string;
  reported: boolean;
  summary: Record<string, unknown>;
  rows: Row[];
  lowHoursLimit: number;
}

async function sheet(who = 'alice', date = D): Promise<Sheet> {
  const res = await get(`/tracking?date=${date}`, who);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as Sheet;
}
const rowOf = (s: Sheet, key: string) => {
  const row = s.rows.find((r) => r.partyId === people[key]);
  if (row === undefined) throw new Error(`${key} is not on the sheet`);
  return row;
};
const statusOf = async (key: string) =>
  (
    await owner.query<{ status_code: string }>(
      `SELECT status_code FROM people.employee WHERE id = $1`,
      [employees[key]],
    )
  ).rows[0]?.status_code;

async function addUser(username: string, keys: readonly string[] | 'all', company: string) {
  const userId = username === 'alice' ? f.userA : randomUUID();
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO iam.role (id, tenant_id, key, name, is_builtin) VALUES ($1, $2, $3, $3, false)`,
    [roleId, f.tenantA, `${username}_role`],
  );
  await owner.query(
    `INSERT INTO iam.role_permission (tenant_id, role_id, permission_id)
     SELECT $1, $2, id FROM iam.permission WHERE is_active AND ($3::text[] IS NULL OR key = ANY ($3::text[]))`,
    [f.tenantA, roleId, keys === 'all' ? null : keys],
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
    [membership, f.tenantA, userId, company],
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

/**
 * An invented employee. `profession` null = no placement at all. Platform IDs are open
 * Falcon IDs from 1 Jan 2026.
 */
async function person(
  key: string,
  name: string,
  profession: string | null,
  options: { status?: string; falconIds?: string[]; company?: string; zone?: string } = {},
): Promise<void> {
  const company = options.company ?? f.companyA1;
  const partyId = randomUUID();
  const employeeId = randomUUID();
  await owner.query(
    `INSERT INTO party.party (id, tenant_id, company_id, kind, display_name)
     VALUES ($1, $2, $3, 'person', $4)`,
    [partyId, f.tenantA, company, name],
  );
  await owner.query(
    `INSERT INTO people.employee (id, tenant_id, company_id, party_id, employee_code, sponsorship, status_code)
     VALUES ($1, $2, $3, $4, $5, 'company', $6)`,
    [employeeId, f.tenantA, company, partyId, `T${key.toUpperCase()}`, options.status ?? 'active'],
  );
  await owner.query(
    `INSERT INTO party.party_contact (tenant_id, company_id, party_id, kind, value, is_primary)
     VALUES ($1, $2, $3, 'phone', $4, true)`,
    [f.tenantA, company, partyId, `+9745000${String(Object.keys(people).length).padStart(4, '0')}`],
  );
  if (profession !== null) {
    await owner.query(
      `INSERT INTO people.employee_placement (tenant_id, company_id, employee_id, valid_from, profession, org_unit_id)
       VALUES ($1, $2, $3, '2026-01-01', $4, $5)`,
      [f.tenantA, company, employeeId, profession, options.zone ?? null],
    );
  }
  for (const falconId of options.falconIds ?? []) {
    const ident = await owner.query<{ id: string }>(
      `INSERT INTO party.party_identifier
         (tenant_id, company_id, party_id, type, value_encrypted, value_hash, value_masked, value_plain, valid_from)
       VALUES ($1, $2, $3, 'falcon_id', '\\x00', $4, '***', $5, '2026-01-01') RETURNING id`,
      [f.tenantA, company, partyId, randomUUID(), falconId],
    );
    identifiers[falconId] = ident.rows[0]?.id ?? '';
  }
  people[key] = partyId;
  employees[key] = employeeId;
}

/** One stored figure row of yesterday (or `date`). */
async function figure(
  key: string,
  falconId: string,
  orders: number,
  minutes: number,
  extra: { late?: number; metrics?: Json; date?: string } = {},
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
      platformId,
      extra.date ?? Y,
      people[key],
      falconId,
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
  redis = createRedis(inject('redisUrl'), 'fibrex-test-tracking');
  const prisma = createPrisma(pool);
  await syncPermissionCatalogue(prisma, [
    ...KERNEL_PERMISSIONS,
    ...PEOPLE_PERMISSIONS,
    ...TRACKING_PERMISSIONS,
  ]);
  slug =
    (
      await owner.query<{ slug: string }>(`SELECT slug FROM platform.tenant WHERE id = $1`, [
        f.tenantA,
      ])
    ).rows[0]?.slug ?? '';
  await seedLookups(owner, f.tenantA);
  await seedEmployeeStatus(owner, f.tenantA);
  const values = await owner.query<{ key: string; code: string; id: string }>(
    `SELECT t.key, v.code, v.id FROM cfg.lookup_value v JOIN cfg.lookup_type t ON t.id = v.lookup_type_id
      WHERE v.tenant_id = $1 AND t.key IN ('status_reason', 'call_outcome')`,
    [f.tenantA],
  );
  for (const v of values.rows) lookup[`${v.key}.${v.code}`] = v.id;

  platformId = await seedClientPlatforms(owner, f.tenantA, f.companyA1);
  const source = await owner.query<{ id: string }>(
    `INSERT INTO performance.sync_source (tenant_id, company_id, client_platform_id, name, adapter_kind)
     VALUES ($1, $2, $3, 'Invented daily report', 'sheet') RETURNING id`,
    [f.tenantA, f.companyA1, platformId],
  );
  const run = await owner.query<{ id: string }>(
    `INSERT INTO performance.sync_run (tenant_id, company_id, sync_source_id, business_date, trigger)
     VALUES ($1, $2, $3, $4, 'manual') RETURNING id`,
    [f.tenantA, f.companyA1, source.rows[0]?.id, D],
  );
  runId = run.rows[0]?.id ?? '';
  const zone = await owner.query<{ id: string }>(
    `INSERT INTO platform.org_unit (tenant_id, company_id, kind, code, name)
     VALUES ($1, $2, 'zone', 'Z1', 'Zone One') RETURNING id`,
    [f.tenantA, f.companyA1],
  );

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
  const vault = new PartyVault(new SecretBox(env.DATA_ENCRYPTION_KEY), env.DATA_ENCRYPTION_KEY);
  const stateTargets = new StateTargets(() => {
    throw new Error('no custom records in this test');
  });
  const states = new StateService({ permissions, targets: stateTargets });
  tracking = new TrackingService({ uow, permissions, states, prisma, logger });
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
      const peopleModule = createPeopleModule({
        uow,
        registry,
        permissions,
        parties: new PartyService(vault),
        numbering: new NumberingService(),
        vault,
        audit: createAuditService(),
        attachables: new AttachableRegistry(),
        states,
        importTargets: new ImportTargets(() => Promise.reject(new NotFoundError())),
      });
      stateTargets.register(EMPLOYEE_ENTITY, peopleModule.employeeStateTarget);
      modules.register(createTrackingModule({ uow, registry, permissions, tracking }));
      modules.mount(api);
      const reports = new ReportService({
        permissions,
        storage,
        renderer: new StubPdfRenderer(),
        definitions: () => [callSheetReport],
      });
      api.use(createReportRouter({ uow, registry, permissions, reports }));
    },
  });

  await addUser('alice', 'all', f.companyA1);
  await addUser('vic', ['tracking.entry.view'], f.companyA1);
  await addUser(
    'cal',
    ['tracking.entry.view', 'tracking.entry.create', 'tracking.call.create'],
    f.companyA1,
  );
  await addUser('dave', [], f.companyA1);
  await addUser('ann', 'all', f.companyA2);

  // The invented crew of company A1.
  await person('ana', 'Ana Example', 'rider', {
    falconIds: ['F-9001', 'F-9002'],
    zone: zone.rows[0]?.id,
  });
  await person('ben', 'Ben Example', 'driver', { falconIds: ['F-9003'] });
  await person('cy', 'Cy Example', 'rider', { status: 'inactive', falconIds: ['F-9004'] });
  await person('dee', 'Dee Example', 'rider', { falconIds: ['F-9005'] });
  await person('eve', 'Eve Example', 'rider', { falconIds: ['F-9006'] });
  await person('olly', 'Olly Office', 'accountant');
  await person('noel', 'Noel Noplacement', null);
  // Company A2 has its own rider.
  await person('zed', 'Zed Elsewhere', 'rider', { company: f.companyA2, falconIds: ['F-9100'] });

  // Yesterday's sheet. Ana worked her new ID; the old one has figures two days ago only.
  await figure('ana', 'F-9001', 4, 200, { date: addDays(D, -2) });
  await figure('ana', 'F-9002', 12, 450, { late: 4 });
  await figure('ben', 'F-9003', 0, 0);
  await figure('cy', 'F-9004', 5, 300);
  await figure('dee', 'F-9005', 3, 180, { metrics: { _fields: { tags: 'Blocked' } } });
  await figure('eve', 'F-9006', 2, 90, { metrics: { _extra: { Status: 'Not Updated' } } });
});

afterAll(async () => {
  const counters = await redis.keys('rl:*');
  if (counters.length > 0) await redis.del(...counters);
  await redis.quit();
  await pool.end();
  await owner.end();
});

describe('GET /tracking: who is on the call sheet', () => {
  it('lists riders and drivers once each, without office staff or people with no placement', async () => {
    const s = await sheet();
    expect(s.figuresDate).toBe(Y);
    expect(s.reported).toBe(true);
    expect(s.rows.map((r) => r.name)).toEqual([
      'Ana Example',
      'Ben Example',
      'Cy Example',
      'Dee Example',
      'Eve Example',
    ]);
    const ana = rowOf(s, 'ana');
    expect(ana.platformIds.map((p) => p.value)).toEqual(['F-9001', 'F-9002']);
    expect(ana.zone).toBe('Zone One');
    expect(ana.profession).toBe('rider');
    expect(ana.phone).toMatch(/^\+9745000/);
    expect(ana.yesterday).toEqual({ orders: 12, hours: 7.5, lateMinutes: 4 });
    expect(rowOf(s, 'ben').profession).toBe('driver');
  });

  it('adds up the summary strip', async () => {
    const s = await sheet();
    expect(s.summary).toMatchObject({
      totalPeople: 5,
      called: 0,
      notCalled: 5,
      ordersYesterday: 22,
      hoursYesterday: 17,
      zeroOrders: 1,
      statusChangesToday: 0,
      byStatus: { active: 4, inactive: 1 },
      operatedByOthers: 0,
      crossCheckFlags: 4,
    });
  });
});

describe('GET /tracking filters (row 4.8b): the strip follows the filtered rows', () => {
  const filtered = async (
    query: string,
  ): Promise<Sheet & { filtered: boolean; unfiltered: Json }> => {
    const res = await get(`/tracking?date=${D}&${query}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as Sheet & { filtered: boolean; unfiltered: Json };
  };
  const names = (s: Sheet) => s.rows.map((r) => r.name);

  it('without filters nothing is hidden and the unfiltered totals equal the strip', async () => {
    const s = await filtered('');
    expect(s.filtered).toBe(false);
    expect(s.unfiltered).toEqual({ totalPeople: 5, byStatus: { active: 4, inactive: 1 } });
    expect(s.summary).toMatchObject({ totalPeople: 5, ordersYesterday: 22, hoursYesterday: 17 });
  });

  it('a status filter recomputes every number for exactly those people', async () => {
    const active = await filtered('status=active');
    expect(names(active)).toEqual(['Ana Example', 'Ben Example', 'Dee Example', 'Eve Example']);
    expect(active.filtered).toBe(true);
    expect(active.summary).toMatchObject({
      totalPeople: 4,
      called: 0,
      notCalled: 4,
      ordersYesterday: 17,
      hoursYesterday: 12,
      zeroOrders: 1,
      byStatus: { active: 4 },
    });
    // The total without filters is still the whole sheet, and the status list keeps every status.
    expect(active.unfiltered).toEqual({ totalPeople: 5, byStatus: { active: 4, inactive: 1 } });

    const inactive = await filtered('status=inactive');
    expect(names(inactive)).toEqual(['Cy Example']);
    expect(inactive.summary).toMatchObject({
      totalPeople: 1,
      ordersYesterday: 5,
      hoursYesterday: 5,
      zeroOrders: 0,
    });
  });

  it('zero orders keeps only people with no orders on a reported day', async () => {
    const zero = await filtered('zeroOrders=true');
    expect(names(zero)).toEqual(['Ben Example']);
    expect(zero.summary).toMatchObject({ totalPeople: 1, ordersYesterday: 0, zeroOrders: 1 });
  });

  it('search finds a name, a platform ID or a phone, and the strip follows', async () => {
    expect(names(await filtered('q=example'))).toHaveLength(5);
    const byId = await filtered('q=f-9003');
    expect(names(byId)).toEqual(['Ben Example']);
    expect(byId.summary).toMatchObject({ totalPeople: 1, zeroOrders: 1 });
    const none = await filtered('q=nobody-by-this-name');
    expect(none.rows).toEqual([]);
    expect(none.summary).toMatchObject({ totalPeople: 0, ordersYesterday: 0, hoursYesterday: 0 });
    expect(none.unfiltered).toMatchObject({ totalPeople: 5 });
  });

  it('combines two filters and the search with "and"', async () => {
    const both = await filtered('status=active&zeroOrders=true');
    expect(names(both)).toEqual(['Ben Example']);
    expect(both.summary).toMatchObject({ totalPeople: 1, zeroOrders: 1, ordersYesterday: 0 });
    const withSearch = await filtered('status=active&notCalled=true&q=dee');
    expect(names(withSearch)).toEqual(['Dee Example']);
    expect(withSearch.summary).toMatchObject({
      totalPeople: 1,
      notCalled: 1,
      ordersYesterday: 3,
      hoursYesterday: 3,
    });
    // Inactive people never have zero orders here, so the two filters leave nobody.
    const empty = await filtered('status=inactive&zeroOrders=true');
    expect(empty.rows).toEqual([]);
    expect(empty.summary).toMatchObject({ totalPeople: 0, zeroOrders: 0 });
  });

  it('refuses a malformed filter', async () => {
    expect((await get(`/tracking?date=${D}&notCalled=maybe`)).status).toBe(400);
  });
});

describe('GET /tracking/cross-check', () => {
  it('lists the differences between the sheet and our status', async () => {
    const res = await get(`/tracking/cross-check?date=${D}`);
    expect(res.status).toBe(200);
    const items = (res.body as { items: { partyId: string; kinds: string[] }[] }).items;
    const kindsOf = (key: string) => items.find((i) => i.partyId === people[key])?.kinds;
    expect(kindsOf('ana')).toBeUndefined();
    expect(kindsOf('ben')).toEqual(['active_no_orders']);
    expect(kindsOf('cy')).toEqual(['inactive_with_orders']);
    expect(kindsOf('dee')).toEqual(['status_mismatch']);
    expect(kindsOf('eve')).toEqual(['sheet_not_updated']);
  });
});

describe('permissions', () => {
  it('refuses without permission, and lets view-only users read but not write', async () => {
    expect((await get(`/tracking?date=${D}`, 'dave')).status).toBe(403);
    expect((await get(`/tracking/cross-check?date=${D}`, 'dave')).status).toBe(403);
    expect((await get(`/tracking?date=${D}`, 'vic')).status).toBe(200);
    const res = await post(
      '/tracking/entries',
      { partyId: people.olly, callOutcomeId: lookup['call_outcome.answered'] },
      'vic',
    );
    expect(res.status).toBe(403);
    expect(
      (
        await post(
          '/tracking/calls',
          { partyId: people.olly, outcomeId: lookup['call_outcome.answered'] },
          'vic',
        )
      ).status,
    ).toBe(403);
  });

  it('needs tracking.status.apply to change a status', async () => {
    const refused = await post(
      '/tracking/entries',
      {
        partyId: people.olly,
        businessDate: Y,
        statusCode: 'blocked',
        reasonId: lookup['status_reason.other'],
      },
      'cal',
    );
    expect(refused.status).toBe(403);
    expect(await statusOf('olly')).toBe('active');
    // Recording the call outcome alone is fine.
    const ok = await post(
      '/tracking/entries',
      { partyId: people.olly, businessDate: Y, callOutcomeId: lookup['call_outcome.answered'] },
      'cal',
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect((ok.body as { statusState: string }).statusState).toBe('none');
  });
});

describe('status changes', () => {
  let benEntry: { id: string; version: number };

  it('applies a valid change to the employee with its reason and dated history', async () => {
    const res = await post('/tracking/entries', {
      partyId: people.ben,
      businessDate: D,
      statusCode: 'blocked',
      reasonId: lookup['status_reason.absconded'],
      callOutcomeId: lookup['call_outcome.answered'],
      note: 'Phone answered by a relative',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const body = res.body as {
      id: string;
      version: number;
      statusState: string;
      stateHistoryId: string;
      effectiveDate: string;
    };
    benEntry = body;
    expect(body.statusState).toBe('applied');
    expect(body.effectiveDate).toBe(D);
    expect(await statusOf('ben')).toBe('blocked');
    const history = await owner.query<{
      from_code: string;
      to_code: string;
      effective_date: Date;
      note: string;
      actor_id: string;
    }>(
      `SELECT from_code, to_code, effective_date, note, actor_id FROM cfg.state_history WHERE id = $1`,
      [body.stateHistoryId],
    );
    expect(history.rows[0]).toMatchObject({
      from_code: 'active',
      to_code: 'blocked',
      actor_id: f.userA,
    });
    // The machine's move takes its reason as text: the reason's label goes into the note.
    expect(history.rows[0]?.note).toBe('Absconded: Phone answered by a relative');

    const s = await sheet();
    const ben = rowOf(s, 'ben');
    expect(ben.statusCode).toBe('blocked');
    expect(ben.calledToday).toBe(true);
    expect(s.summary).toMatchObject({ statusChangesToday: 1, called: 1 });
  });

  it('requires a reason to block, make inactive or terminate', async () => {
    const res = await post('/tracking/entries', { partyId: people.cy, statusCode: 'terminated' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('reasonId');
  });

  it('refuses an invalid transition with a clear error and changes nothing', async () => {
    // blocked -> inactive is not a move of the employee machine.
    const res = await patch(`/tracking/entries/${benEntry.id}`, {
      version: benEntry.version,
      statusCode: 'inactive',
      reasonId: lookup['status_reason.on_leave'],
    });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'transition_not_allowed' });
    expect(JSON.stringify(res.body)).toContain('cannot be set to');
    expect(await statusOf('ben')).toBe('blocked');
    const entry = await owner.query<{ status_code: string; version: number }>(
      `SELECT status_code, version FROM tracking.tracking_entry WHERE id = $1`,
      [benEntry.id],
    );
    expect(entry.rows[0]).toMatchObject({ status_code: 'blocked', version: benEntry.version });
  });

  it('keeps one entry per person per date', async () => {
    const res = await post('/tracking/entries', {
      partyId: people.ben,
      businessDate: D,
      callOutcomeId: lookup['call_outcome.no_answer'],
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'entry_exists', id: benEntry.id });
  });

  it('a valid PATCH is a new status change; the earlier one stays in the history', async () => {
    const res = await patch(`/tracking/entries/${benEntry.id}`, {
      version: benEntry.version,
      statusCode: 'active',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf('ben')).toBe('active');
    const history = await get(`/tracking/${people.ben ?? ''}/history`);
    expect(history.status).toBe(200);
    const body = history.body as {
      entries: unknown[];
      statusHistory: { fromCode: string; toCode: string }[];
    };
    expect(body.entries).toHaveLength(1);
    expect(body.statusHistory.map((h) => `${h.fromCode}>${h.toCode}`)).toEqual([
      'active>blocked',
      'blocked>active',
    ]);
  });

  it('leaves a future-dated change pending until the job applies it on its date', async () => {
    const res = await post('/tracking/entries', {
      partyId: people.dee,
      businessDate: D,
      statusCode: 'inactive',
      reasonId: lookup['status_reason.on_leave'],
      effectiveDate: addDays(D, 2),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const entry = res.body as { id: string; statusState: string };
    expect(entry.statusState).toBe('pending');
    expect(await statusOf('dee')).toBe('active');

    // Not due yet: the job leaves it alone.
    await tracking.applyDue();
    const before = await owner.query<{ status_state: string }>(
      `SELECT status_state FROM tracking.tracking_entry WHERE id = $1`,
      [entry.id],
    );
    expect(before.rows[0]?.status_state).toBe('pending');
    expect(await statusOf('dee')).toBe('active');

    // The date comes (the test moves the date instead of the clock: the kernel state service
    // refuses future dates by the real clock).
    await owner.query(`UPDATE tracking.tracking_entry SET effective_date = $2 WHERE id = $1`, [
      entry.id,
      D,
    ]);
    const result = await tracking.applyDue();
    expect(result.applied).toBeGreaterThanOrEqual(1);
    const after = await owner.query<{
      status_state: string;
      state_history_id: string;
    }>(`SELECT status_state, state_history_id FROM tracking.tracking_entry WHERE id = $1`, [
      entry.id,
    ]);
    expect(after.rows[0]?.status_state).toBe('applied');
    expect(await statusOf('dee')).toBe('inactive');
    const history = await owner.query<{
      to_code: string;
      actor_id: string;
      effective_date: string;
    }>(
      `SELECT to_code, actor_id, effective_date::text AS effective_date FROM cfg.state_history WHERE id = $1`,
      [after.rows[0]?.state_history_id],
    );
    expect(history.rows[0]?.to_code).toBe('inactive');
    // Applied as the person who recorded it.
    expect(history.rows[0]?.actor_id).toBe(f.userA);
    expect(history.rows[0]?.effective_date).toBe(D);
    // A second run does nothing more.
    await tracking.applyDue();
    expect(await statusOf('dee')).toBe('inactive');
  });
});

describe('call log', () => {
  it('logs a call and shows it as the latest call', async () => {
    const res = await post(
      '/tracking/calls',
      {
        partyId: people.eve,
        businessDate: D,
        outcomeId: lookup['call_outcome.switched_off'],
        note: 'Try later',
      },
      'cal',
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ outcomeCode: 'switched_off', businessDate: D });
    const eve = rowOf(await sheet(), 'eve');
    expect(eve.calledToday).toBe(true);
    expect(eve.lastCall?.outcomeCode).toBe('switched_off');
  });

  it('refuses an outcome from another list', async () => {
    const res = await post('/tracking/calls', {
      partyId: people.eve,
      outcomeId: lookup['status_reason.other'],
    });
    expect(res.status).toBe(400);
  });
});

describe('ID-operator periods', () => {
  it('records who works the ID, refuses an overlap, and ends by PATCH', async () => {
    const created = await post('/tracking/operator-periods', {
      partyIdentifierId: identifiers['F-9002'],
      operatorName: 'Sample Stand In',
      operatorPhone: '+97450009999',
      fromDate: addDays(D, -3),
      codAtHandover: '120.5',
      currency: 'QAR',
      ordersAtHandover: 7,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const period = created.body as { id: string; version: number; ownerPartyId: string };
    expect(period.ownerPartyId).toBe(people.ana);
    expect(created.body).toMatchObject({ codAtHandover: '120.5000', ordersAtHandover: 7 });
    expect(rowOf(await sheet(), 'ana').operator?.operatorName).toBe('Sample Stand In');
    expect((await sheet()).summary).toMatchObject({ operatedByOthers: 1 });

    const overlap = await post('/tracking/operator-periods', {
      partyIdentifierId: identifiers['F-9002'],
      operatorName: 'Another Stand In',
      fromDate: addDays(D, -1),
    });
    expect(overlap.status).toBe(409);
    expect(overlap.body).toMatchObject({ code: 'operator_period_overlap' });

    const owned = await post('/tracking/operator-periods', {
      partyIdentifierId: identifiers['F-9002'],
      operatorPartyId: people.ana,
      fromDate: addDays(D, 5),
    });
    expect(owned.status).toBe(422);

    const ended = await patch(`/tracking/operator-periods/${period.id}`, {
      version: period.version,
      toDate: addDays(D, -1),
    });
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);
    expect(rowOf(await sheet(), 'ana').operator).toBeNull();
    expect(rowOf(await sheet('alice', Y), 'ana').operator?.operatorName).toBe('Sample Stand In');
    const history = await get(`/tracking/${people.ana ?? ''}/history`);
    expect((history.body as { operatorPeriods: unknown[] }).operatorPeriods).toHaveLength(1);
  });
});

describe('row 4.8b: operator period edits, settings, history names and the export', () => {
  it('refuses an edit that makes two periods overlap, and keeps the note', async () => {
    const first = await post('/tracking/operator-periods', {
      partyIdentifierId: identifiers['F-9003'],
      operatorName: 'Sample Cover One',
      fromDate: addDays(D, -30),
      toDate: addDays(D, -20),
      note: 'Rider on leave',
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ note: 'Rider on leave' });
    const one = first.body as { id: string; version: number };
    // The day after the first period ends is free.
    const second = await post('/tracking/operator-periods', {
      partyIdentifierId: identifiers['F-9003'],
      operatorName: 'Sample Cover Two',
      fromDate: addDays(D, -19),
    });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    // Stretching the first over the second is refused with the clear message.
    const stretched = await patch(`/tracking/operator-periods/${one.id}`, {
      version: one.version,
      toDate: addDays(D, -5),
    });
    expect(stretched.status).toBe(409);
    expect(stretched.body).toMatchObject({
      code: 'operator_period_overlap',
      detail: 'Someone else is already recorded as working this ID on some of these days.',
    });
    // A correction that does not overlap works, and a note can be changed.
    const fixed = await patch(`/tracking/operator-periods/${one.id}`, {
      version: one.version,
      toDate: addDays(D, -21),
      note: 'Corrected end',
    });
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
    expect(fixed.body).toMatchObject({ toDate: addDays(D, -21), note: 'Corrected end' });
  });

  it("the history names who did it, lists the person's platform IDs, and carries the note", async () => {
    const res = await get(`/tracking/${people.ben ?? ''}/history`);
    expect(res.status).toBe(200);
    const body = res.body as {
      platformIds: { identifierId: string; value: string }[];
      users: Record<string, string>;
      operatorPeriods: { createdBy: string | null; note: string | null }[];
    };
    expect(body.platformIds.map((i) => i.value)).toEqual(['F-9003']);
    expect(body.operatorPeriods).toHaveLength(2);
    const creator = body.operatorPeriods[0]?.createdBy ?? '';
    expect(body.users[creator]).toBeTruthy();
    expect(body.operatorPeriods.map((p) => p.note).sort()).toEqual(['Corrected end', null]);
  });

  it('the cross-check items carry what "Set status" needs', async () => {
    const res = await get(`/tracking/cross-check?date=${D}`);
    const item = (
      res.body as { items: { partyId: string; employeeId: string; entry: unknown }[] }
    ).items.find((i) => i.partyId === people.ben);
    expect(item?.employeeId).toBe(employees.ben);
    expect(item).toHaveProperty('entry');
  });

  it('the low-hours limit is a company setting: default 4, changed by people who may update', async () => {
    expect((await sheet()).lowHoursLimit).toBe(4);
    expect((await get('/tracking/settings')).body).toMatchObject({ lowHours: 4 });
    const put = (body: Json, who = 'alice') =>
      as(request(app).put(`${API_PREFIX}/tracking/settings`), who)
        .set('Idempotency-Key', randomUUID())
        .send(body);
    // View only and record-only users cannot change it.
    expect((await put({ lowHours: 3 }, 'vic')).status).toBe(403);
    expect((await put({ lowHours: 3 }, 'cal')).status).toBe(403);
    expect((await put({ lowHours: 0 })).status).toBe(400);
    expect((await put({ lowHours: 25 })).status).toBe(400);
    expect((await put({ lowHours: 'six' })).status).toBe(400);
    const saved = await put({ lowHours: 6.5 });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect((await sheet()).lowHoursLimit).toBe(6.5);
    // A second save changes the same row.
    expect((await put({ lowHours: 3 })).status).toBe(200);
    expect((await sheet()).lowHoursLimit).toBe(3);
    const rows = await owner.query(
      `SELECT 1 FROM platform.setting WHERE company_id = $1 AND key = 'tracking.call_sheet' AND deleted_at IS NULL`,
      [f.companyA1],
    );
    expect(rows.rowCount).toBe(1);
    // Another company is not affected, and a user of that company cannot set ours.
    expect((await sheet('ann')).lowHoursLimit).toBe(4);
    expect((await put({ lowHours: 2 }, 'ann')).status).toBe(200);
    expect((await sheet()).lowHoursLimit).toBe(3);
    expect((await sheet('ann')).lowHoursLimit).toBe(2);
  });

  it('exports the filtered sheet with call outcomes, the same people the screen lists', async () => {
    const filters = { date: D, status: 'active', notCalled: 'true' };
    const listed = await get(`/tracking?date=${D}&status=active&notCalled=true`);
    const listedNames = (listed.body as Sheet).rows.map((r) => r.name);
    expect(listedNames).not.toContain('Eve Example'); // called earlier today
    const res = await post('/reports/tracking.call_sheet/export', { format: 'csv', filters });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { fileId, rowCount } = res.body as { fileId: string; rowCount: number };
    expect(rowCount).toBe(listedNames.length);
    const file = await owner.query<{ object_key: string }>(
      `SELECT object_key FROM files.file_object WHERE id = $1`,
      [fileId],
    );
    const bytes = await storage.read(file.rows[0]?.object_key ?? '');
    const text = (bytes?.toString('utf8') ?? '').replace(/^\uFEFF/, '');
    expect(text.split(/\r?\n/)[0]).toBe(
      'Person,Employee code,Platform ID,Zone,Phone,Status,Orders yesterday,Hours yesterday,Late minutes,Called,Call outcome,Last call at,Note',
    );
    for (const name of listedNames) expect(text).toContain(name);
    expect(text).not.toContain('Cy Example');

    // Everyone, so the call logged on Eve's row (outcome and note) is in the file.
    const all = await post('/reports/tracking.call_sheet/export', {
      format: 'csv',
      filters: { date: D },
    });
    expect(all.status).toBe(201);
    const allFile = await owner.query<{ object_key: string }>(
      `SELECT object_key FROM files.file_object WHERE id = $1`,
      [(all.body as { fileId: string }).fileId],
    );
    const allText = (await storage.read(allFile.rows[0]?.object_key ?? ''))?.toString('utf8') ?? '';
    const eve = allText.split(/\r?\n/).find((line) => line.startsWith('Eve Example')) ?? '';
    expect(eve).toContain('Switched off');
    expect(eve).toContain('Try later');
  });

  it('needs the export permission as well as the view permission', async () => {
    const res = await post(
      '/reports/tracking.call_sheet/export',
      { format: 'csv', filters: { date: D } },
      'cal',
    );
    expect(res.status).toBe(403);
    expect(
      (
        await post(
          '/reports/tracking.call_sheet/export',
          { format: 'csv', filters: { date: D } },
          'dave',
        )
      ).status,
    ).toBe(403);
  });
});

describe('row-level security', () => {
  it('keeps each company to its own call sheet', async () => {
    const own = await sheet('ann');
    expect(own.rows.map((r) => r.name)).toEqual(['Zed Elsewhere']);
    expect((await sheet()).rows.map((r) => r.name)).not.toContain('Zed Elsewhere');
    // Company A1's people are invisible from A2: not an employee there.
    const res = await post(
      '/tracking/entries',
      { partyId: people.ana, callOutcomeId: lookup['call_outcome.answered'] },
      'ann',
    );
    expect(res.status).toBe(422);
    expect((await get(`/tracking/${people.ana ?? ''}/history`, 'ann')).status).toBe(404);
  });
});
