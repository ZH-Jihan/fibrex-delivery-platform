/**
 * Posting service (phase 2 row 2.15a) against real PostgreSQL and Redis: posting rules as
 * versioned data (checks, activate, retire, frozen), event postings (resolver, formula amount,
 * dimension mapping, zero lines dropped, idempotency), explicit postings and their checks,
 * the database backstops (balance at commit, open period, insert-only, no extra lines),
 * reversal, the journals API and the fiscal-year delete rule.
 *
 * People (all invented), tenant A, company A1 (seeded standard chart, fiscal year 2026):
 * alice super_admin, carol "accountant" (every gl key except unlock), dave with none.
 * Every amount is invented.
 */
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
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
import {
  GL_PERMISSIONS,
  PostingService,
  createGlModule,
  seedLedger,
  type PostingLineInput,
} from '../../src/modules/gl/index.js';
import { createFixture, type Fixture } from './fixtures.js';
import { connectionUrl } from './global-setup.js';
import { connect, testDatabase } from './helpers.js';
import { TEST_AUTH_ENV } from './test-env.js';

const PASSWORD = 'synthetic-pass-gl-2';

let owner: pg.Client;
let pool: Pool;
let redis: Redis;
let f: Fixture;
let app: Express;
let uow: UnitOfWork;
let ctx: DbContext;
let slugA = '';
let alice = '';
let carol = '';
let dave = '';
let worker = '';
const posting = new PostingService();
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
  versionNo?: number;
}
interface JournalBody {
  id: string;
  number: string;
  entryDate: string;
  reversalOfId: string | null;
  reversedById: string | null;
  lines: { accountId: string; debit: string; credit: string; partyId: string | null }[];
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
  redis = createRedis(inject('redisUrl'), 'fibrex-test-gl-posting');
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
  // Standard chart, NONE tax code and fiscal year 2026 (January to December) for A1 and A2.
  await seedLedger(owner, f.tenantA, f.companyA1, new Date('2026-06-15T00:00:00Z'));
  await seedLedger(owner, f.tenantA, f.companyA2, new Date('2026-06-15T00:00:00Z'));
  worker = randomUUID();
  await owner.query(
    `INSERT INTO party.party (id, tenant_id, company_id, kind, display_name)
     VALUES ($1, $2, $3, 'person', 'Synthetic Rider One')`,
    [worker, f.tenantA, f.companyA1],
  );
  ctx = { tenantId: f.tenantA, companyIds: [f.companyA1], userId: f.userA };
  await owner.query(
    `INSERT INTO platform.currency (code, name) VALUES ('USD', 'US Dollar'), ('BDT', 'Taka')
     ON CONFLICT (code) DO NOTHING`,
  );
  // USD -> QAR from March 2026 (row 2.15b tests).
  await owner.query(
    `INSERT INTO gl.exchange_rate (tenant_id, company_id, from_currency, to_currency, rate_date, rate)
     VALUES ($1, $2, 'USD', 'QAR', '2026-03-01', 3.64)`,
    [f.tenantA, f.companyA1],
  );

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
      const gl = createGlModule({ uow, registry, permissions, posting });
      for (const router of gl.routers ?? []) api.use(router);
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

/** Account id by code in company A1 (owner read). */
async function accountId(code: string, companyId = f.companyA1): Promise<string> {
  const r = await owner.query<{ id: string }>(
    `SELECT id FROM gl.account WHERE company_id = $1 AND code = $2 AND deleted_at IS NULL`,
    [companyId, code],
  );
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error(`no account ${code}`);
  return id;
}

/** The loan disbursement rule used by several tests (version 1, from 2026-01-01). */
const loanRule = {
  eventKey: 'test.loan.disbursed',
  name: 'Loan to a worker',
  inputSchema: {
    amount: { type: 'decimal' },
    fee: { type: 'decimal', default: '0' },
    borrower: { type: 'string', default: '' },
    method: { type: 'string' },
  },
  lines: [
    {
      side: 'debit',
      account: { kind: 'fixed', code: '1220' },
      amount: 'amount',
      dimensions: { party: 'borrower' },
    },
    {
      side: 'credit',
      account: { kind: 'map', input: 'method', map: { cash: '1110', bank: '1120' } },
      amount: 'amount - fee',
    },
    { side: 'credit', account: { kind: 'fixed', code: '4900' }, amount: 'fee', memo: 'Loan fee' },
  ],
  validFrom: '2026-01-01',
};

const twoLines = (amount: string, debit = '5100', credit = '1110'): PostingLineInput[] => [
  { accountCode: debit, debit: amount },
  { accountCode: credit, credit: amount },
];

const run = <T>(fn: () => Promise<T>) => uow.runAs(ctx, fn);

describe('posting rules', () => {
  let ruleV1: Item;

  it('checks a draft: accounts, header accounts, inputs and formulas', async () => {
    const bad = async (patchRule: Json, expected: string) => {
      const res = await post('/posting-rules', alice, { ...loanRule, ...patchRule });
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(JSON.stringify(res.body)).toContain(expected);
    };
    await bad(
      {
        lines: [
          loanRule.lines[0],
          { ...loanRule.lines[1], account: { kind: 'fixed', code: '9999' } },
        ],
      },
      'Account 9999 does not exist',
    );
    await bad(
      {
        lines: [
          loanRule.lines[0],
          { ...loanRule.lines[1], account: { kind: 'fixed', code: '1100' } },
        ],
      },
      'header account',
    );
    await bad(
      { inputSchema: { ...loanRule.inputSchema, method: { type: 'decimal' } } },
      'must be of type string',
    );
    await bad(
      { lines: [loanRule.lines[0], { ...loanRule.lines[1], amount: 'amount + bonus' }] },
      'lines.1.amount',
    );
    // One-sided rules never pass the shape check.
    const oneSided = await post('/posting-rules', alice, {
      ...loanRule,
      lines: [loanRule.lines[0], { ...loanRule.lines[0] }],
    });
    expect(oneSided.status).toBe(400);
  });

  it('creates a numbered draft and activates it; an active rule is frozen', async () => {
    const created = await post('/posting-rules', carol, loanRule);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    ruleV1 = created.body as Item;
    expect(ruleV1).toMatchObject({ versionNo: 1, status: 'draft' });

    expect(
      (await post(`/posting-rules/${ruleV1.id}/activate`, dave, {}, ruleV1.version)).status,
    ).toBe(403);
    const active = await post(`/posting-rules/${ruleV1.id}/activate`, carol, {}, ruleV1.version);
    expect(active.status, JSON.stringify(active.body)).toBe(200);
    ruleV1 = active.body as Item;
    expect(ruleV1.status).toBe('active');

    const edit = await patch(`/posting-rules/${ruleV1.id}`, carol, ruleV1.version, {
      name: 'Changed',
    });
    expect(edit.status).toBe(422);
    expect((await del(`/posting-rules/${ruleV1.id}`, carol, ruleV1.version)).status).toBe(422);
    // The database refuses it too, even for the owner role.
    await expect(
      owner.query(`UPDATE gl.posting_rule SET lines = '[]'::jsonb WHERE id = $1`, [ruleV1.id]),
    ).rejects.toThrow(/gl_posting_rule_frozen/);
  });

  it('posts an event: resolver, formula amounts, party dimension, zero line dropped', async () => {
    const posted = await run(() =>
      posting.postEvent({
        companyId: f.companyA1,
        eventKey: 'test.loan.disbursed',
        entryDate: '2026-03-10',
        inputs: { amount: '1500.50', borrower: worker, method: 'bank' },
        description: 'Loan L0001 paid out',
        source: { type: 'test.loan', id: randomUUID() },
      }),
    );
    expect(posted.replayed).toBe(false);
    expect(posted.journal.number).toBe('JV-2026-00001');
    expect(posted.journal.postingRuleId).toBe(ruleV1.id);
    // The fee line was zero and is left out.
    expect(posted.lines).toHaveLength(2);
    const [dr, cr] = posted.lines;
    expect(dr?.accountId).toBe(await accountId('1220'));
    expect(dr?.debit.toFixed(4)).toBe('1500.5000');
    expect(dr?.partyId).toBe(worker);
    expect(cr?.accountId).toBe(await accountId('1120'));
    expect(cr?.credit.toFixed(4)).toBe('1500.5000');
    expect(cr?.baseCredit.toFixed(4)).toBe('1500.5000');

    // With a fee: three lines, still balanced.
    const withFee = await run(() =>
      posting.postEvent({
        companyId: f.companyA1,
        eventKey: 'test.loan.disbursed',
        entryDate: '2026-03-11',
        inputs: { amount: '1000', fee: '25.25', borrower: worker, method: 'cash' },
        description: 'Loan L0002 paid out',
      }),
    );
    expect(withFee.lines.map((l) => [l.debit.toFixed(2), l.credit.toFixed(2)])).toEqual([
      ['1000.00', '0.00'],
      ['0.00', '974.75'],
      ['0.00', '25.25'],
    ]);
    expect(withFee.lines[2]?.memo).toBe('Loan fee');
  });

  it('refuses an event whose rule cannot be applied', async () => {
    const attempt = (inputs: Json, eventKey = 'test.loan.disbursed', entryDate = '2026-03-12') =>
      run(() =>
        posting.postEvent({
          companyId: f.companyA1,
          eventKey,
          entryDate,
          inputs,
          description: 'x',
        }),
      );
    // The control account 1220 needs a party on every line.
    await expect(attempt({ amount: '10', method: 'cash' })).rejects.toMatchObject({
      code: 'gl_dimension_required',
    });
    await expect(attempt({ amount: '10', borrower: worker, method: 'card' })).rejects.toMatchObject(
      {
        code: 'gl_rule_account',
      },
    );
    await expect(
      attempt({ amount: '10', fee: '20', borrower: worker, method: 'cash' }),
    ).rejects.toMatchObject({
      code: 'gl_rule_amount',
    });
    await expect(
      attempt({ amount: '10', borrower: 'not-an-id', method: 'cash' }),
    ).rejects.toMatchObject({
      code: 'gl_rule_dimension',
    });
    await expect(attempt({ amount: '10' }, 'test.unknown.event')).rejects.toMatchObject({
      code: 'gl_posting_rule_missing',
    });
    // Before version 1 starts.
    await expect(
      attempt(
        { amount: '10', borrower: worker, method: 'cash' },
        'test.loan.disbursed',
        '2025-12-31',
      ),
    ).rejects.toMatchObject({ code: 'gl_posting_rule_missing' });
  });

  it('a new version retires the old one the day before; back-dated events use the old one', async () => {
    const v2Body = {
      ...loanRule,
      validFrom: '2026-07-01',
      lines: [
        loanRule.lines[0],
        { ...loanRule.lines[1], account: { kind: 'fixed', code: '1130' } },
        loanRule.lines[2],
      ],
    };
    const early = (await post('/posting-rules', carol, { ...v2Body, validFrom: '2026-01-01' }))
      .body as Item;
    expect(early.versionNo).toBe(2);
    const refused = await post(`/posting-rules/${early.id}/activate`, carol, {}, early.version);
    expect(refused.status).toBe(422);
    expect((await del(`/posting-rules/${early.id}`, carol, early.version)).status).toBe(204);

    const v2Res = await post('/posting-rules', carol, v2Body);
    expect(v2Res.status, JSON.stringify(v2Res.body)).toBe(201);
    const v2 = v2Res.body as Item;
    expect(v2.versionNo).toBe(3);
    expect((await post(`/posting-rules/${v2.id}/activate`, carol, {}, v2.version)).status).toBe(
      200,
    );
    const old = (await get(`/posting-rules/${ruleV1.id}`, carol)).body as Item & {
      validTo: string;
    };
    expect(old).toMatchObject({ status: 'retired', validTo: '2026-06-30' });

    const inputs = { amount: '50', borrower: worker, method: 'bank' };
    const march = await run(() =>
      posting.postEvent({
        companyId: f.companyA1,
        eventKey: 'test.loan.disbursed',
        entryDate: '2026-03-20',
        inputs,
        description: 'March',
      }),
    );
    const august = await run(() =>
      posting.postEvent({
        companyId: f.companyA1,
        eventKey: 'test.loan.disbursed',
        entryDate: '2026-08-20',
        inputs,
        description: 'August',
      }),
    );
    expect(march.journal.postingRuleId).toBe(ruleV1.id);
    expect(march.lines[1]?.accountId).toBe(await accountId('1120'));
    expect(august.journal.postingRuleId).toBe(v2.id);
    expect(august.lines[1]?.accountId).toBe(await accountId('1130'));
  });

  it('returns the first journal when the idempotency key repeats', async () => {
    const key = `test-${randomUUID()}`;
    const event = {
      companyId: f.companyA1,
      eventKey: 'test.loan.disbursed',
      entryDate: '2026-04-01',
      inputs: { amount: '77', borrower: worker, method: 'cash' },
      description: 'Retried job',
      idempotencyKey: key,
    };
    const first = await run(() => posting.postEvent(event));
    const second = await run(() => posting.postEvent(event));
    expect(second.replayed).toBe(true);
    expect(second.journal.id).toBe(first.journal.id);
    const count = await owner.query(
      `SELECT count(*)::int AS n FROM gl.journal WHERE idempotency_key = $1`,
      [key],
    );
    expect(count.rows[0]).toEqual({ n: 1 });
  });
});

describe('explicit postings', () => {
  const postLines = (lines: PostingLineInput[], entryDate = '2026-05-05') =>
    run(() =>
      posting.post({
        companyId: f.companyA1,
        entryDate,
        eventKey: 'test.manual',
        description: 'Test',
        lines,
      }),
    );

  it('posts balanced lines with the default tax code', async () => {
    const posted = await postLines(twoLines('12.3400'));
    expect(posted.lines).toHaveLength(2);
    const none = await owner.query<{ id: string }>(
      `SELECT id FROM gl.tax_code WHERE company_id = $1 AND is_default`,
      [f.companyA1],
    );
    expect(posted.lines.every((l) => l.taxCodeId === none.rows[0]?.id)).toBe(true);
  });

  it('refuses what does not add up or cannot post', async () => {
    const refused = async (lines: PostingLineInput[], code: string, entryDate?: string) => {
      await expect(postLines(lines, entryDate)).rejects.toMatchObject({ code });
    };
    await refused(
      [
        { accountCode: '5100', debit: '10' },
        { accountCode: '1110', credit: '9.99' },
      ],
      'gl_journal_unbalanced',
    );
    await refused(twoLines('1.23456'), 'gl_amount_invalid');
    await refused(
      [
        { accountCode: '5100', debit: '-5' },
        { accountCode: '1110', credit: '-5' },
      ],
      'gl_amount_invalid',
    );
    await refused(
      [
        { accountCode: '5100', debit: '5', credit: '5' },
        { accountCode: '1110', credit: '5' },
      ],
      'gl_line_side',
    );
    await refused(twoLines('10', '1100'), 'gl_account_not_postable');
    await refused(twoLines('10', '9999'), 'gl_account_missing');
    // Foreign currency needs a rate of the day (no BDT rate is ever entered in this file).
    await refused(
      [
        { accountCode: '5100', debit: '10', currency: 'BDT' },
        { accountCode: '1110', credit: '10', currency: 'BDT' },
      ],
      'gl_exchange_rate_missing',
    );
    await refused(twoLines('10'), 'gl_period_missing', '2027-02-01');
    await refused([{ accountCode: '5100', debit: '10' }], 'gl_line_count');
    await refused(
      [
        { accountCode: '5100', debit: '10', taxCode: 'VAT99' },
        { accountCode: '1110', credit: '10' },
      ],
      'gl_tax_code_missing',
    );
  });

  it('refuses another company of the tenant that the session cannot use', async () => {
    await expect(
      run(() =>
        posting.post({
          companyId: f.companyA2,
          entryDate: '2026-05-05',
          eventKey: 'test.manual',
          description: 'x',
          lines: twoLines('1'),
        }),
      ),
    ).rejects.toMatchObject({ code: 'company_required' });
  });

  it('refuses a closed period, in the service and in the database', async () => {
    const periods = (await get('/fiscal-periods?status=open', alice)).body as {
      items: (Item & { startDate: string })[];
    };
    const january = periods.items.find((p) => p.startDate === '2026-01-01');
    if (january === undefined) throw new Error('no January period');
    expect(
      (await post(`/fiscal-periods/${january.id}/close`, alice, {}, january.version)).status,
    ).toBe(200);

    await expect(postLines(twoLines('10'), '2026-01-15')).rejects.toMatchObject({
      code: 'gl_period_not_open',
    });
    // Straight into the table as the app role: the insert trigger refuses it.
    await expect(
      run(async (): Promise<void> => {
        const { currentUnit } = await import('../../src/kernel/db/unit-of-work.js');
        await currentUnit().db.$executeRaw`
          INSERT INTO gl.journal (tenant_id, company_id, number, entry_date, fiscal_period_id,
                                  event_key, description, line_count)
          VALUES (${f.tenantA}::uuid, ${f.companyA1}::uuid, 'RAW-1', '2026-01-15', ${january.id}::uuid,
                  'test.raw', 'raw', 2)`;
      }),
    ).rejects.toThrow(/gl_period_not_open/);
  });
});

describe('database backstops', () => {
  /** Insert a journal and lines with raw SQL as the app role; returns the journal id. */
  const raw = (
    lines: { account: string; debit: string; credit: string; lineNo?: number }[],
    lineCount = 2,
  ) =>
    run(async () => {
      const { currentUnit } = await import('../../src/kernel/db/unit-of-work.js');
      const { db } = currentUnit();
      const period = await db.glFiscalPeriod.findFirst({
        where: { companyId: f.companyA1, startDate: new Date('2026-06-01T00:00:00Z') },
      });
      const id = randomUUID();
      await db.$executeRaw`
        INSERT INTO gl.journal (id, tenant_id, company_id, number, entry_date, fiscal_period_id,
                                event_key, description, line_count)
        VALUES (${id}::uuid, ${f.tenantA}::uuid, ${f.companyA1}::uuid, ${`RAW-${id.slice(0, 8)}`},
                '2026-06-10', ${period?.id}::uuid, 'test.raw', 'raw', ${lineCount})`;
      const tax = await db.glTaxCode.findFirst({
        where: { companyId: f.companyA1, isDefault: true },
      });
      for (const [i, l] of lines.entries()) {
        await db.$executeRaw`
          INSERT INTO gl.journal_line (tenant_id, company_id, journal_id, entry_date, line_no,
                                       account_id, debit, credit, currency, base_debit, base_credit, tax_code_id)
          VALUES (${f.tenantA}::uuid, ${f.companyA1}::uuid, ${id}::uuid, '2026-06-10', ${l.lineNo ?? i + 1},
                  ${await accountId(l.account)}::uuid, ${l.debit}::numeric, ${l.credit}::numeric, 'QAR',
                  ${l.debit}::numeric, ${l.credit}::numeric, ${tax?.id}::uuid)`;
      }
      return id;
    });

  it('a balanced raw journal commits; an unbalanced or incomplete one fails at commit', async () => {
    const ok = await raw([
      { account: '5100', debit: '5', credit: '0' },
      { account: '1110', debit: '0', credit: '5' },
    ]);
    expect(ok).toMatch(/^[0-9a-f-]{36}$/);
    await expect(
      raw([
        { account: '5100', debit: '5', credit: '0' },
        { account: '1110', debit: '0', credit: '4' },
      ]),
    ).rejects.toThrow(/gl_journal_unbalanced/);
    await expect(raw([{ account: '5100', debit: '5', credit: '0' }])).rejects.toThrow(
      /gl_journal_incomplete/,
    );
  });

  it('lines are one-sided, post to postable accounts, and cannot be added later', async () => {
    await expect(
      raw([
        { account: '5100', debit: '5', credit: '5' },
        { account: '1110', debit: '0', credit: '0' },
      ]),
    ).rejects.toThrow(/journal_line_one_sided_ck/);
    await expect(
      raw([
        { account: '1100', debit: '5', credit: '0' },
        { account: '1110', debit: '0', credit: '5' },
      ]),
    ).rejects.toThrow(/gl_account_not_postable/);
    await expect(
      raw([
        { account: '5100', debit: '5', credit: '0' },
        { account: '1110', debit: '0', credit: '5' },
        { account: '1110', debit: '0', credit: '0.0001', lineNo: 3 },
      ]),
    ).rejects.toThrow(/gl_line_count/);
  });

  it('journals and lines are insert-only, even for the owner role', async () => {
    await expect(owner.query(`UPDATE gl.journal SET description = 'changed'`)).rejects.toThrow(
      /append-only/,
    );
    await expect(owner.query(`DELETE FROM gl.journal_line`)).rejects.toThrow(/append-only/);
  });

  it('another company cannot see the journals', async () => {
    const seen = await uow.runAs({ tenantId: f.tenantA, companyIds: [f.companyA2] }, async () => {
      const { currentUnit } = await import('../../src/kernel/db/unit-of-work.js');
      return currentUnit().db.glJournal.count({ where: { companyId: f.companyA1 } });
    });
    expect(seen).toBe(0);
  });
});

describe('reversal and the journals API', () => {
  let original: JournalBody;

  it('lists and shows journals', async () => {
    const posted = await run(() =>
      posting.post({
        companyId: f.companyA1,
        entryDate: '2026-09-01',
        eventKey: 'test.manual',
        description: 'Rent paid',
        lines: [
          { accountCode: '1220', debit: '300', dimensions: { party: worker } },
          { accountCode: '1120', credit: '300' },
        ],
      }),
    );
    const detail = await get(`/journals/${posted.journal.id}`, carol);
    expect(detail.status).toBe(200);
    original = detail.body as JournalBody;
    expect(original.lines.map((l) => [l.debit, l.credit])).toEqual([
      ['300.0000', '0.0000'],
      ['0.0000', '300.0000'],
    ]);
    expect(original.reversedById).toBeNull();

    const list = await get(
      `/journals?from=2026-09-01&to=2026-09-30&accountId=${await accountId('1220')}`,
      carol,
    );
    expect(list.status).toBe(200);
    expect((list.body as { items: { id: string }[] }).items.map((j) => j.id)).toEqual([
      original.id,
    ]);
    expect((await get('/journals', dave)).status).toBe(403);
  });

  it('reverses once, with sides swapped, never before the original and never a reversal', async () => {
    expect((await post(`/journals/${original.id}/reverse`, dave, { reason: 'wrong' })).status).toBe(
      403,
    );
    expect((await post(`/journals/${original.id}/reverse`, carol, {})).status).toBe(400);
    const tooEarly = await post(`/journals/${original.id}/reverse`, carol, {
      reason: 'wrong',
      entryDate: '2026-08-31',
    });
    expect(tooEarly.status).toBe(422);

    const reversed = await post(`/journals/${original.id}/reverse`, carol, {
      reason: 'Posted to the wrong worker',
      entryDate: '2026-09-02',
    });
    expect(reversed.status, JSON.stringify(reversed.body)).toBe(201);
    const reversal = reversed.body as JournalBody;
    expect(reversal.reversalOfId).toBe(original.id);
    expect(reversal.lines.map((l) => [l.debit, l.credit, l.partyId])).toEqual([
      ['0.0000', '300.0000', worker],
      ['300.0000', '0.0000', null],
    ]);

    const again = await post(`/journals/${original.id}/reverse`, carol, { reason: 'again' });
    expect(again.status).toBe(409);
    const ofReversal = await post(`/journals/${reversal.id}/reverse`, carol, { reason: 'undo' });
    expect(ofReversal.status).toBe(422);
    expect(((await get(`/journals/${original.id}`, carol)).body as JournalBody).reversedById).toBe(
      reversal.id,
    );
  });
});

describe('fiscal years with postings', () => {
  it('a year with journals cannot be deleted', async () => {
    // January is closed above; reopen it so the only obstacle left is the journals.
    const periods = (await get('/fiscal-periods?status=closed', alice)).body as { items: Item[] };
    for (const p of periods.items) {
      expect(
        (await post(`/fiscal-periods/${p.id}/reopen`, alice, { reason: 'test reopen' }, p.version))
          .status,
      ).toBe(200);
    }
    const years = (await get('/fiscal-years', alice)).body as {
      items: (Item & { name: string })[];
    };
    const year = years.items[0];
    if (year === undefined) throw new Error('no year');
    const res = await del(`/fiscal-years/${year.id}`, alice, year.version);
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain('Journals are posted');
  });
});

describe('foreign currency (row 2.15b)', () => {
  const postLines = (lines: PostingLineInput[], entryDate = '2026-05-05') =>
    run(() =>
      posting.post({
        companyId: f.companyA1,
        entryDate,
        eventKey: 'test.fx',
        description: 'FX test',
        lines,
      }),
    );
  const shape = (lines: Awaited<ReturnType<typeof postLines>>['lines']) =>
    lines.map((l) => [
      l.currency,
      l.fxRate.toFixed(8),
      l.debit.toFixed(4),
      l.credit.toFixed(4),
      l.baseDebit.toFixed(4),
      l.baseCredit.toFixed(4),
    ]);

  it('takes the rate of the day and stores base amounts', async () => {
    const posted = await postLines([
      { accountCode: '5100', debit: '100', currency: 'USD' },
      { accountCode: '1110', credit: '364' },
    ]);
    expect(shape(posted.lines)).toEqual([
      ['USD', '3.64000000', '100.0000', '0.0000', '364.0000', '0.0000'],
      ['QAR', '1.00000000', '0.0000', '364.0000', '0.0000', '364.0000'],
    ]);
    // A rate named on the line wins over the rate of the day.
    const named = await postLines([
      { accountCode: '5100', debit: '10', currency: 'USD', fxRate: '3.7' },
      { accountCode: '1110', credit: '37' },
    ]);
    expect(named.lines[0]?.fxRate.toFixed(8)).toBe('3.70000000');
  });

  it('moves a rounding difference onto one line, and the reversal mirrors it', async () => {
    // 10.0001 x 3.64 = 36.400364 -> 36.4004 (twice: 72.8008); 20.0002 x 3.64 = 72.800728 -> 72.8007.
    const posted = await postLines([
      { accountCode: '5100', debit: '10.0001', currency: 'USD' },
      { accountCode: '5100', debit: '10.0001', currency: 'USD' },
      { accountCode: '1110', credit: '20.0002', currency: 'USD' },
    ]);
    expect(shape(posted.lines).map((l) => [l[4], l[5]])).toEqual([
      ['36.4004', '0.0000'],
      ['36.4004', '0.0000'],
      ['0.0000', '72.8008'],
    ]);
    const reversal = await run(() =>
      posting.reverse(posted.journal.id, { reason: 'test', entryDate: '2026-05-06' }),
    );
    expect(shape(reversal.lines).map((l) => [l[1], l[4], l[5]])).toEqual([
      ['3.64000000', '0.0000', '36.4004'],
      ['3.64000000', '0.0000', '36.4004'],
      ['3.64000000', '72.8008', '0.0000'],
    ]);
  });

  it('refuses unknown currencies, missing rates, bad rates and real base differences', async () => {
    const refused = async (lines: PostingLineInput[], code: string, entryDate?: string) => {
      await expect(postLines(lines, entryDate)).rejects.toMatchObject({ code });
    };
    await refused(
      [
        { accountCode: '5100', debit: '1', currency: 'ZZZ' },
        { accountCode: '1110', credit: '1', currency: 'ZZZ' },
      ],
      'gl_currency_unknown',
    );
    // Before the first USD rate.
    await refused(
      [
        { accountCode: '5100', debit: '1', currency: 'USD' },
        { accountCode: '1110', credit: '1', currency: 'USD' },
      ],
      'gl_exchange_rate_missing',
      '2026-02-15',
    );
    await refused(
      [
        { accountCode: '5100', debit: '1', fxRate: '2' },
        { accountCode: '1110', credit: '1' },
      ],
      'gl_fx_rate_invalid',
    );
    await refused(
      [
        { accountCode: '5100', debit: '1', currency: 'USD', fxRate: '0' },
        { accountCode: '1110', credit: '1', currency: 'USD' },
      ],
      'gl_fx_rate_invalid',
    );
    // Same USD amount at two rates: a real exchange difference, never absorbed as rounding.
    await refused(
      [
        { accountCode: '5100', debit: '100', currency: 'USD', fxRate: '3.64' },
        { accountCode: '1110', credit: '100', currency: 'USD', fxRate: '3.65' },
      ],
      'gl_journal_unbalanced',
    );
  });
});

describe('simulate (row 2.15b)', () => {
  const fxRule = {
    eventKey: 'test.fx.fee',
    name: 'Fee in a currency',
    inputSchema: { amount: { type: 'decimal' }, currency: { type: 'string', default: 'QAR' } },
    lines: [
      { side: 'debit', account: { kind: 'fixed', code: '5100' }, amount: 'amount' },
      { side: 'credit', account: { kind: 'fixed', code: '1110' }, amount: 'amount' },
    ],
    validFrom: '2026-01-01',
  };
  const journalCount = async () =>
    Number(
      (
        await owner.query<{ n: string }>(
          `SELECT count(*) AS n FROM gl.journal WHERE company_id = $1`,
          [f.companyA1],
        )
      ).rows[0]?.n,
    );

  it('shows what the rule in force would post, or a draft, and writes nothing', async () => {
    const created = (await post('/posting-rules', carol, fxRule)).body as Item;
    const before = await journalCount();

    // A draft is not in force, but can be tried by id.
    const none = await post('/posting-rules/test.fx.fee/simulate', carol, {
      entryDate: '2026-05-05',
      inputs: { amount: '12.5' },
    });
    expect(none.status).toBe(422);
    expect((none.body as { code: string }).code).toBe('gl_posting_rule_missing');
    const draft = await post('/posting-rules/test.fx.fee/simulate', carol, {
      entryDate: '2026-05-05',
      inputs: { amount: '12.5' },
      ruleId: created.id,
    });
    expect(draft.status, JSON.stringify(draft.body)).toBe(200);

    const active = await post(`/posting-rules/${created.id}/activate`, carol, {}, created.version);
    expect(active.status).toBe(200);
    const res = await post('/posting-rules/test.fx.fee/simulate', carol, {
      entryDate: '2026-05-05',
      inputs: { amount: '12.5' },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as {
      rule: { versionNo: number; status: string };
      baseCurrency: string;
      lines: { accountCode: string; debit: string; credit: string; baseDebit: string }[];
      totals: { debit: string; balanced: boolean };
      postable: boolean;
    };
    expect(body.rule).toMatchObject({ versionNo: 1, status: 'active' });
    expect(body.baseCurrency).toBe('QAR');
    expect(body.lines.map((l) => [l.accountCode, l.debit, l.credit])).toEqual([
      ['5100', '12.5000', '0.0000'],
      ['1110', '0.0000', '12.5000'],
    ]);
    expect(body.totals).toMatchObject({ debit: '12.5000', balanced: true });
    expect(body.postable).toBe(true);
    expect(await journalCount()).toBe(before);
  });

  it('reports refusals as a posting would, and needs read permission', async () => {
    const bad = await post('/posting-rules/test.fx.fee/simulate', carol, {
      entryDate: '2026-05-05',
      inputs: { amount: '1.23456' },
    });
    expect(bad.status).toBe(422);
    expect((bad.body as { code: string }).code).toBe('gl_amount_invalid');
    expect(
      (
        await post('/posting-rules/test.fx.fee/simulate', dave, {
          inputs: { amount: '1' },
        })
      ).status,
    ).toBe(403);
    expect((await post('/posting-rules/Not-A-Key/simulate', carol, {})).status).toBe(400);
  });
});

describe('manual journals (row 2.15b)', () => {
  interface Mj extends Item {
    number: string;
    journalId: string | null;
    journal?: JournalBody;
  }
  const draftBody = {
    entryDate: '2026-06-10',
    description: 'Office supplies paid in cash',
    lines: [
      { accountCode: '5100', debit: '40' },
      { accountCode: '1110', credit: '39' },
    ],
  };

  it('keeps an unbalanced draft, refuses to post it, then posts it once and freezes it', async () => {
    expect((await post('/manual-journals', dave, draftBody)).status).toBe(403);
    const bad = await post('/manual-journals', carol, {
      ...draftBody,
      lines: [{ accountCode: '5100', debit: '1', credit: '1' }],
    });
    expect(bad.status).toBe(400);

    const created = await post('/manual-journals', carol, draftBody);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    let mj = created.body as Mj;
    expect(mj.number).toMatch(/^MJ-2026-\d{5}$/);
    expect(mj.status).toBe('draft');

    const unbalanced = await post(`/manual-journals/${mj.id}/post`, carol, {}, mj.version);
    expect(unbalanced.status).toBe(422);
    expect((unbalanced.body as { code: string }).code).toBe('gl_journal_unbalanced');

    const fixed = await patch(`/manual-journals/${mj.id}`, carol, mj.version, {
      lines: [
        { accountCode: '5100', debit: '40' },
        { accountCode: '1110', credit: '40' },
      ],
    });
    expect(fixed.status).toBe(200);
    mj = fixed.body as Mj;

    expect((await post(`/manual-journals/${mj.id}/post`, carol, {}, mj.version + 5)).status).toBe(
      409,
    );
    const posted = await post(`/manual-journals/${mj.id}/post`, carol, {}, mj.version);
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    const done = posted.body as Mj;
    expect(done.status).toBe('posted');
    expect(done.journalId).toBe(done.journal?.id);
    expect(done.journal?.lines.map((l) => [l.debit, l.credit])).toEqual([
      ['40.0000', '0.0000'],
      ['0.0000', '40.0000'],
    ]);
    const journal = (await get(`/journals/${done.journalId ?? ''}`, carol)).body as JournalBody & {
      eventKey: string;
      sourceId: string;
    };
    expect(journal).toMatchObject({ eventKey: 'gl.manual_journal', sourceId: mj.id });

    // Frozen: no second posting, no edit, no delete; the database refuses too.
    expect((await post(`/manual-journals/${mj.id}/post`, carol, {}, done.version)).status).toBe(
      422,
    );
    expect(
      (await patch(`/manual-journals/${mj.id}`, carol, done.version, { description: 'x' })).status,
    ).toBe(422);
    expect((await del(`/manual-journals/${mj.id}`, carol, done.version)).status).toBe(422);
    await expect(
      owner.query(`UPDATE gl.manual_journal SET description = 'x' WHERE id = $1`, [mj.id]),
    ).rejects.toThrow(/gl_manual_journal_posted/);
  });

  it('posts foreign lines and lists by status; a deleted draft keeps its number', async () => {
    const usd = (
      await post('/manual-journals', carol, {
        ...draftBody,
        lines: [
          { accountCode: '5100', debit: '10', currency: 'USD' },
          { accountCode: '1110', credit: '36.4' },
        ],
      })
    ).body as Mj;
    const posted = await post(`/manual-journals/${usd.id}/post`, carol, {}, usd.version);
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);

    const gone = (await post('/manual-journals', carol, draftBody)).body as Mj;
    expect((await del(`/manual-journals/${gone.id}`, carol, gone.version)).status).toBe(204);
    const next = (await post('/manual-journals', carol, draftBody)).body as Mj;
    expect(next.number).not.toBe(gone.number);

    const drafts = (await get('/manual-journals?status=draft', carol)).body as { items: Mj[] };
    expect(drafts.items.map((i) => i.id)).toContain(next.id);
    expect(drafts.items.every((i) => i.status === 'draft')).toBe(true);
  });
});
