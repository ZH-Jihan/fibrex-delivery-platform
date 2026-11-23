/**
 * Row 4.9: the Snoonu FDB report check, driven through the real routes, the real permission
 * service, the real party identifier lookup and real documents. The FDB tab is a fake grid in
 * the real layout (totals row, header row, one row per person); every name and id is invented.
 *
 * Checked: figures read and matched by Falcon ID; every kind of difference (date differs,
 * missing on either side, status, unknown id, person without employee record, active person
 * the tab omits); nothing is written to employees or documents; filters; review marks and
 * their carry-over to the next run (and a changed value coming back open); permissions
 * (read only cannot run or review); a tab with no header is refused with a clear message.
 */
import { randomUUID } from 'node:crypto';
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
import {
  PARTY_PERMISSIONS,
  PartyReferenceRegistry,
  PartyService,
  PartyVault,
  createPartyModule,
} from '../../src/modules/party/index.js';
import {
  PEOPLE_PERMISSIONS,
  createPeopleModule,
  seedDocumentTypes,
  seedEmployeeStatus,
} from '../../src/modules/people/index.js';
import {
  FdbService,
  PERFORMANCE_PERMISSIONS,
  ReportSourceProviders,
  SyncQueue,
  SyncService,
  createPerformanceModule,
  seedClientPlatforms,
  type SheetCell,
  type SheetGrid,
} from '../../src/modules/performance/index.js';
import { createFixture, type Fixture } from './fixtures.js';
import { connectionUrl } from './global-setup.js';
import { connect, testDatabase } from './helpers.js';
import { TEST_AUTH_ENV } from './test-env.js';

const PASSWORD = 'synthetic-pass-4-9';
const NOW = new Date('2026-11-20T06:00:00.000Z');

let owner: pg.Client;
let pool: Pool;
let redis: Redis;
let f: Fixture;
let app: Express;
let alice: string;
let vic: string;
let syncSourceId: string;
let queue: SyncQueue;
let tab: SheetGrid | null = null;
const types: Record<string, string> = {};

type Json = Record<string, unknown>;
const as = (token: string, req: request.Test) => req.set('Authorization', `Bearer ${token}`);
const get = (token: string, path: string) => as(token, request(app).get(`${API_PREFIX}${path}`));
const post = (token: string, path: string, body: Json = {}) =>
  as(token, request(app).post(`${API_PREFIX}${path}`))
    .set('Idempotency-Key', randomUUID())
    .send(body);

const HEAD: SheetCell[] = [
  'Falcon ID',
  'Agent Name',
  'Type',
  'Account Status',
  'Employment Status',
  'Documents Status',
  'Sponsorship',
  'Secondment (Iaara)',
  'QID',
  'Passport',
  'Istimara',
  'Driving License',
  'Insurance',
  'FHC',
  'Health Card',
];
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
function fdbRow(
  id: string,
  name: string,
  over: Partial<Record<number, SheetCell>> = {},
): SheetCell[] {
  const row: SheetCell[] = [
    id,
    name,
    'Rider',
    'Active',
    'active',
    'Updated',
    'No',
    null,
    day('2027-01-15'),
    day('2028-02-01'),
    null,
    day('2027-03-10'),
    null,
    null,
    day('2027-05-05'),
  ];
  for (const [i, v] of Object.entries(over)) row[Number(i)] = v ?? null;
  return row;
}
const grid = (...rows: SheetCell[][]): SheetGrid => ({
  tab: 'FDB Report',
  rows: [['FDB Report:', 'Fake Co', null, 'Active Fleet:5'], HEAD, ...rows],
});

async function newEmployee(displayName: string, phone: string, falcon: string | null) {
  const res = await post(alice, '/employees', {
    person: { displayName, phones: [phone] },
    joiningDate: '2026-10-01',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const emp = res.body as { id: string; partyId: string };
  if (falcon !== null) {
    const id = await post(alice, '/party-identifiers', {
      partyId: emp.partyId,
      type: 'falcon_id',
      value: falcon,
      validFrom: '2026-10-01',
    });
    expect(id.status, JSON.stringify(id.body)).toBe(201);
  }
  return emp;
}
async function addDoc(partyId: string, type: string, expiry: string) {
  const res = await post(alice, '/documents', {
    ownerType: 'party',
    ownerId: partyId,
    documentTypeId: types[type],
    number: `N-${randomUUID().slice(0, 8)}`,
    expiryDate: expiry,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

interface Diff {
  id: string;
  kind: string;
  field: string | null;
  displayName: string | null;
  externalId: string | null;
  oursValue: string | null;
  theirsValue: string | null;
  reviewStatus: string;
}
interface Listing {
  check: { id: string; rowsRead: number; matched: number; unmatched: number } | null;
  items: Diff[];
  openByKind: Record<string, number>;
  total: number;
}
const listing = async (query = '', token = alice) => {
  const res = await get(token, `/performance/fdb-check${query}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as Listing;
};
const runCheck = (token = alice) => post(token, '/performance/fdb-check/run', { syncSourceId });

beforeAll(async () => {
  owner = await connect('owner');
  f = await createFixture(owner);
  const db = testDatabase();
  pool = createPool(connectionUrl(db, db.app), 4);
  redis = createRedis(inject('redisUrl'), 'fibrex-test-performance-fdb');
  const prisma = createPrisma(pool);
  await syncPermissionCatalogue(prisma, [
    ...KERNEL_PERMISSIONS,
    ...PERFORMANCE_PERMISSIONS,
    ...PEOPLE_PERMISSIONS,
    ...PARTY_PERMISSIONS,
  ]);
  const slug =
    (
      await owner.query<{ slug: string }>(`SELECT slug FROM platform.tenant WHERE id = $1`, [
        f.tenantA,
      ])
    ).rows[0]?.slug ?? '';

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
  await addUser(f.userA, 'alice', await addRole('fdb_admin', 'all'));
  await addUser(randomUUID(), 'vic', await addRole('fdb_reader', ['performance.fdb_check.read']));

  expect(await seedEmployeeStatus(owner, f.tenantA)).toBe(true);
  await seedDocumentTypes(owner, f.tenantA, f.companyA1);
  const platformId = await seedClientPlatforms(owner, f.tenantA, f.companyA1);
  const source = await owner.query<{ id: string }>(
    `INSERT INTO performance.sync_source (tenant_id, company_id, client_platform_id, name, adapter_kind)
     VALUES ($1, $2, $3, 'Snoonu daily report', 'sheet') RETURNING id`,
    [f.tenantA, f.companyA1, platformId],
  );
  syncSourceId = source.rows[0]?.id ?? '';

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
    open: () => ({
      read: (name) =>
        tab?.tab === name ? Promise.resolve(tab) : Promise.reject(new Error('no tab')),
    }),
  });
  const parties = new PartyService(vault);
  const storage = new MemoryStorageAdapter();
  const box = new SecretBox(env.DATA_ENCRYPTION_KEY);
  const sync = new SyncService({
    uow,
    storage,
    parties,
    providers,
    outbox: new EventOutbox(),
    box,
    logger,
    now: () => NOW,
  });
  queue = new SyncQueue({
    redisUrl: inject('redisUrl'),
    service: sync,
    prisma,
    logger,
    queueName: `performance-fdb-test-${randomUUID()}`,
  });
  const fdb = new FdbService({ uow, storage, parties, providers, box, logger, now: () => NOW });

  const tokens = new AccessTokens(env.AUTH_TOKEN_SECRET, env.AUTH_ACCESS_TTL_SECONDS);
  const mfa = new MfaFactors({
    box,
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
        createPartyModule({
          uow,
          registry,
          permissions,
          audit: createAuditService(),
          vault,
          references: new PartyReferenceRegistry(),
        }),
      );
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
        createPerformanceModule({ uow, registry, permissions, sync, syncQueue: queue, fdb }),
      );
      modules.mount(api);
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

  const typeList = await get(alice, '/document-types?pageSize=50');
  for (const t of (typeList.body as { items: { id: string; code: string }[] }).items) {
    types[t.code] = t.id;
  }

  // Our side (invented): Amina agrees with the tab on QID and passport; Bilal differs in
  // several ways; Omar is active with a Falcon ID that the tab does not list; Nour has an id
  // in the tab but no employee record.
  const amina = await newEmployee('Amina Test', '+97450000001', 'FX-9001');
  await addDoc(amina.partyId, 'qid', '2027-01-15');
  await addDoc(amina.partyId, 'passport', '2028-02-01');
  const bilal = await newEmployee('Bilal Test', '+97450000002', 'FX-9002');
  await addDoc(bilal.partyId, 'qid', '2027-01-15');
  await addDoc(bilal.partyId, 'driving_licence', '2027-03-10');
  await addDoc(bilal.partyId, 'food_handling', '2027-06-06');
  await newEmployee('Omar Test', '+97450000003', 'FX-9004');
  const nour = await post(alice, '/parties', { kind: 'person', displayName: 'Nour Test' });
  expect(nour.status, JSON.stringify(nour.body)).toBe(201);
  const nid = await post(alice, '/party-identifiers', {
    partyId: (nour.body as { id: string }).id,
    type: 'falcon_id',
    value: 'FX-9005',
    validFrom: '2026-10-01',
  });
  expect(nid.status).toBe(201);
}, 120_000);

afterAll(async () => {
  const counters = await redis.keys('rl:*');
  if (counters.length > 0) await redis.del(...counters);
  await queue.close();
  await redis.quit();
  await pool.end();
  await owner.end();
});

describe('FDB report check', () => {
  it('refuses a run without permission and without a sign-in', async () => {
    tab = grid(fdbRow('FX-9001', 'Amina'));
    expect((await runCheck(vic)).status).toBe(403);
    const anon = await request(app)
      .post(`${API_PREFIX}/performance/fdb-check/run`)
      .set('Idempotency-Key', randomUUID())
      .send({ syncSourceId });
    expect(anon.status).toBe(401);
    expect((await listing('', vic)).check).toBeNull();
  });

  it('refuses a tab it cannot read, saying why', async () => {
    tab = { tab: 'FDB Report', rows: [['nothing', 'useful']] };
    const res = await runCheck();
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain('Falcon ID');
    expect((await listing()).check).toBeNull();
  });

  it('lists every kind of difference and writes nothing to people or documents', async () => {
    const docsBefore = await owner.query(
      `SELECT count(*)::int AS n, max(version) AS v FROM people.document`,
    );
    const empBefore = await owner.query(
      `SELECT status_code, version FROM people.employee ORDER BY id`,
    );
    tab = grid(
      fdbRow('FX-9001', 'Amina Test'),
      // Bilal: QID date differs, status blocked, insurance only they have; food handling only we have.
      fdbRow('FX-9002', 'Bilal Test', {
        4: 'blocked',
        8: day('2027-02-15'),
        12: day('2027-09-09'),
      }),
      fdbRow('FX-9005', 'Nour Test'),
      fdbRow('FX-9999', 'Stranger Test'),
    );
    const res = await runCheck();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const run = res.body as Json;
    expect(run.rowsRead).toBe(4);
    expect(run.matched).toBe(3);
    expect(run.unmatched).toBe(1);

    const l = await listing();
    const kinds = l.items.map((d) => `${d.kind}:${d.field ?? ''}:${d.displayName ?? ''}`).sort();
    expect(kinds).toContain('expiry_differs:qid:Bilal Test');
    expect(kinds).toContain('status_differs::Bilal Test');
    expect(kinds).toContain('missing_ours:insurance:Bilal Test');
    expect(kinds).toContain('missing_theirs:food_handling:Bilal Test');
    expect(kinds).toContain('unmatched_id::Stranger Test');
    expect(kinds).toContain('no_employee::Nour Test');
    expect(kinds).toContain('not_in_fdb::Omar Test');
    // Amina agrees on QID and passport; the tab also shows a licence and a health card date
    // that she has no document for: those two are listed, the matching ones are not.
    const aminaDiffs = l.items.filter((d) => d.displayName === 'Amina Test');
    expect(aminaDiffs.map((d) => `${d.kind}:${d.field}`).sort()).toEqual([
      'missing_ours:driving_licence',
      'missing_ours:health_card',
    ]);
    const qid = l.items.find((d) => d.kind === 'expiry_differs');
    expect(qid).toMatchObject({ oursValue: '2027-01-15', theirsValue: '2027-02-15' });

    const docsAfter = await owner.query(
      `SELECT count(*)::int AS n, max(version) AS v FROM people.document`,
    );
    const empAfter = await owner.query(
      `SELECT status_code, version FROM people.employee ORDER BY id`,
    );
    expect(docsAfter.rows).toEqual(docsBefore.rows);
    expect(empAfter.rows).toEqual(empBefore.rows);
  });

  it('filters the differences', async () => {
    const byKind = await listing('?kind=status_differs');
    expect(byKind.items).toHaveLength(1);
    expect(byKind.total).toBeGreaterThan(1);
    const byDoc = await listing('?field=qid');
    expect(byDoc.items.every((d) => d.field === 'qid')).toBe(true);
    const byText = await listing('?q=bilal');
    expect(byText.items.every((d) => d.displayName === 'Bilal Test')).toBe(true);
    expect(byText.items.length).toBeGreaterThan(0);
    const none = await listing('?review=reviewed');
    expect(none.items).toHaveLength(0);
  });

  it('marks differences reviewed, keeps the mark on the next run, and reopens a changed value', async () => {
    const l = await listing();
    const qid = l.items.find((d) => d.kind === 'expiry_differs');
    const status = l.items.find((d) => d.kind === 'status_differs');
    if (qid === undefined || status === undefined) throw new Error('expected differences');

    const refused = await post(vic, `/performance/fdb-check/differences/${qid.id}/review`, {
      status: 'reviewed',
    });
    expect(refused.status).toBe(403);
    const ok = await post(alice, `/performance/fdb-check/differences/${qid.id}/review`, {
      status: 'reviewed',
      note: 'Snoonu is behind; renewed on our side',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((ok.body as Json).reviewStatus).toBe('reviewed');
    const ignored = await post(alice, `/performance/fdb-check/differences/${status.id}/review`, {
      status: 'ignored',
    });
    expect(ignored.status).toBe(200);

    // Next run: the QID difference is unchanged and keeps its mark; Bilal's status on the
    // sheet is now "terminated", so that one is a new open difference.
    tab = grid(
      fdbRow('FX-9001', 'Amina Test'),
      fdbRow('FX-9002', 'Bilal Test', {
        4: 'terminated',
        8: day('2027-02-15'),
        12: day('2027-09-09'),
      }),
      fdbRow('FX-9005', 'Nour Test'),
      fdbRow('FX-9999', 'Stranger Test'),
    );
    const second = await runCheck();
    expect(second.status).toBe(200);
    expect((second.body as Json).carriedOver).toBe(1);
    const after = await listing();
    expect(after.check?.id).not.toBe(l.check?.id);
    expect(after.items.find((d) => d.kind === 'expiry_differs')?.reviewStatus).toBe('reviewed');
    expect(after.items.find((d) => d.kind === 'status_differs')).toMatchObject({
      reviewStatus: 'open',
      theirsValue: 'terminated',
    });
    expect(after.openByKind.expiry_differs ?? 0).toBe(0);

    // The earlier run is still readable by id, with its own marks.
    const old = await listing(`?checkId=${l.check?.id ?? ''}`);
    expect(old.items.length).toBe(l.items.length);
    const runs = await get(alice, '/performance/fdb-check/runs');
    expect((runs.body as { items: unknown[] }).items).toHaveLength(2);
  });
});
