/**
 * Row 4.5b: the Unmatched riders queue, driven through the real routes, the real sync queue
 * and worker (which fills the queue from a fake Snoonu sheet) and the real permission service.
 *
 * Checked: the sync keeps the sheet's name, phone, driver or rider, plate and zone for each
 * unmatched ID; the list and its filters; permissions (read only, resolve without "create
 * employee", no sign-in); candidates (best name matches, search by phone digits and code);
 * linking attaches the stored figures in one go and is audited; one person with two Falcon IDs
 * (old and new, dated); an overlapping link is refused and changes nothing; create employee
 * from the sheet row (placement, phone, platform ID, zone); ignore with a reason.
 * Everything is invented: tenant A, company A1, users alice (all), vic (read only),
 * rob (resolve, but cannot create employees).
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
import { NotFoundError } from '../../src/kernel/http/errors.js';
import { ExportService } from '../../src/kernel/imports/export-service.js';
import { ImportQueue } from '../../src/kernel/imports/import-queue.js';
import { createImportRouter } from '../../src/kernel/imports/import-router.js';
import { ImportService } from '../../src/kernel/imports/import-service.js';
import { ImportTargets } from '../../src/kernel/imports/import-targets.js';
import { createAuditService } from '../../src/kernel/audit/audit-service.js';
import { EventOutbox } from '../../src/kernel/events/outbox.js';
import { ModuleRegistry } from '../../src/kernel/module-registry/index.js';
import { NumberingService } from '../../src/kernel/numbering/numbering-service.js';
import { createLogger } from '../../src/kernel/observability/logger.js';
import {
  KERNEL_PERMISSIONS,
  syncPermissionCatalogue,
} from '../../src/kernel/permissions/catalogue.js';
import { PermissionService } from '../../src/kernel/permissions/permission-service.js';
import { createRedis } from '../../src/kernel/redis/client.js';
import { AttachableRegistry } from '../../src/modules/files/index.js';
import { syncEventTypes } from '../../src/modules/notify/index.js';
import { PartyService, PartyVault } from '../../src/modules/party/index.js';
import {
  PEOPLE_PERMISSIONS,
  createPeopleModule,
  seedEmployeeStatus,
} from '../../src/modules/people/index.js';
import {
  PERFORMANCE_PERMISSIONS,
  ReportSourceProviders,
  SyncQueue,
  SyncService,
  createPerformanceModule,
  seedClientPlatforms,
  type SheetGrid,
} from '../../src/modules/performance/index.js';
import { FAKE_PEOPLE, snoonuGrid, type FakePerson } from '../fixtures/snoonu-daily-report.js';
import { createFixture, type Fixture } from './fixtures.js';
import { connectionUrl } from './global-setup.js';
import { connect, testDatabase } from './helpers.js';
import { TEST_AUTH_ENV } from './test-env.js';

const PASSWORD = 'synthetic-pass-4-5b';
const READ_ON = '2026-11-20';
const NOW = new Date('2026-11-20T01:30:00.000Z');
/** Block days 1 to 15 = 26 Oct to 9 Nov (block 26..31 are the first six days). */
const EARLY_DAYS = [26, 27, 28, 29, 30, 31, 1, 2, 3, 4, 5, 6, 7, 8, 9];
/** Block days 10 to 19 = 10 Nov to 19 Nov. */
const LATE_DAYS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];

let owner: pg.Client;
let pool: Pool;
let redis: Redis;
let f: Fixture;
let app: Express;
let queue: SyncQueue;
let importQueue: ImportQueue;
const storage = new MemoryStorageAdapter();
let alice: string;
let vic: string;
let rob: string;
let sheetSource: string;
let platformId: string;
let sheet: SheetGrid = snoonuGrid();
let runCount = 0;

type Json = Record<string, unknown>;
const as = (token: string, req: request.Test) => req.set('Authorization', `Bearer ${token}`);
const get = (token: string, path: string) => as(token, request(app).get(`${API_PREFIX}${path}`));
const post = (token: string, path: string, body: Json = {}) =>
  as(token, request(app).post(`${API_PREFIX}${path}`))
    .set('Idempotency-Key', randomUUID())
    .send(body);

const TEMPLATE_PERSON = FAKE_PEOPLE[0];
if (TEMPLATE_PERSON === undefined) throw new Error('fixture has no people');

/** A fake person with a fresh ID; names, phones and plates are invented. */
const person = (falconId: number, over: Partial<FakePerson> = {}): FakePerson => ({
  ...TEMPLATE_PERSON,
  falconId,
  ...over,
});

/** Reads this sheet through the queue and waits for the run to finish. */
async function syncSheet(grid: SheetGrid): Promise<void> {
  sheet = grid;
  const res = await post(alice, `/sync-sources/${sheetSource}/run`, { readOn: READ_ON });
  expect(res.status).toBe(202);
  runCount += 1;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const list = await get(alice, `/sync-runs?syncSourceId=${sheetSource}&pageSize=200`);
    const items = (list.body as { items: { status: string }[] }).items;
    if (items.length >= runCount && items.every((r) => r.status !== 'running')) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('sync did not finish');
}

interface QueueItem {
  id: string;
  externalId: string;
  status: string;
  firstSeen: string;
  lastSeen: string;
  ordersSeen: number;
  daysSeen: number;
  sheetName: string | null;
  sheetPhone: string | null;
  sheetProfession: string | null;
  sheetPlate: string | null;
  sheetZone: string | null;
  resolvedPartyId: string | null;
  resolvedPartyName: string | null;
  ignoreReason: string | null;
}

async function queueRow(externalId: string, token = alice): Promise<QueueItem> {
  const res = await get(token, `/unmatched-identifiers?search=${externalId}`);
  expect(res.status).toBe(200);
  const found = (res.body as { items: QueueItem[] }).items.find((i) => i.externalId === externalId);
  if (found === undefined) throw new Error(`no queue row for ${externalId}`);
  return found;
}

async function newEmployee(
  displayName: string,
  phone: string,
): Promise<{ id: string; partyId: string }> {
  const res = await post(alice, '/employees', {
    person: { displayName, phones: [phone] },
    joiningDate: '2026-10-01',
  });
  expect(res.status).toBe(201);
  return res.body as { id: string; partyId: string };
}

async function rowsOf(externalId: string) {
  const r = await owner.query<{ party_id: string | null; is_current: boolean; d: string }>(
    `SELECT party_id, is_current, business_date::text AS d FROM performance.daily_performance
      WHERE client_platform_id = $1 AND external_id = $2 ORDER BY business_date, created_at`,
    [platformId, externalId],
  );
  return r.rows;
}
const currentOf = async (externalId: string) =>
  (await rowsOf(externalId)).filter((r) => r.is_current);

beforeAll(async () => {
  owner = await connect('owner');
  f = await createFixture(owner);
  const db = testDatabase();
  pool = createPool(connectionUrl(db, db.app), 4);
  redis = createRedis(inject('redisUrl'), 'fibrex-test-performance-unmatched');
  const prisma = createPrisma(pool);
  await syncPermissionCatalogue(prisma, [
    ...KERNEL_PERMISSIONS,
    ...PERFORMANCE_PERMISSIONS,
    ...PEOPLE_PERMISSIONS,
  ]);
  await syncEventTypes(prisma, createPerformanceModule().eventTypes ?? []);
  const slug =
    (
      await owner.query<{ slug: string }>(`SELECT slug FROM platform.tenant WHERE id = $1`, [
        f.tenantA,
      ])
    ).rows[0]?.slug ?? '';

  // Roles and users: alice has every permission, vic only reads the queue, rob may resolve it
  // but has no permission to create employees.
  const addRole = async (key: string, keys: readonly string[] | 'all') => {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO iam.role (id, tenant_id, key, name, is_builtin) VALUES ($1, $2, $3, $3, false)`,
      [id, f.tenantA, key],
    );
    await owner.query(
      `INSERT INTO iam.role_permission (tenant_id, role_id, permission_id)
       SELECT $1, $2, id FROM iam.permission WHERE $3::text[] IS NULL OR key = ANY ($3::text[])`,
      [f.tenantA, id, keys === 'all' ? null : keys],
    );
    return id;
  };
  const addUser = async (id: string, username: string, roleId: string) => {
    await owner.query(
      `INSERT INTO iam.user_account (id, tenant_id, username, display_name, must_change_password)
       VALUES ($1, $2, $3, $3, false) ON CONFLICT (id) DO UPDATE SET must_change_password = false`,
      [id, f.tenantA, username],
    );
    await owner.query(
      `INSERT INTO iam.credential (tenant_id, user_id, kind, hash) VALUES ($1, $2, 'password', $3)`,
      [f.tenantA, id, await hashPassword(PASSWORD)],
    );
    const membership = randomUUID();
    await owner.query(
      `INSERT INTO iam.company_membership (id, tenant_id, user_id, company_id, is_default)
       VALUES ($1, $2, $3, $4, true)`,
      [membership, f.tenantA, id, f.companyA1],
    );
    await owner.query(
      `INSERT INTO iam.membership_role (tenant_id, membership_id, role_id) VALUES ($1, $2, $3)`,
      [f.tenantA, membership, roleId],
    );
  };
  await addUser(f.userA, 'alice', await addRole('queue_admin', 'all'));
  await addUser(randomUUID(), 'vic', await addRole('queue_reader', ['performance.unmatched.read']));
  await addUser(
    randomUUID(),
    'rob',
    await addRole('queue_resolver', [
      'performance.unmatched.read',
      'performance.unmatched.resolve',
    ]),
  );

  expect(await seedEmployeeStatus(owner, f.tenantA)).toBe(true);
  await owner.query(
    `INSERT INTO platform.org_unit (tenant_id, company_id, kind, code, name)
     VALUES ($1, $2, 'zone', 'NORTH', 'Zone North')`,
    [f.tenantA, f.companyA1],
  );
  platformId = await seedClientPlatforms(owner, f.tenantA, f.companyA1);
  const source = await owner.query<{ id: string }>(
    `INSERT INTO performance.sync_source (tenant_id, company_id, client_platform_id, name, adapter_kind)
     VALUES ($1, $2, $3, 'Snoonu daily report', 'sheet') RETURNING id`,
    [f.tenantA, f.companyA1, platformId],
  );
  sheetSource = source.rows[0]?.id ?? '';

  const env = loadEnv({
    DATABASE_URL: 'postgresql://unused@localhost:1/x',
    REDIS_URL: 'redis://localhost:1',
    ...TEST_AUTH_ENV,
    RATE_LIMIT_ANONYMOUS: '10000',
    RATE_LIMIT_AUTHENTICATED: '10000',
    AUTH_RATE_LIMIT: '10000',
  });
  const vault = new PartyVault(new SecretBox(env.DATA_ENCRYPTION_KEY), env.DATA_ENCRYPTION_KEY);
  const logger = createLogger({ level: 'silent', pretty: false, serviceName: 'test' });
  const uow = new UnitOfWork(prisma);
  const providers = new ReportSourceProviders();
  providers.register({
    adapterKind: 'sheet',
    open: () => ({ read: () => Promise.resolve(sheet) }),
  });
  const parties = new PartyService(vault);
  const service = new SyncService({
    uow,
    storage,
    parties,
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
    attempts: 1,
    backoffMs: 50,
    queueName: `performance-unmatched-test-${randomUUID()}`,
  });
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
  const importTargets = new ImportTargets(() => Promise.reject(new NotFoundError()));
  const importService = new ImportService({ uow, storage, permissions, targets: importTargets });
  // The queue name is shared by every test file, so this file runs the worker's own
  // `process` (the same commit code) straight from enqueue instead of through Redis.
  class InlineImportQueue extends ImportQueue {
    override async enqueue(job: Parameters<ImportQueue['enqueue']>[0]): Promise<void> {
      await this.process(job);
    }
  }
  importQueue = new InlineImportQueue({
    redisUrl: inject('redisUrl'),
    service: importService,
    logger,
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
      const modules = new ModuleRegistry({ kernelPermissions: KERNEL_PERMISSIONS });
      const people = createPeopleModule({
        uow,
        registry,
        permissions,
        parties,
        numbering: new NumberingService(),
        vault,
        audit: createAuditService(),
        attachables: new AttachableRegistry(),
        importTargets,
      });
      modules.register(people.manifest);
      modules.register(
        createPerformanceModule({
          uow,
          registry,
          permissions,
          sync: service,
          syncQueue: queue,
          parties,
          employees: people.directory,
        }),
      );
      modules.mount(api);
      // Row 4.5c: the real employee import (routes and queue worker), as in main.ts.
      api.use(
        createImportRouter({
          uow,
          registry,
          permissions,
          service: importService,
          exports: new ExportService({ storage, permissions, targets: importTargets }),
          queue: importQueue,
          targets: importTargets,
        }),
      );
    },
  });

  const signIn = async (identifier: string) => {
    const login = await request(app)
      .post(`${API_PREFIX}/auth/login`)
      .send({ tenant: slug, identifier, password: PASSWORD });
    expect(login.status).toBe(200);
    return (login.body as { accessToken: string }).accessToken;
  };
  alice = await signIn('alice');
  vic = await signIn('vic');
  rob = await signIn('rob');
}, 60_000);

afterAll(async () => {
  await queue.getQueue().obliterate({ force: true });
  await queue.close();
  await importQueue.close();
  const counters = await redis.keys('rl:*');
  if (counters.length > 0) await redis.del(...counters);
  await redis.quit();
  await pool.end();
  await owner.end();
});

describe('unmatched riders queue (row 4.5b)', () => {
  it('keeps what the sheet says about each unmatched ID, and lists and filters them', async () => {
    await syncSheet(
      snoonuGrid({
        people: [
          person(91001, {
            name: 'Test Rider Alpha',
            phone: 97455500001,
            type: 'Rider',
            zone: 'Zone North',
            plate: 'TEST-901',
          }),
          person(91002, {
            name: 'Test Driver Bravo',
            phone: 97455500002,
            type: 'Driver',
            zone: 'Zone South',
            plate: 'TEST-902',
          }),
        ],
      }),
    );
    const alpha = await queueRow('91001');
    expect(alpha).toMatchObject({
      status: 'open',
      sheetName: 'Test Rider Alpha',
      sheetPhone: '97455500001',
      sheetProfession: 'Rider',
      sheetPlate: 'TEST-901',
      sheetZone: 'Zone North',
      firstSeen: '2026-10-26',
      lastSeen: '2026-11-19',
    });
    expect(alpha.ordersSeen).toBeGreaterThan(0);
    // Days off carry no figures, so the day count is what is stored, not the whole cycle.
    expect(alpha.daysSeen).toBe((await currentOf('91001')).length);
    expect(alpha.daysSeen).toBeGreaterThan(15);

    // A blank cell on a later run never wipes what an earlier run read.
    await syncSheet(
      snoonuGrid({
        people: [
          person(91001, {
            name: 'Test Rider Alpha',
            phone: 97455500001,
            type: 'Rider',
            zone: 'Zone North',
            plate: '',
          }),
        ],
      }),
    );
    expect((await queueRow('91001')).sheetPlate).toBe('TEST-901');

    const byName = await get(alice, '/unmatched-identifiers?search=bravo&status=open');
    expect((byName.body as { items: QueueItem[] }).items.map((i) => i.externalId)).toEqual([
      '91002',
    ]);
    const byPhone = await get(alice, '/unmatched-identifiers?search=5550000');
    expect((byPhone.body as { total: number }).total).toBe(2);
    const noneLinked = await get(alice, '/unmatched-identifiers?status=linked');
    expect((noneLinked.body as { total: number }).total).toBe(0);
    const otherPlatform = await get(alice, `/unmatched-identifiers?platform=${randomUUID()}`);
    expect((otherPlatform.body as { total: number }).total).toBe(0);
  }, 60_000);

  it('permissions: read only can list but not resolve; resolve alone cannot create employees; no token is refused', async () => {
    const row = await queueRow('91002');
    expect((await get(vic, '/unmatched-identifiers')).status).toBe(200);
    expect((await get(vic, `/unmatched-identifiers/${row.id}/candidates`)).status).toBe(403);
    expect(
      (await post(vic, `/unmatched-identifiers/${row.id}/ignore`, { reason: 'no' })).status,
    ).toBe(403);
    expect(
      (await post(vic, `/unmatched-identifiers/${row.id}/link`, { employeeId: randomUUID() }))
        .status,
    ).toBe(403);
    expect((await post(rob, `/unmatched-identifiers/${row.id}/create-employee`)).status).toBe(403);
    expect((await request(app).get(`${API_PREFIX}/unmatched-identifiers`)).status).toBe(401);
    // Nothing changed by the refused calls.
    expect((await queueRow('91002')).status).toBe('open');
  });

  it('candidates: best name matches first, then search by name, phone digits or code', async () => {
    const near = await newEmployee('Rider Alpha Testing', '+97455510001');
    await newEmployee('Someone Else', '+97455510002');
    const row = await queueRow('91001');
    const res = await get(rob, `/unmatched-identifiers/${row.id}/candidates?q=5551000`);
    expect(res.status).toBe(200);
    const body = res.body as {
      suggested: { employeeId: string; displayName: string }[];
      results: { displayName: string; phone: string | null }[];
    };
    expect(body.suggested.map((c) => c.employeeId)).toContain(near.id);
    expect(body.suggested.every((c) => c.displayName !== 'Someone Else')).toBe(true);
    expect(body.results.map((c) => c.displayName).sort()).toEqual([
      'Rider Alpha Testing',
      'Someone Else',
    ]);
    const code = await get(rob, `/unmatched-identifiers/${row.id}/candidates?q=E0002`);
    expect((code.body as { results: unknown[] }).results.length).toBe(1);
  });

  it('link: adds the Falcon ID from the first seen date, attaches every stored row in one go, audits it', async () => {
    const mine = await newEmployee('Linked Person One', '+97455510003');
    const row = await queueRow('91001');
    const before = await currentOf('91001');
    const total = before.length;
    expect(total).toBeGreaterThan(15);
    expect(before.every((r) => r.party_id === null)).toBe(true);

    const res = await post(rob, `/unmatched-identifiers/${row.id}/link`, { employeeId: mine.id });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'linked',
      partyId: mine.partyId,
      employeeId: mine.id,
      validFrom: '2026-10-26',
      attachedRows: total,
      leftUnmatched: 0,
    });

    // The figures moved to the person: the old rows stay as history, every current row has the party.
    const now = await currentOf('91001');
    expect(now.length).toBe(total);
    expect(now.every((r) => r.party_id === mine.partyId)).toBe(true);
    expect((await rowsOf('91001')).filter((r) => !r.is_current).length).toBe(total);

    const ids = await owner.query<{
      type: string;
      valid_from: string;
      valid_to: string | null;
      client_platform_id: string;
    }>(
      `SELECT type, valid_from::text, valid_to::text, client_platform_id FROM party.party_identifier
        WHERE party_id = $1 AND deleted_at IS NULL`,
      [mine.partyId],
    );
    expect(ids.rows).toEqual([
      {
        type: 'falcon_id',
        valid_from: '2026-10-26',
        valid_to: null,
        client_platform_id: platformId,
      },
    ]);
    const item = await queueRow('91001');
    expect(item).toMatchObject({
      status: 'linked',
      resolvedPartyId: mine.partyId,
      resolvedPartyName: 'Linked Person One',
    });

    // Audit: the queue row and the identifier carry the user who linked (rob).
    const audited = await owner.query<{ n: string }>(
      `SELECT count(DISTINCT entity_id) AS n FROM audit.audit_log
        WHERE entity_id = ANY ($1::uuid[]) AND user_id IS NOT NULL`,
      [[row.id]],
    );
    expect(Number(audited.rows[0]?.n)).toBe(1);

    // Doing it twice is refused.
    expect(
      (await post(rob, `/unmatched-identifiers/${row.id}/link`, { employeeId: mine.id })).status,
    ).toBe(409);
  }, 40_000);

  it('one person can hold two Falcon IDs (old and new) with dated history', async () => {
    // Old ID seen 26 Oct to 9 Nov, new ID seen 10 to 19 Nov: two sheets, two syncs.
    await syncSheet(
      snoonuGrid({
        people: [person(92001, { name: 'Old Id Rider', phone: 97455500021 })],
        filledDays: EARLY_DAYS,
      }),
    );
    await syncSheet(
      snoonuGrid({
        people: [person(92002, { name: 'Old Id Rider', phone: 97455500021 })],
        filledDays: LATE_DAYS,
      }),
    );
    const oldRow = await queueRow('92001');
    const newRow = await queueRow('92002');
    expect([oldRow.firstSeen, oldRow.lastSeen]).toEqual(['2026-10-26', '2026-11-09']);
    expect([newRow.firstSeen, newRow.lastSeen]).toEqual(['2026-11-10', '2026-11-19']);

    const emp = await newEmployee('Old Id Rider', '+97455500021');
    const first = await post(alice, `/unmatched-identifiers/${oldRow.id}/link`, {
      employeeId: emp.id,
    });
    expect(first.status).toBe(200);
    // HR ends the old ID's period the day before the new one starts.
    await owner.query(
      `UPDATE party.party_identifier SET valid_to = '2026-11-09'
        WHERE party_id = $1 AND type = 'falcon_id' AND deleted_at IS NULL`,
      [emp.partyId],
    );
    const lateRows = (await currentOf('92002')).length;
    const earlyRows = (await currentOf('92001')).length;
    const second = await post(alice, `/unmatched-identifiers/${newRow.id}/link`, {
      employeeId: emp.id,
    });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      validFrom: '2026-11-10',
      attachedRows: lateRows,
      leftUnmatched: 0,
    });

    const held = await owner.query<{
      valid_from: string;
      valid_to: string | null;
      value_plain: string;
    }>(
      `SELECT valid_from::text, valid_to::text, value_plain FROM party.party_identifier
        WHERE party_id = $1 AND type = 'falcon_id' AND deleted_at IS NULL ORDER BY valid_from`,
      [emp.partyId],
    );
    expect(held.rows).toEqual([
      { valid_from: '2026-10-26', valid_to: '2026-11-09', value_plain: '92001' },
      { valid_from: '2026-11-10', valid_to: null, value_plain: '92002' },
    ]);
    // One current row per day for the person, from either ID.
    const days = await owner.query<{ n: string; d: string }>(
      `SELECT count(*) AS n, count(DISTINCT business_date) AS d FROM performance.daily_performance
        WHERE client_platform_id = $1 AND party_id = $2 AND is_current`,
      [platformId, emp.partyId],
    );
    expect(days.rows[0]).toEqual({
      n: String(earlyRows + lateRows),
      d: String(earlyRows + lateRows),
    });
  }, 60_000);

  it('refuses a link when another person holds the ID in an overlapping period, and changes nothing', async () => {
    await syncSheet(
      snoonuGrid({ people: [person(93001, { name: 'Contested Id', phone: 97455500031 })] }),
    );
    const row = await queueRow('93001');
    const holder = await newEmployee('Holder Of Contested Id', '+97455510031');
    const wanting = await newEmployee('Wants Contested Id', '+97455510032');
    // The holder takes the ID from 15 Nov, open-ended: that overlaps a link starting 26 Oct.
    const early = await post(alice, `/unmatched-identifiers/${row.id}/link`, {
      employeeId: holder.id,
      validFrom: '2026-11-15',
    });
    expect(early.status).toBe(200);

    // A second unmatched row cannot take it while the holder has it.
    await owner.query(
      `UPDATE performance.unmatched_identifier SET status = 'open', resolved_party_id = NULL, resolved_on = NULL
        WHERE id = $1`,
      [row.id],
    );
    const attachedBefore = (await currentOf('93001')).filter((r) => r.party_id !== null).length;
    const refused = await post(alice, `/unmatched-identifiers/${row.id}/link`, {
      employeeId: wanting.id,
    });
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain('identifier_in_use');
    expect(JSON.stringify(refused.body)).toContain('Holder Of Contested Id');

    // Nothing moved: no identifier for the other person, same attached rows, row still open.
    const none = await owner.query(
      `SELECT 1 FROM party.party_identifier WHERE party_id = $1 AND deleted_at IS NULL`,
      [wanting.partyId],
    );
    expect(none.rowCount).toBe(0);
    expect((await currentOf('93001')).filter((r) => r.party_id !== null).length).toBe(
      attachedBefore,
    );
    expect((await queueRow('93001')).status).toBe('open');
  }, 60_000);

  it('create employee: from the sheet row, with the Falcon ID, placement, phone and zone', async () => {
    await syncSheet(
      snoonuGrid({
        people: [
          person(94001, {
            name: 'Created From Sheet',
            phone: 97455500041,
            type: 'Driver',
            zone: 'Zone North',
          }),
        ],
      }),
    );
    const row = await queueRow('94001');
    const sheetRows = (await currentOf('94001')).length;
    const res = await post(alice, `/unmatched-identifiers/${row.id}/create-employee`);
    expect(res.status).toBe(201);
    const body = res.body as { employeeId: string; partyId: string; employeeCode: string };
    expect(res.body).toMatchObject({
      status: 'created',
      validFrom: '2026-10-26',
      attachedRows: sheetRows,
      zoneMatched: true,
    });
    expect(body.employeeCode).toMatch(/^E\d{4}$/);

    const placement = await owner.query<{
      profession: string;
      client_platform_id: string;
      org_unit_id: string | null;
    }>(
      `SELECT profession, client_platform_id, org_unit_id FROM people.employee_placement WHERE employee_id = $1`,
      [body.employeeId],
    );
    expect(placement.rows[0]).toMatchObject({
      profession: 'driver',
      client_platform_id: platformId,
    });
    expect(placement.rows[0]?.org_unit_id).not.toBeNull();
    const phone = await owner.query<{ value: string }>(
      `SELECT value FROM party.party_contact WHERE party_id = $1`,
      [body.partyId],
    );
    expect(phone.rows.map((r) => r.value)).toEqual(['+97455500041']);
    expect((await currentOf('94001')).every((r) => r.party_id === body.partyId)).toBe(true);
    expect(await queueRow('94001')).toMatchObject({
      status: 'created',
      resolvedPartyId: body.partyId,
      resolvedPartyName: 'Created From Sheet',
    });

    // An unclear "Driver / Rider" cell must be chosen; a clear choice then works.
    await syncSheet(
      snoonuGrid({
        people: [person(94002, { name: 'Unclear Kind', phone: 97455500042, type: 'Rider' })],
      }),
    );
    const unclear = await queueRow('94002');
    await owner.query(
      `UPDATE performance.unmatched_identifier SET sheet_profession = 'Driver / Rider' WHERE id = $1`,
      [unclear.id],
    );
    const needChoice = await post(alice, `/unmatched-identifiers/${unclear.id}/create-employee`);
    expect(needChoice.status).toBe(422);
    expect(JSON.stringify(needChoice.body)).toContain('profession_required');
    const chosen = await post(alice, `/unmatched-identifiers/${unclear.id}/create-employee`, {
      profession: 'rider',
    });
    expect(chosen.status).toBe(201);
  }, 60_000);

  it('ignore: needs a reason, closes the row, and cannot be repeated', async () => {
    const row = await queueRow('91002');
    expect((await post(alice, `/unmatched-identifiers/${row.id}/ignore`, {})).status).toBe(400);
    const res = await post(rob, `/unmatched-identifiers/${row.id}/ignore`, {
      reason: 'Not our rider: another company',
    });
    expect(res.status).toBe(200);
    expect(await queueRow('91002')).toMatchObject({
      status: 'ignored',
      ignoreReason: 'Not our rider: another company',
    });
    expect(
      (await post(rob, `/unmatched-identifiers/${row.id}/link`, { employeeId: randomUUID() }))
        .status,
    ).toBe(409);
    const stillUnmatched = await currentOf('91002');
    expect(stillUnmatched.every((r) => r.party_id === null)).toBe(true);
  });
});

/** Puts a CSV in storage with its file_object row, as the signed upload would. */
async function uploadCsv(csv: string): Promise<string> {
  const bytes = Buffer.from(csv, 'utf8');
  const key = `${f.tenantA}/${f.companyA1}/test/${randomUUID()}`;
  storage.put(key, bytes);
  const row = await owner.query<{ id: string }>(
    `INSERT INTO files.file_object (tenant_id, company_id, bucket, object_key, sha256, size_bytes, mime_type, original_name)
     VALUES ($1, $2, 'memory', $3, $4, $5, 'text/csv', 'employees.csv') RETURNING id`,
    [f.tenantA, f.companyA1, key, createHash('sha256').update(bytes).digest('hex'), bytes.length],
  );
  return row.rows[0]?.id ?? '';
}

/** Imports employees through the real import routes (upload, preview, commit). */
async function importEmployees(csv: string): Promise<void> {
  const created = await post(alice, '/imports', {
    entityKey: 'people.employee',
    fileObjectId: await uploadCsv(csv),
  });
  expect(created.status).toBe(201);
  const jobId = (created.body as { id: string }).id;
  const previewed = await post(alice, `/imports/${jobId}/preview`, {
    mapping: {
      columnMap: { display_name: 'Name', falcon_id: 'Falcon ID', joining_date: 'Joining date' },
      transforms: {},
    },
  });
  expect(previewed.status).toBe(200);
  expect(previewed.body).toMatchObject({ stats: { invalid: 0 } });
  expect((await post(alice, `/imports/${jobId}/commit`)).status).toBe(202);
  const job = (await get(alice, `/imports/${jobId}`)).body as { status: string };
  expect(job.status).toBe('committed');
}

const partyWithFalcon = async (falconId: string) =>
  (
    await owner.query<{ party_id: string; valid_from: string }>(
      `SELECT party_id, valid_from::text FROM party.party_identifier
        WHERE type = 'falcon_id' AND value_plain = $1 AND deleted_at IS NULL`,
      [falconId],
    )
  ).rows;

const openQueueIds = async () =>
  (
    await owner.query<{ external_id: string }>(
      `SELECT external_id FROM performance.unmatched_identifier
        WHERE client_platform_id = $1 AND status = 'open' AND deleted_at IS NULL`,
      [platformId],
    )
  ).rows.map((r) => r.external_id);

describe('Falcon ID matching after the employee import (row 4.5c)', () => {
  it('an employee imported with a Falcon ID and no joining date is matched on past sheet days', async () => {
    // The CSV gives the id as text; the sheet holds it as a number cell (as the real files do).
    await importEmployees(
      ['Name,Falcon ID,Joining date', 'Import Match One,97501,', ''].join('\n'),
    );
    const held = await partyWithFalcon('97501');
    expect(held).toHaveLength(1);
    // Held since "start unknown", not since the import day.
    expect(held[0]?.valid_from).toBe('1900-01-01');

    await syncSheet(snoonuGrid({ people: [person(97501, { name: 'Import Match One' })] }));
    const rows = await currentOf('97501');
    expect(rows.length).toBeGreaterThan(15);
    expect(rows.every((r) => r.party_id === held[0]?.party_id)).toBe(true);
    expect(await openQueueIds()).not.toContain('97501');
  });

  it('re-resolve repairs ids dated from the import day, once, in one audited step', async () => {
    await importEmployees(
      [
        'Name,Falcon ID,Joining date',
        'Import Repair Two,97502,',
        'Import Joined Three,97503,2026-11-05',
        '',
      ].join('\n'),
    );
    // The state the old import left behind: the id dated from the day it was written.
    await owner.query(
      `UPDATE party.party_identifier SET valid_from = created_at::date
        WHERE type = 'falcon_id' AND value_plain = '97502'`,
    );
    await syncSheet(
      snoonuGrid({
        people: [
          person(97502, { name: 'Import Repair Two' }),
          person(97503, { name: 'Import Joined Three' }),
        ],
      }),
    );
    expect(await openQueueIds()).toEqual(expect.arrayContaining(['97502', '97503']));
    expect((await currentOf('97502')).every((r) => r.party_id === null)).toBe(true);

    // Read-only users cannot run it.
    expect((await post(vic, '/unmatched-identifiers/re-resolve')).status).toBe(403);

    const first = await post(alice, '/unmatched-identifiers/re-resolve');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ identifiersBackdated: 1 });
    const two = (await partyWithFalcon('97502'))[0];
    expect(two?.valid_from).toBe('1900-01-01');
    expect((await currentOf('97502')).every((r) => r.party_id === two?.party_id)).toBe(true);
    expect(await openQueueIds()).not.toContain('97502');
    expect((await queueRow('97502')).status).toBe('linked');

    // A real joining date is kept: days before it stay unmatched and the row stays open.
    const three = (await partyWithFalcon('97503'))[0];
    expect(three?.valid_from).toBe('2026-11-05');
    const threeRows = await currentOf('97503');
    expect(threeRows.filter((r) => r.d < '2026-11-05').every((r) => r.party_id === null)).toBe(
      true,
    );
    expect(threeRows.filter((r) => r.d >= '2026-11-05').every((r) => r.party_id !== null)).toBe(
      true,
    );
    expect(await openQueueIds()).toContain('97503');

    // Safe to repeat: nothing more to do.
    const second = await post(alice, '/unmatched-identifiers/re-resolve');
    expect(second.body).toMatchObject({
      identifiersBackdated: 0,
      figureRowsAttached: 0,
      rowsLinked: 0,
    });

    const audit = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit.audit_log
        WHERE tenant_id = $1 AND action = 'repair' AND entity_type = 'performance.unmatched_identifier'`,
      [f.tenantA],
    );
    expect(Number(audit.rows[0]?.n)).toBeGreaterThanOrEqual(2);
  });
});
