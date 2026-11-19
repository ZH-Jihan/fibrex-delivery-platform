/**
 * Ledger reads (phase 2 row 2.16b) against real PostgreSQL and Redis: `GET /ledger/balances`
 * (account, party, dimensions, as-of date, bad dimension refused, permission, other company
 * invisible) and the reports `ledger.trial_balance`, `ledger.general_ledger` and
 * `ledger.party_statement` on the report engine (balance totals, running balance across
 * pages and with an opening balance, required filters).
 *
 * People (invented): alice super_admin, dave with no permissions. Tenant A, company A1
 * (seeded standard chart, fiscal year 2026), company A2 has a posting that must never show.
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
import { UnitOfWork, type DbContext } from '../../src/kernel/db/unit-of-work.js';
import { createLogger } from '../../src/kernel/observability/logger.js';
import {
  KERNEL_PERMISSIONS,
  syncPermissionCatalogue,
} from '../../src/kernel/permissions/catalogue.js';
import { PermissionService } from '../../src/kernel/permissions/permission-service.js';
import { createRedis } from '../../src/kernel/redis/client.js';
import { createReportRouter } from '../../src/kernel/reports/report-router.js';
import { ReportService } from '../../src/kernel/reports/report-service.js';
import {
  BankVault,
  GL_PERMISSIONS,
  PostingService,
  createGlModule,
  seedLedger,
  type PostingLineInput,
} from '../../src/modules/gl/index.js';
import { GL_REPORTS } from '../../src/modules/gl/ledger-reports.js';
import { createFixture, type Fixture } from './fixtures.js';
import { connectionUrl } from './global-setup.js';
import { connect, testDatabase } from './helpers.js';
import { TEST_AUTH_ENV } from './test-env.js';

const PASSWORD = 'synthetic-pass-gl-3';

let owner: pg.Client;
let pool: Pool;
let redis: Redis;
let f: Fixture;
let app: Express;
let uow: UnitOfWork;
let ctx: DbContext;
let slugA = '';
let alice = '';
let dave = '';
let riderOne = '';
let riderTwo = '';
const posting = new PostingService();
const ids = { dave: randomUUID(), superAdmin: randomUUID(), user: randomUUID() };

type Json = Record<string, unknown>;
interface Balances {
  asOf: string | null;
  items: { accountCode: string; baseDebit: string; baseCredit: string; balance: string }[];
  totals: { baseDebit: string; baseCredit: string; balance: string };
}
interface RunBody {
  rows: Record<string, string>[];
  total: number;
}
const auth = (req: request.Test, token: string) => req.set('Authorization', `Bearer ${token}`);
const get = (path: string, token: string) => auth(request(app).get(`${API_PREFIX}${path}`), token);
const runReport = (key: string, token: string, body: Json) =>
  auth(request(app).post(`${API_PREFIX}/reports/${key}/run`), token)
    .set('Idempotency-Key', randomUUID())
    .send(body);

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

async function party(name: string): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO party.party (id, tenant_id, company_id, kind, display_name)
     VALUES ($1, $2, $3, 'person', $4)`,
    [id, f.tenantA, f.companyA1, name],
  );
  return id;
}

beforeAll(async () => {
  owner = await connect('owner');
  f = await createFixture(owner);
  const db = testDatabase();
  pool = createPool(connectionUrl(db, db.app), 4);
  redis = createRedis(inject('redisUrl'), 'fibrex-test-gl-ledger-reports');
  const prisma = createPrisma(pool);
  await syncPermissionCatalogue(prisma, [...KERNEL_PERMISSIONS, ...GL_PERMISSIONS]);
  slugA =
    (
      await owner.query<{ slug: string }>(`SELECT slug FROM platform.tenant WHERE id = $1`, [
        f.tenantA,
      ])
    ).rows[0]?.slug ?? '';
  await owner.query(
    `INSERT INTO iam.role (id, tenant_id, key, name, is_builtin) VALUES
       ($1, $3, 'super_admin', 'Super Admin', true), ($2, $3, 'user', 'User', true)`,
    [ids.superAdmin, ids.user, f.tenantA],
  );
  await owner.query(
    `INSERT INTO iam.role_permission (tenant_id, role_id, permission_id)
     SELECT $1, $2, id FROM iam.permission`,
    [f.tenantA, ids.superAdmin],
  );
  await addUser(f.userA, 'alice', ids.superAdmin);
  await addUser(ids.dave, 'dave', ids.user);
  await seedLedger(owner, f.tenantA, f.companyA1, new Date('2026-06-15T00:00:00Z'));
  await seedLedger(owner, f.tenantA, f.companyA2, new Date('2026-06-15T00:00:00Z'));
  riderOne = await party('Synthetic Rider One');
  riderTwo = await party('Synthetic Rider Two');
  ctx = { tenantId: f.tenantA, companyIds: [f.companyA1], userId: f.userA };

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
  const reports = new ReportService({
    permissions,
    storage: new MemoryStorageAdapter(),
    renderer: new StubPdfRenderer(),
    definitions: () => GL_REPORTS,
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
      const gl = createGlModule({
        uow,
        registry,
        permissions,
        posting,
        storage: new MemoryStorageAdapter(),
        bankVault: new BankVault(new SecretBox(env.DATA_ENCRYPTION_KEY), env.DATA_ENCRYPTION_KEY),
      });
      for (const router of gl.routers ?? []) api.use(router);
      api.use(createReportRouter({ uow, registry, permissions, reports }));
    },
  });
  alice = await signIn('alice');
  dave = await signIn('dave');

  const lines = (amount: string, who: string): PostingLineInput[] => [
    { accountCode: '1220', debit: amount, dimensions: { party: who } },
    { accountCode: '1110', credit: amount },
  ];
  const postOn = (entryDate: string, amount: string, who: string, companyId = f.companyA1) =>
    uow.runAs({ ...ctx, companyIds: [companyId] }, () =>
      posting.post({
        companyId,
        entryDate,
        eventKey: 'test.manual',
        description: `Loan ${amount}`,
        lines: lines(amount, who),
      }),
    );
  // Rider one: 100 on 2026-02-10, 50 on 2026-03-10 and 25 on 2026-04-10. Rider two: 10 on 2026-03-15.
  await postOn('2026-02-10', '100.0000', riderOne);
  await postOn('2026-03-10', '50.0000', riderOne);
  await postOn('2026-04-10', '25.0000', riderOne);
  await postOn('2026-03-15', '10.0000', riderTwo);
  // Another company's posting (999) must never appear for company A1 users.
  await postOn('2026-03-20', '999.0000', riderOne, f.companyA2);
});

afterAll(async () => {
  const counters = await redis.keys('rl:*');
  if (counters.length > 0) await redis.del(...counters);
  await redis.quit();
  await pool.end();
  await owner.end();
});

const row = (b: Balances, code: string) => b.items.find((i) => i.accountCode === code);

describe('GET /ledger/balances', () => {
  it('sums posted lines per account and keeps debits equal to credits', async () => {
    const res = await get('/ledger/balances', alice);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as Balances;
    expect(row(body, '1220')?.balance).toBe('185.0000');
    expect(row(body, '1110')?.balance).toBe('-185.0000');
    expect(body.totals.balance).toBe('0.0000');
    expect(body.totals.baseDebit).toBe(body.totals.baseCredit);
    expect(JSON.stringify(body)).not.toContain('999');
  });

  it('filters by date, party, account and dimension', async () => {
    const asOf = (await get('/ledger/balances?asOf=2026-03-12', alice)).body as Balances;
    expect(row(asOf, '1220')?.balance).toBe('150.0000');

    const byParty = (await get(`/ledger/balances?party=${riderTwo}`, alice)).body as Balances;
    expect(byParty.items).toHaveLength(1);
    expect(row(byParty, '1220')?.balance).toBe('10.0000');

    const byDim = (await get(`/ledger/balances?dims=party:${riderOne}`, alice)).body as Balances;
    expect(row(byDim, '1220')?.balance).toBe('175.0000');

    const accountId = (
      await owner.query<{ id: string }>(
        `SELECT id FROM gl.account WHERE company_id = $1 AND code = '1110' AND deleted_at IS NULL`,
        [f.companyA1],
      )
    ).rows[0]?.id;
    const byAccount = (await get(`/ledger/balances?account=${accountId ?? ''}`, alice))
      .body as Balances;
    expect(byAccount.items.map((i) => i.accountCode)).toEqual(['1110']);
  });

  it('refuses an unknown dimension and a missing permission', async () => {
    const bad = await get('/ledger/balances?dims=colour:nope', alice);
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain('bad_dimension');
    expect((await get('/ledger/balances', dave)).status).toBe(403);
  });
});

describe('ledger.trial_balance', () => {
  it('lists accounts with postings, in code order, as of a date', async () => {
    const res = await runReport('ledger.trial_balance', alice, { filters: { asOf: '2026-03-12' } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as RunBody;
    expect(body.rows.map((r) => r.accountCode)).toEqual(['1110', '1220']);
    expect(body.rows[1]).toMatchObject({ baseDebit: '150.0000', balance: '150.0000' });
    const desc = await runReport('ledger.trial_balance', alice, {
      sort: { key: 'balance', direction: 'desc' },
    });
    expect((desc.body as RunBody).rows[0]?.accountCode).toBe('1220');
  });

  it('needs the permission', async () => {
    expect((await runReport('ledger.trial_balance', dave, {})).status).toBe(403);
  });
});

describe('ledger.general_ledger and ledger.party_statement', () => {
  let cashId = '';
  beforeAll(async () => {
    cashId =
      (
        await owner.query<{ id: string }>(
          `SELECT id FROM gl.account WHERE company_id = $1 AND code = '1220' AND deleted_at IS NULL`,
          [f.companyA1],
        )
      ).rows[0]?.id ?? '';
  });

  it('shows a running balance in date order and across pages', async () => {
    const all = await runReport('ledger.general_ledger', alice, { filters: { accountId: cashId } });
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    const rows = (all.body as RunBody).rows;
    expect(rows.map((r) => r.runningBalance)).toEqual([
      '100.0000',
      '150.0000',
      '160.0000',
      '185.0000',
    ]);
    const second = await runReport('ledger.general_ledger', alice, {
      filters: { accountId: cashId },
      page: 2,
      pageSize: 2,
    });
    expect((second.body as RunBody).rows.map((r) => r.runningBalance)).toEqual([
      '160.0000',
      '185.0000',
    ]);
  });

  it('starts from the opening balance when a from date is given', async () => {
    const res = await runReport('ledger.general_ledger', alice, {
      filters: { accountId: cashId, from: '2026-03-01' },
    });
    const body = res.body as RunBody;
    expect(body.total).toBe(3);
    expect(body.rows[0]?.runningBalance).toBe('150.0000');
  });

  it('gives one party its own statement', async () => {
    const res = await runReport('ledger.party_statement', alice, {
      filters: { partyId: riderOne, to: '2026-03-31' },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as RunBody;
    expect(body.total).toBe(2);
    expect(body.rows.map((r) => r.runningBalance)).toEqual(['100.0000', '150.0000']);
  });

  it('asks for the account or party it needs', async () => {
    expect((await runReport('ledger.general_ledger', alice, {})).status).toBe(400);
    expect((await runReport('ledger.party_statement', alice, {})).status).toBe(400);
  });
});

describe('trial balance: multi-currency property', () => {
  it('base-currency debits equal credits across QAR, USD and BDT postings', async () => {
    // Insert USD and BDT currencies and their rates to QAR (3.64 and 0.034).
    await owner.query(
      `INSERT INTO platform.currency (code, name, minor_units) VALUES
         ('USD', 'US Dollar', 2), ('BDT', 'Bangladeshi Taka', 2)
       ON CONFLICT (code) DO NOTHING`,
    );
    await owner.query(
      `INSERT INTO gl.exchange_rate (tenant_id, company_id, from_currency, to_currency, rate_date, rate)
       VALUES ($1, $2, 'USD', 'QAR', '2026-07-01', 3.64),
              ($1, $2, 'BDT', 'QAR', '2026-07-01', 0.034)
       ON CONFLICT DO NOTHING`,
      [f.tenantA, f.companyA1],
    );

    // Post a balanced USD journal and a balanced BDT journal (1220 needs a party dimension).
    await uow.runAs(ctx, () =>
      posting.post({
        companyId: f.companyA1,
        entryDate: '2026-07-02',
        eventKey: 'test.fx_usd',
        description: 'USD balanced entry',
        lines: [
          {
            accountCode: '1220',
            debit: '100.0000',
            currency: 'USD',
            dimensions: { party: riderOne },
          },
          { accountCode: '1110', credit: '100.0000', currency: 'USD' },
        ],
      }),
    );
    await uow.runAs(ctx, () =>
      posting.post({
        companyId: f.companyA1,
        entryDate: '2026-07-02',
        eventKey: 'test.fx_bdt',
        description: 'BDT balanced entry',
        lines: [
          {
            accountCode: '1220',
            debit: '1000.0000',
            currency: 'BDT',
            dimensions: { party: riderOne },
          },
          { accountCode: '1110', credit: '1000.0000', currency: 'BDT' },
        ],
      }),
    );

    // The trial balance must remain balanced in base currency after FX conversion.
    const res = await get('/ledger/balances', alice);
    expect(res.status).toBe(200);
    const body = res.body as Balances;
    expect(body.totals.baseDebit).toBe(body.totals.baseCredit);
    expect(body.totals.balance).toBe('0.0000');
  });
});
