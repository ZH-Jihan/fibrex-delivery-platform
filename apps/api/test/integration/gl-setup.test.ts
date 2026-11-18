/**
 * Ledger set-up (phase 2 row 2.14) against real PostgreSQL and Redis: chart of accounts tree
 * rules, cost centres, tax codes with one default, exchange rates and the rate lookup,
 * fiscal years with monthly periods, close / lock / reopen in order with reason and
 * permissions, year status, delete and restore, the standard chart seed.
 *
 * People (all invented), tenant A, company A1: alice super_admin, carol "accountant" (every
 * gl key except unlock), dave "user" with no permissions. All rates are invented.
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
import { MemoryStorageAdapter } from '../../src/adapters/storage/memory.js';
import {
  BankVault,
  GL_PERMISSIONS,
  LedgerSetupService,
  STANDARD_CHART,
  createGlModule,
  seedLedger,
} from '../../src/modules/gl/index.js';
import { createFixture, type Fixture } from './fixtures.js';
import { connectionUrl } from './global-setup.js';
import { connect, testDatabase } from './helpers.js';
import { TEST_AUTH_ENV } from './test-env.js';

const PASSWORD = 'synthetic-pass-gl-1';

let owner: pg.Client;
let pool: Pool;
let redis: Redis;
let f: Fixture;
let app: Express;
let uow: UnitOfWork;
let slugA = '';
let alice = '';
let carol = '';
let dave = '';
const ids = {
  carol: randomUUID(),
  dave: randomUUID(),
  superAdmin: randomUUID(),
  accountant: randomUUID(),
  user: randomUUID(),
};

type Json = Record<string, unknown>;
interface Item {
  id: string;
  version: number;
  status?: string;
  isDefault?: boolean;
  code?: string;
}
const auth = (req: request.Test, token: string) => req.set('Authorization', `Bearer ${token}`);
const get = (path: string, token: string) => auth(request(app).get(`${API_PREFIX}${path}`), token);
const post = (path: string, token: string, body: Json = {}, version?: number) => {
  const req = auth(request(app).post(`${API_PREFIX}${path}`), token).set(
    'Idempotency-Key',
    randomUUID(),
  );
  if (version !== undefined) req.set('If-Match', `"${String(version)}"`);
  return req.send(body);
};
const patch = (path: string, token: string, version: number, body: Json) =>
  auth(request(app).patch(`${API_PREFIX}${path}`), token)
    .set('Idempotency-Key', randomUUID())
    .set('If-Match', `"${String(version)}"`)
    .send(body);
const del = (path: string, token: string, version: number) =>
  auth(request(app).delete(`${API_PREFIX}${path}`), token)
    .set('Idempotency-Key', randomUUID())
    .set('If-Match', `"${String(version)}"`)
    .send({ reason: 'test clean-up' });

async function signIn(identifier: string): Promise<string> {
  const res = await request(app)
    .post(`${API_PREFIX}/auth/login`)
    .send({ tenant: slugA, identifier, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.body as { accessToken: string }).accessToken;
}

async function addUser(id: string, username: string, roleId: string) {
  await owner.query(
    `INSERT INTO iam.user_account (id, tenant_id, username, display_name, must_change_password)
     VALUES ($1, $2, $3, $4, false)
     ON CONFLICT (id) DO UPDATE SET must_change_password = false`,
    [id, f.tenantA, username, `${username} test`],
  );
  await owner.query(
    `INSERT INTO iam.credential (tenant_id, user_id, kind, hash) VALUES ($1, $2, 'password', $3)`,
    [f.tenantA, id, await hashPassword(PASSWORD)],
  );
  const membershipId = randomUUID();
  await owner.query(
    `INSERT INTO iam.company_membership (id, tenant_id, user_id, company_id, is_default)
     VALUES ($1, $2, $3, $4, true)`,
    [membershipId, f.tenantA, id, f.companyA1],
  );
  await owner.query(
    `INSERT INTO iam.membership_role (tenant_id, membership_id, role_id) VALUES ($1, $2, $3)`,
    [f.tenantA, membershipId, roleId],
  );
}

beforeAll(async () => {
  owner = await connect('owner');
  f = await createFixture(owner);
  const db = testDatabase();
  pool = createPool(connectionUrl(db, db.app), 4);
  redis = createRedis(inject('redisUrl'), 'fibrex-test-gl');
  const prisma = createPrisma(pool);
  await syncPermissionCatalogue(prisma, [...KERNEL_PERMISSIONS, ...GL_PERMISSIONS]);
  const slug = await owner.query<{ slug: string }>(
    `SELECT slug FROM platform.tenant WHERE id = $1`,
    [f.tenantA],
  );
  slugA = slug.rows[0]?.slug ?? '';
  await owner.query(
    `INSERT INTO platform.currency (code, name) VALUES ('USD', 'US Dollar'), ('BDT', 'Taka')
     ON CONFLICT (code) DO NOTHING`,
  );
  await owner.query(
    `INSERT INTO iam.role (id, tenant_id, key, name, is_builtin) VALUES
       ($1, $4, 'super_admin', 'Super Admin', true), ($2, $4, 'accountant', 'Accountant', false),
       ($3, $4, 'user', 'User', true)`,
    [ids.superAdmin, ids.accountant, ids.user, f.tenantA],
  );
  await owner.query(
    `INSERT INTO iam.role_permission (tenant_id, role_id, permission_id)
     SELECT $1, $2, id FROM iam.permission`,
    [f.tenantA, ids.superAdmin],
  );
  await owner.query(
    `INSERT INTO iam.role_permission (tenant_id, role_id, permission_id)
     SELECT $1, $2, id FROM iam.permission WHERE key LIKE 'gl.%' AND key <> 'gl.fiscal_period.unlock'`,
    [f.tenantA, ids.accountant],
  );
  await addUser(f.userA, 'alice', ids.superAdmin);
  await addUser(ids.carol, 'carol', ids.accountant);
  await addUser(ids.dave, 'dave', ids.user);

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
  uow = new UnitOfWork(prisma);
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
  const recycleBin = new RecycleBin();
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
      const gl = createGlModule({
        uow,
        registry,
        permissions,
        storage: new MemoryStorageAdapter(),
        bankVault: new BankVault(new SecretBox(env.DATA_ENCRYPTION_KEY), env.DATA_ENCRYPTION_KEY),
      });
      for (const router of gl.routers ?? []) api.use(router);
      for (const type of gl.recycleTypes ?? []) recycleBin.register(type);
      api.use(
        createAuditRouter({
          uow,
          registry,
          authorize: permissions.authorize,
          audit: createAuditService(),
          recycleBin,
        }),
      );
    },
  });
  alice = await signIn('alice');
  carol = await signIn('carol');
  dave = await signIn('dave');
});

afterAll(async () => {
  const counters = await redis.keys('rl:*');
  if (counters.length > 0) await redis.del(...counters);
  await redis.quit();
  await pool.end();
  await owner.end();
});

async function account(code: string, body: Json = {}): Promise<Item> {
  const res = await post('/accounts', alice, {
    code,
    name: { en: `Account ${code}` },
    type: 'asset',
    ...body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as Item;
}

const fresh = async (path: string): Promise<Item> => (await get(path, alice)).body as Item;

describe('chart of accounts', () => {
  it('builds a tree of headers and postable accounts, ordered by code', async () => {
    const head = await account('A100', { isPostable: false });
    await account('A120', { parentId: head.id });
    await account('A110', { parentId: head.id, isControl: true, requiresDimensions: ['party'] });

    const list = await get('/accounts?parentId=' + head.id, alice);
    expect(list.status).toBe(200);
    expect((list.body as { items: Item[] }).items.map((i) => i.code)).toEqual(['A110', 'A120']);

    const tree = await get('/accounts/tree', alice);
    expect(tree.status).toBe(200);
    const root = (tree.body as { items: (Item & { children: Item[] })[] }).items.find(
      (n) => n.code === 'A100',
    );
    expect(root?.children.map((c) => c.code)).toEqual(['A110', 'A120']);
  });

  it('refuses a postable parent, a different type, cycles and a fixed code change', async () => {
    const leaf = await account('B110');
    const underLeaf = await post('/accounts', alice, {
      code: 'B111',
      name: { en: 'Under a leaf' },
      type: 'asset',
      parentId: leaf.id,
    });
    expect(underLeaf.status).toBe(422);
    expect((underLeaf.body as { code: string }).code).toBe('gl_parent_postable');

    const head = await account('B100', { isPostable: false });
    const wrongType = await post('/accounts', alice, {
      code: 'B120',
      name: { en: 'Expense under asset' },
      type: 'expense',
      parentId: head.id,
    });
    expect(wrongType.status).toBe(422);
    expect((wrongType.body as { code: string }).code).toBe('gl_parent_type');

    const sub = await account('B130', { isPostable: false, parentId: head.id });
    const cur = await fresh(`/accounts/${head.id}`);
    const cycle = await patch(`/accounts/${head.id}`, alice, cur.version, { parentId: sub.id });
    expect(cycle.status).toBe(400);

    const code = await patch(`/accounts/${leaf.id}`, alice, leaf.version, { code: 'Z9' });
    expect(code.status).toBe(400);

    // A header with children cannot take postings or change type.
    const postable = await patch(`/accounts/${head.id}`, alice, cur.version, { isPostable: true });
    expect(postable.status).toBe(422);
    const retype = await patch(`/accounts/${head.id}`, alice, cur.version, { type: 'expense' });
    expect(retype.status).toBe(422);

    // Unknown currency restriction.
    const money = await post('/accounts', alice, {
      code: 'B140',
      name: { en: 'Odd currency' },
      type: 'asset',
      currencyRestriction: 'XYZ',
    });
    expect(money.status).toBe(400);
  });

  it('deletes only childless accounts and restores only under a live parent', async () => {
    const head = await account('C100', { isPostable: false });
    const child = await account('C110', { parentId: head.id });
    const blocked = await del(`/accounts/${head.id}`, alice, head.version);
    expect(blocked.status).toBe(422);

    expect((await del(`/accounts/${child.id}`, alice, child.version)).status).toBe(204);
    const headNow = await fresh(`/accounts/${head.id}`);
    expect((await del(`/accounts/${head.id}`, alice, headNow.version)).status).toBe(204);

    const orphan = await post(`/recycle-bin/gl.account/${child.id}/restore`, alice);
    expect(orphan.status).toBe(422);
    expect((await post(`/recycle-bin/gl.account/${head.id}/restore`, alice)).status).toBe(200);
    expect((await post(`/recycle-bin/gl.account/${child.id}/restore`, alice)).status).toBe(200);

    // The same code can be used again only while the old one is deleted.
    const dup = await post('/accounts', alice, { code: 'C110', name: { en: 'x' }, type: 'asset' });
    expect(dup.status).toBe(409);
  });

  it('needs the gl.account permissions', async () => {
    expect((await get('/accounts', dave)).status).toBe(403);
    expect((await get('/accounts/tree', dave)).status).toBe(403);
    expect((await get('/accounts', carol)).status).toBe(200);
  });
});

describe('cost centres', () => {
  it('form a tree without cycles and keep parents with children', async () => {
    const top = await post('/cost-centres', alice, { code: 'OPS', name: 'Operations' });
    expect(top.status).toBe(201);
    const topItem = top.body as Item;
    const zone = await post('/cost-centres', alice, {
      code: 'OPS-NORTH',
      name: 'North zone',
      parentId: topItem.id,
    });
    expect(zone.status).toBe(201);
    const cycle = await patch(`/cost-centres/${topItem.id}`, alice, topItem.version, {
      parentId: (zone.body as Item).id,
    });
    expect(cycle.status).toBe(400);
    expect((await del(`/cost-centres/${topItem.id}`, alice, topItem.version)).status).toBe(422);
  });
});

describe('tax codes', () => {
  it('keeps exactly one default and needs an account for a rate above zero', async () => {
    const none = await post('/tax-codes', alice, { code: 'NONE', name: 'No tax', isDefault: true });
    expect(none.status).toBe(201);
    const noneItem = none.body as Item;
    expect(noneItem.isDefault).toBe(true);

    const noAccount = await post('/tax-codes', alice, { code: 'VAT5', name: 'VAT 5%', rate: '5' });
    expect(noAccount.status).toBe(400);

    const header = await account('T100', { type: 'liability', isPostable: false });
    const onHeader = await post('/tax-codes', alice, {
      code: 'VAT5',
      name: 'VAT 5%',
      rate: '5',
      accountId: header.id,
    });
    expect(onHeader.status).toBe(400);

    const taxAccount = await account('T110', { type: 'liability', parentId: header.id });
    const vat = await post('/tax-codes', alice, {
      code: 'VAT5',
      name: 'VAT 5%',
      rate: '5',
      accountId: taxAccount.id,
      isDefault: true,
    });
    expect(vat.status).toBe(201);
    expect((vat.body as { rate: string }).rate).toBe('5.0000');

    const list = (await get('/tax-codes', alice)).body as { items: Item[] };
    expect(list.items.filter((t) => t.isDefault).map((t) => t.code)).toEqual(['VAT5']);

    // The default can be neither un-defaulted nor deleted; the account is in use.
    const vatItem = vat.body as Item;
    expect(
      (await patch(`/tax-codes/${vatItem.id}`, alice, vatItem.version, { isDefault: false }))
        .status,
    ).toBe(422);
    expect((await del(`/tax-codes/${vatItem.id}`, alice, vatItem.version)).status).toBe(422);
    expect((await del(`/accounts/${taxAccount.id}`, alice, taxAccount.version)).status).toBe(422);

    // Moving the default back.
    const noneNow = await fresh(`/tax-codes/${noneItem.id}`);
    expect(noneNow.version).toBeGreaterThan(noneItem.version);
    const back = await patch(`/tax-codes/${noneItem.id}`, alice, noneNow.version, {
      isDefault: true,
    });
    expect(back.status).toBe(200);
    expect((await fresh(`/tax-codes/${vatItem.id}`)).isDefault).toBe(false);
  });
});

describe('exchange rates', () => {
  it('one rate per pair and day; the lookup takes the latest on or before the day', async () => {
    const add = (rateDate: string, rate: string, from = 'USD', to = 'QAR') =>
      post('/exchange-rates', alice, { fromCurrency: from, toCurrency: to, rateDate, rate });
    expect((await add('2026-03-01', '3.64')).status).toBe(201);
    const later = await add('2026-03-10', '3.65000000');
    expect(later.status).toBe(201);
    expect((later.body as { rate: string }).rate).toBe('3.65000000');
    expect((await add('2026-03-10', '3.66')).status).toBe(409);
    expect((await add('2026-03-10', '1', 'QAR', 'QAR')).status).toBe(400);
    expect((await add('2026-03-10', '1', 'XYZ', 'QAR')).status).toBe(400);
    expect((await add('2026-03-10', '0')).status).toBe(400);

    // The pair and day never change.
    const item = later.body as Item;
    expect(
      (await patch(`/exchange-rates/${item.id}`, alice, item.version, { rateDate: '2026-03-11' }))
        .status,
    ).toBe(400);

    const service = new LedgerSetupService();
    const ctx = { tenantId: f.tenantA, companyIds: [f.companyA1], userId: f.userA };
    const on = (day: string, from = 'USD', to = 'QAR') =>
      uow.runAs(ctx, () => service.rateOn(f.companyA1, from, to, new Date(`${day}T00:00:00Z`)));
    expect((await on('2026-03-05')).rate).toBe('3.64000000');
    expect((await on('2026-03-31')).rate).toBe('3.65000000');
    expect((await on('2026-03-31', 'QAR', 'QAR')).rate).toBe('1.00000000');
    await expect(on('2026-02-28')).rejects.toMatchObject({ code: 'gl_exchange_rate_missing' });
    // Never inverted.
    await expect(on('2026-03-31', 'QAR', 'USD')).rejects.toMatchObject({
      code: 'gl_exchange_rate_missing',
    });
  });
});

describe('fiscal years and periods', () => {
  interface Period extends Item {
    periodNo: number;
    startDate: string;
    endDate: string;
    reopenReason: string | null;
  }
  const periodsOf = async (yearId: string): Promise<Period[]> =>
    ((await get(`/fiscal-periods?fiscalYearId=${yearId}`, alice)).body as { items: Period[] })
      .items;
  const periodNo = async (yearId: string, no: number): Promise<Period> => {
    const found = (await periodsOf(yearId)).find((p) => p.periodNo === no);
    if (found === undefined) throw new Error(`no period ${String(no)}`);
    return found;
  };
  const moveP = (p: Period, kind: string, token = alice, body: Json = {}) =>
    post(`/fiscal-periods/${p.id}/${kind}`, token, body, p.version);

  it('creates a year with 12 monthly periods and refuses an overlapping one', async () => {
    const year = await post('/fiscal-years', alice, { name: 'FY 2030', startDate: '2030-01-01' });
    expect(year.status, JSON.stringify(year.body)).toBe(201);
    const yearItem = year.body as Item & { endDate: string };
    expect(yearItem.endDate).toBe('2030-12-31');
    const periods = await periodsOf(yearItem.id);
    expect(periods).toHaveLength(12);
    expect(periods[1]).toMatchObject({
      periodNo: 2,
      startDate: '2030-02-01',
      endDate: '2030-02-28',
    });

    const overlap = await post('/fiscal-years', alice, {
      name: 'FY 2030b',
      startDate: '2030-07-01',
    });
    expect(overlap.status).toBe(409);
    const tooLong = await post('/fiscal-years', alice, {
      name: 'Too long',
      startDate: '2040-01-01',
      endDate: '2042-01-01',
    });
    expect(tooLong.status).toBe(400);

    const renamed = await patch(`/fiscal-years/${yearItem.id}`, alice, yearItem.version, {
      name: 'Year 2030',
    });
    expect(renamed.status).toBe(200);
    const redate = await patch(
      `/fiscal-years/${yearItem.id}`,
      alice,
      (renamed.body as Item).version,
      {
        startDate: '2030-02-01',
      },
    );
    expect(redate.status).toBe(400);
  });

  it('closes and locks in date order, reopens from the latest back with a reason', async () => {
    const year = (await post('/fiscal-years', alice, { name: 'FY 2029', startDate: '2029-01-01' }))
      .body as Item;
    const jan = await periodNo(year.id, 1);
    const feb = await periodNo(year.id, 2);

    const early = await moveP(feb, 'close');
    expect(early.status).toBe(422);
    expect((early.body as { code: string }).code).toBe('gl_period_status');

    expect((await moveP(jan, 'close', carol)).status).toBe(200);
    const febClosed = await moveP(await periodNo(year.id, 2), 'close', carol);
    expect(febClosed.status).toBe(200);
    // Stale version: 409.
    expect((await moveP(feb, 'lock')).status).toBe(409);
    // February cannot lock before January.
    expect((await moveP(await periodNo(year.id, 2), 'lock')).status).toBe(422);
    expect((await moveP(await periodNo(year.id, 1), 'lock', carol)).status).toBe(200);

    // January cannot reopen while February is closed.
    expect(
      (await moveP(await periodNo(year.id, 1), 'reopen', alice, { reason: 'Correction' })).status,
    ).toBe(422);
    // A reason is required.
    expect((await moveP(await periodNo(year.id, 2), 'reopen', carol)).status).toBe(400);
    const febOpen = await moveP(await periodNo(year.id, 2), 'reopen', carol, {
      reason: 'Late supplier invoice',
    });
    expect(febOpen.status).toBe(200);
    expect((febOpen.body as Period).reopenReason).toBe('Late supplier invoice');

    // January is locked: carol (no unlock) is refused, alice may.
    const jan2 = await periodNo(year.id, 1);
    expect(jan2.status).toBe('locked');
    expect((await moveP(jan2, 'reopen', carol, { reason: 'Audit adjustment' })).status).toBe(403);
    expect((await moveP(jan2, 'reopen', alice, { reason: 'Audit adjustment' })).status).toBe(200);

    // dave has no fiscal permissions at all.
    expect((await moveP(await periodNo(year.id, 1), 'close', dave)).status).toBe(403);
    expect((await get('/fiscal-periods', dave)).status).toBe(403);
  });

  it('marks a year closed when no period is open, and finds the period of a day', async () => {
    const year = (
      await post('/fiscal-years', alice, {
        name: 'Short 2028',
        startDate: '2028-01-01',
        endDate: '2028-02-15',
      })
    ).body as Item;
    expect((await periodsOf(year.id)).map((p) => p.endDate)).toEqual(['2028-01-31', '2028-02-15']);
    await moveP(await periodNo(year.id, 1), 'close');
    await moveP(await periodNo(year.id, 2), 'close');
    expect((await fresh(`/fiscal-years/${year.id}`)).status).toBe('closed');
    await moveP(await periodNo(year.id, 2), 'reopen', alice, { reason: 'Reopen for test' });
    expect((await fresh(`/fiscal-years/${year.id}`)).status).toBe('open');
    // Leave every period open: later tests use earlier years, and periods reopen latest first.
    await moveP(await periodNo(year.id, 1), 'reopen', alice, { reason: 'Reopen for test' });

    const service = new LedgerSetupService();
    const ctx = { tenantId: f.tenantA, companyIds: [f.companyA1], userId: f.userA };
    const found = await uow.runAs(ctx, () =>
      service.periodFor(f.companyA1, new Date('2028-02-10T00:00:00Z')),
    );
    expect(found?.periodNo).toBe(2);
    const none = await uow.runAs(ctx, () =>
      service.periodFor(f.companyA1, new Date('2028-03-01T00:00:00Z')),
    );
    expect(none).toBeNull();
  });

  it('deletes a year only while all periods are open; periods come back with it', async () => {
    const year = (await post('/fiscal-years', alice, { name: 'FY 2027', startDate: '2027-01-01' }))
      .body as Item;
    const jan = await periodNo(year.id, 1);
    await moveP(jan, 'close');
    const now = await fresh(`/fiscal-years/${year.id}`);
    expect((await del(`/fiscal-years/${year.id}`, alice, now.version)).status).toBe(422);
    await moveP(await periodNo(year.id, 1), 'reopen', alice, { reason: 'Undo for delete' });

    const again = await fresh(`/fiscal-years/${year.id}`);
    expect((await del(`/fiscal-years/${year.id}`, alice, again.version)).status).toBe(204);
    expect(await periodsOf(year.id)).toHaveLength(0);
    // The days are free again while the year is deleted ...
    const other = await post('/fiscal-years', alice, {
      name: 'FY 2027 new',
      startDate: '2027-01-01',
    });
    expect(other.status).toBe(201);
    // ... so restoring the old one now overlaps.
    expect((await post(`/recycle-bin/gl.fiscal_year/${year.id}/restore`, alice)).status).toBe(409);
    const otherItem = other.body as Item;
    expect((await del(`/fiscal-years/${otherItem.id}`, alice, otherItem.version)).status).toBe(204);
    expect((await post(`/recycle-bin/gl.fiscal_year/${year.id}/restore`, alice)).status).toBe(200);
    expect(await periodsOf(year.id)).toHaveLength(12);
  });
});

describe('standard chart seed', () => {
  it('seeds company A2 once: chart, NONE default, this fiscal year', async () => {
    await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [f.tenantA]);
    const first = await seedLedger(owner, f.tenantA, f.companyA2, new Date('2026-06-15T00:00:00Z'));
    expect(first).toEqual({ accounts: STANDARD_CHART.length, taxCodes: 1, fiscalYears: 1 });
    const second = await seedLedger(
      owner,
      f.tenantA,
      f.companyA2,
      new Date('2026-06-15T00:00:00Z'),
    );
    expect(second).toEqual({ accounts: 0, taxCodes: 0, fiscalYears: 0 });

    const headers = await owner.query<{ code: string; is_postable: boolean }>(
      `SELECT code, is_postable FROM gl.account WHERE company_id = $1 AND code IN ('1000', '1110')
        ORDER BY code`,
      [f.companyA2],
    );
    expect(headers.rows).toEqual([
      { code: '1000', is_postable: false },
      { code: '1110', is_postable: true },
    ]);
    // Every child has its parent's type.
    const mismatched = await owner.query(
      `SELECT c.code FROM gl.account c JOIN gl.account p ON p.id = c.parent_id
        WHERE c.company_id = $1 AND c.type <> p.type`,
      [f.companyA2],
    );
    expect(mismatched.rowCount).toBe(0);
    const tax = await owner.query<{ code: string }>(
      `SELECT code FROM gl.tax_code WHERE company_id = $1 AND is_default`,
      [f.companyA2],
    );
    expect(tax.rows.map((r) => r.code)).toEqual(['NONE']);
    const year = await owner.query<{ name: string; periods: number }>(
      `SELECT y.name, count(p.*)::int AS periods FROM gl.fiscal_year y
         JOIN gl.fiscal_period p ON p.fiscal_year_id = y.id
        WHERE y.company_id = $1 GROUP BY y.name`,
      [f.companyA2],
    );
    expect(year.rows).toEqual([{ name: 'FY 2026', periods: 12 }]);

    // Company A1's users do not see A2's chart.
    const seen = (await get('/accounts?pageSize=200', alice)).body as { items: Item[] };
    expect(seen.items.some((a) => a.code === '1000')).toBe(false);
  });
});
