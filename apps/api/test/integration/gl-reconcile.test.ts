/**
 * Bank reconciliation (phase 2 row 2.17b) against real PostgreSQL and Redis: match rules,
 * conservative automatic matching (unique candidate only, rivals left alone), manual
 * matching with its refusals, unmatch with a reason, the database backstop (wrong amount,
 * edits, double matches), Excel statements, and the IBAN never appearing in clear anywhere.
 *
 * People (all invented), tenant A, company A1 (seeded standard chart): alice super_admin,
 * dave with no permissions. Every number and IBAN is invented.
 */
import { createHash, randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
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
import { createLogger } from '../../src/kernel/observability/logger.js';
import {
  KERNEL_PERMISSIONS,
  syncPermissionCatalogue,
} from '../../src/kernel/permissions/catalogue.js';
import { PermissionService } from '../../src/kernel/permissions/permission-service.js';
import { createRedis } from '../../src/kernel/redis/client.js';
import {
  BankVault,
  GL_PERMISSIONS,
  createGlModule,
  seedLedger,
} from '../../src/modules/gl/index.js';
import { createFixture, type Fixture } from './fixtures.js';
import { connectionUrl } from './global-setup.js';
import { connect, testDatabase } from './helpers.js';
import { TEST_AUTH_ENV } from './test-env.js';

const PASSWORD = 'synthetic-pass-recon-2';
const IBAN = 'QA58DOHB00001234567890ABCDEFG';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

let owner: pg.Client;
let pool: Pool;
let redis: Redis;
let f: Fixture;
let app: Express;
let slugA = '';
let alice = '';
let dave = '';
const storage = new MemoryStorageAdapter();
const ids = { dave: randomUUID(), superAdmin: randomUUID(), user: randomUUID() };

type Json = Record<string, unknown>;
interface Item {
  id: string;
  version: number;
  [key: string]: unknown;
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
const del = (path: string, token: string, version: number, body: Json = { reason: 'wrong pair' }) =>
  auth(request(app).delete(`${API_PREFIX}${path}`), token)
    .set('Idempotency-Key', randomUUID())
    .set('If-Match', `"${String(version)}"`)
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

beforeAll(async () => {
  owner = await connect('owner');
  f = await createFixture(owner);
  const db = testDatabase();
  pool = createPool(connectionUrl(db, db.app), 4);
  redis = createRedis(inject('redisUrl'), 'fibrex-test-gl-reconcile');
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
  const vault = new BankVault(new SecretBox(env.DATA_ENCRYPTION_KEY), env.DATA_ENCRYPTION_KEY);
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
      const gl = createGlModule({ uow, registry, permissions, storage, bankVault: vault });
      for (const router of gl.routers ?? []) api.use(router);
    },
  });
  alice = await signIn('alice');
  dave = await signIn('dave');
});

afterAll(async () => {
  const counters = await redis.keys('rl:*');
  if (counters.length > 0) await redis.del(...counters);
  await redis.quit();
  await pool.end();
  await owner.end();
});

async function accountId(code: string): Promise<string> {
  const r = await owner.query<{ id: string }>(
    `SELECT id FROM gl.account WHERE company_id = $1 AND code = $2 AND deleted_at IS NULL`,
    [f.companyA1, code],
  );
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error(`no account ${code}`);
  return id;
}

async function uploadFile(bytes: Buffer, mime: string, name: string): Promise<string> {
  const key = `recon-test/${randomUUID()}`;
  storage.put(key, bytes);
  const row = await owner.query<{ id: string }>(
    `INSERT INTO files.file_object (tenant_id, company_id, bucket, object_key, sha256, size_bytes, mime_type, original_name)
     VALUES ($1, $2, 'memory', $3, $4, $5, $6, $7) RETURNING id`,
    [
      f.tenantA,
      f.companyA1,
      key,
      createHash('sha256').update(bytes).digest('hex'),
      bytes.length,
      mime,
      name,
    ],
  );
  return row.rows[0]?.id ?? '';
}

const mapping = {
  dateColumn: 'Date',
  dateFormat: 'ymd',
  amountColumn: 'Amount',
  referenceColumn: 'Ref',
  descriptionColumn: 'Details',
};
const NOVEMBER = [
  'Date,Amount,Ref,Details',
  '2026-11-01,1000.00,R1,Client payment ACME',
  '2026-11-05,-250.25,R2,Fuel purchase',
  '2026-11-09,75.50,R3,Refund',
  '2026-11-12,30.00,R4,Dup A',
  '2026-11-12,30.00,R5,Dup B',
].join('\n');

interface JournalLineOut {
  id: string;
}
/** Posts a balanced manual journal and returns the ids of its lines on the bank account. */
async function postJournal(
  date: string,
  debitCode: string,
  creditCode: string,
  amount: string,
): Promise<{ journalId: string; bankLineId: string }> {
  const draft = await post('/manual-journals', alice, {
    entryDate: date,
    description: `Test ${date} ${amount}`,
    lines: [
      { accountCode: debitCode, debit: amount },
      { accountCode: creditCode, credit: amount },
    ],
  });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  const mj = draft.body as Item;
  const posted = await post(`/manual-journals/${mj.id}/post`, alice, {}, mj.version);
  expect(posted.status, JSON.stringify(posted.body)).toBe(200);
  const journalId = (posted.body as { journalId: string }).journalId;
  const bankId = await accountId('1120');
  const line = await owner.query<JournalLineOut>(
    `SELECT id FROM gl.journal_line WHERE journal_id = $1 AND account_id = $2`,
    [journalId, bankId],
  );
  return { journalId, bankLineId: line.rows[0]?.id ?? '' };
}

let bankAccount: Item;
let statement: Item;
const lineByRef = new Map<string, string>();
const journals: Record<string, { journalId: string; bankLineId: string }> = {};
let rule: Item;

interface ScreenLine {
  id: string;
  reference: string | null;
  matchStatus: string;
  match: { id: string; version: number; journalNumber: string; method: string } | null;
}
const screen = async (): Promise<ScreenLine[]> => {
  const res = await get(`/bank-statements/${statement.id}/reconciliation`, alice);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body as { items: ScreenLine[] }).items;
};
const statementStatus = async (): Promise<string> =>
  ((await get(`/bank-statements/${statement.id}`, alice)).body as { status: string }).status;

describe('set-up: bank account, statement and ledger entries', () => {
  it('creates the bank, imports the statement and posts the ledger entries', async () => {
    const location = await post('/cash-locations', alice, {
      name: 'Recon bank',
      kind: 'bank',
      accountId: await accountId('1120'),
      currency: 'QAR',
    });
    expect(location.status).toBe(201);
    const account = await post('/company-bank-accounts', alice, {
      cashLocationId: (location.body as Item).id,
      bankName: 'Synthetic Bank',
      iban: IBAN,
    });
    expect(account.status).toBe(201);
    bankAccount = account.body as Item;

    const file = await uploadFile(Buffer.from(NOVEMBER, 'utf8'), 'text/csv', 'november.csv');
    const imported = await post('/bank-statements', alice, {
      companyBankAccountId: bankAccount.id,
      fileObjectId: file,
      mapping,
    });
    expect(imported.status, JSON.stringify(imported.body)).toBe(201);
    statement = imported.body as Item;
    const lines = await get(`/bank-statements/${statement.id}/lines`, alice);
    for (const l of (lines.body as { items: { id: string; reference: string }[] }).items) {
      lineByRef.set(l.reference, l.id);
    }
    expect(lineByRef.size).toBe(5);

    journals.j1 = await postJournal('2026-11-02', '1120', '4100', '1000'); // R1, 1 day off
    journals.j2 = await postJournal('2026-11-05', '5100', '1120', '250.25'); // R2, a payment
    journals.j3 = await postJournal('2026-11-25', '1120', '4100', '75.5'); // R3, far outside
    journals.j4 = await postJournal('2026-11-12', '1120', '4100', '30'); // R4 or R5
  });
});

describe('match rules', () => {
  it('validates conditions and targets, and needs permissions', async () => {
    const body = {
      name: 'Fuel payments',
      conditions: { direction: 'out', textContains: 'fuel' },
      targetAccountId: await accountId('5100'),
      priority: 10,
    };
    expect((await post('/bank-match-rules', dave, body)).status).toBe(403);
    expect(
      (
        await post('/bank-match-rules', alice, {
          ...body,
          name: 'Bad range',
          conditions: { amountMin: '10', amountMax: '5' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post('/bank-match-rules', alice, {
          ...body,
          name: 'Unknown',
          targetAccountId: randomUUID(),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post('/bank-match-rules', alice, {
          ...body,
          name: 'Odd',
          conditions: { colour: 'red' },
        })
      ).status,
    ).toBe(400);

    const made = await post('/bank-match-rules', alice, body);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    rule = made.body as Item;
    expect(rule).toMatchObject({ priority: 10, active: true });
    expect((await post('/bank-match-rules', alice, body)).status).toBe(409);

    const changed = await patch(`/bank-match-rules/${rule.id}`, alice, rule.version, {
      priority: 20,
    });
    expect(changed.status).toBe(200);
    rule = changed.body as Item;
    expect(rule.priority).toBe(20);
  });
});

describe('automatic matching', () => {
  it('matches only unique candidates and leaves rivals and far dates for a person', async () => {
    expect((await post(`/bank-statements/${statement.id}/auto-match`, dave)).status).toBe(403);
    const res = await post(`/bank-statements/${statement.id}/auto-match`, alice);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as {
      matched: number;
      ambiguous: number;
      unmatched: number;
      items: { statementLineId: string; ruleId: string | null }[];
    };
    // R1 by the plain pass, R2 by the fuel rule; R3 has nothing in its window; R4 and R5
    // compete for one ledger entry.
    expect(body).toMatchObject({ matched: 2, ambiguous: 2, unmatched: 3 });
    const byLine = new Map(body.items.map((i) => [i.statementLineId, i.ruleId]));
    expect(byLine.get(lineByRef.get('R1') ?? '')).toBeNull();
    expect(byLine.get(lineByRef.get('R2') ?? '')).toBe(rule.id);

    const lines = await screen();
    const statusOf = (ref: string) => lines.find((l) => l.reference === ref)?.matchStatus;
    expect(['R1', 'R2', 'R3', 'R4', 'R5'].map(statusOf)).toEqual([
      'matched',
      'matched',
      'unmatched',
      'unmatched',
      'unmatched',
    ]);
    expect(lines.find((l) => l.reference === 'R1')?.match?.method).toBe('rule');
    expect(await statementStatus()).toBe('open');

    // Running it again changes nothing.
    const again = await post(`/bank-statements/${statement.id}/auto-match`, alice);
    expect((again.body as { matched: number }).matched).toBe(0);
  });
});

describe('manual matching', () => {
  it('lists candidates and refuses wrong pairings', async () => {
    const r3 = lineByRef.get('R3') ?? '';
    expect((await get(`/bank-statement-lines/${r3}/candidates`, dave)).status).toBe(403);
    const narrow = await get(`/bank-statement-lines/${r3}/candidates?windowDays=3`, alice);
    expect((narrow.body as { items: unknown[] }).items).toHaveLength(0);
    const wide = await get(`/bank-statement-lines/${r3}/candidates?windowDays=30`, alice);
    const items = (wide.body as { items: { journalLineId: string; amount: string }[] }).items;
    expect(items.map((i) => [i.journalLineId, i.amount])).toEqual([
      [journals.j3?.bankLineId, '75.5000'],
    ]);

    // Wrong amount, wrong account (the income side of the journal), already matched.
    const wrongAmount = await post('/reconciliation-matches', alice, {
      statementLineId: r3,
      journalLineId: journals.j4?.bankLineId,
    });
    expect(wrongAmount.status).toBe(422);
    expect((wrongAmount.body as { code: string }).code).toBe('gl_match_amount');
    const incomeLine = await owner.query<{ id: string }>(
      `SELECT id FROM gl.journal_line WHERE journal_id = $1 AND account_id = $2`,
      [journals.j3?.journalId, await accountId('4100')],
    );
    const wrongAccount = await post('/reconciliation-matches', alice, {
      statementLineId: r3,
      journalLineId: incomeLine.rows[0]?.id,
    });
    expect((wrongAccount.body as { code: string }).code).toBe('gl_match_wrong_account');
    const taken = await post('/reconciliation-matches', alice, {
      statementLineId: lineByRef.get('R1'),
      journalLineId: journals.j1?.bankLineId,
    });
    expect((taken.body as { code: string }).code).toBe('gl_match_taken');
    expect(
      (
        await post('/reconciliation-matches', dave, {
          statementLineId: r3,
          journalLineId: journals.j3?.bankLineId,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await post('/reconciliation-matches', alice, {
          statementLineId: randomUUID(),
          journalLineId: journals.j3?.bankLineId,
        })
      ).status,
    ).toBe(400);
  });

  it('matches by hand until the statement is reconciled', async () => {
    const pairs: [string, string][] = [
      ['R3', journals.j3?.bankLineId ?? ''],
      ['R4', journals.j4?.bankLineId ?? ''],
    ];
    for (const [ref, journalLineId] of pairs) {
      const res = await post('/reconciliation-matches', alice, {
        statementLineId: lineByRef.get(ref),
        journalLineId,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({ method: 'manual', journalLineId });
    }
    expect(await statementStatus()).toBe('open');
    // R5 has no entry left; post one and match it.
    journals.j6 = await postJournal('2026-11-12', '1120', '4100', '30');
    const last = await post('/reconciliation-matches', alice, {
      statementLineId: lineByRef.get('R5'),
      journalLineId: journals.j6.bankLineId,
    });
    expect(last.status).toBe(201);
    expect(await statementStatus()).toBe('reconciled');
    expect((await screen()).every((l) => l.matchStatus === 'matched')).toBe(true);
  });

  it('unmatches with a reason, reopens the statement, and never edits or restores', async () => {
    const lines = await screen();
    const r5 = lines.find((l) => l.reference === 'R5');
    const match = r5?.match;
    expect(match).toBeTruthy();
    const id = match?.id ?? '';
    const version = match?.version ?? 0;

    expect((await del(`/reconciliation-matches/${id}`, dave, version)).status).toBe(403);
    expect((await del(`/reconciliation-matches/${id}`, alice, version, {})).status).toBe(400);
    expect(
      (await patch(`/reconciliation-matches/${id}`, alice, version, {})).status,
    ).toBeGreaterThanOrEqual(400);
    const gone = await del(`/reconciliation-matches/${id}`, alice, version);
    expect(gone.status).toBe(204);
    expect(await statementStatus()).toBe('open');
    expect((await screen()).find((l) => l.reference === 'R5')?.matchStatus).toBe('unmatched');

    // The ledger entry is still there and can be matched again.
    const candidates = await get(`/bank-statement-lines/${r5?.id ?? ''}/candidates`, alice);
    expect((candidates.body as { items: unknown[] }).items).toHaveLength(1);
    const restore = await post(`/reconciliation-matches/${id}/restore`, alice, {}, version + 1);
    expect(restore.status).toBeGreaterThanOrEqual(400);
    const again = await post('/reconciliation-matches', alice, {
      statementLineId: r5?.id,
      journalLineId: journals.j6?.bankLineId,
    });
    expect(again.status).toBe(201);
    expect(await statementStatus()).toBe('reconciled');
  });
});

describe('the database backstop', () => {
  it('refuses a wrong pairing, an edit and a double match even past the API', async () => {
    const r1 = lineByRef.get('R1') ?? '';
    const j4 = await owner.query<{ id: string; entry_date: string }>(
      `SELECT id, entry_date::text FROM gl.journal_line WHERE id = $1`,
      [journals.j4?.bankLineId],
    );
    const insert = (lineId: string, journalLineId: string, date: string, amount: string) =>
      owner.query(
        `INSERT INTO gl.reconciliation_match
           (tenant_id, company_id, statement_line_id, journal_line_id, journal_line_date, amount, method)
         VALUES ($1, $2, $3, $4, $5, $6, 'manual')`,
        [f.tenantA, f.companyA1, lineId, journalLineId, date, amount],
      );
    // R1 is 1000 in; J4's bank line is 30 in.
    await expect(
      insert(r1, j4.rows[0]?.id ?? '', j4.rows[0]?.entry_date ?? '', '1000.0000'),
    ).rejects.toThrow(/gl_match_mismatch/);

    const live = await owner.query<{ id: string }>(
      `SELECT id FROM gl.reconciliation_match WHERE statement_line_id = $1 AND deleted_at IS NULL`,
      [r1],
    );
    await expect(
      owner.query(`UPDATE gl.reconciliation_match SET amount = 1 WHERE id = $1`, [
        live.rows[0]?.id,
      ]),
    ).rejects.toThrow(/gl_match_immutable/);
    const j1 = await owner.query<{ id: string; entry_date: string }>(
      `SELECT id, entry_date::text FROM gl.journal_line WHERE id = $1`,
      [journals.j1?.bankLineId],
    );
    await expect(
      insert(r1, j1.rows[0]?.id ?? '', j1.rows[0]?.entry_date ?? '', '1000.0000'),
    ).rejects.toThrow(/reconciliation_match_line_uq/);
  });
});

describe('Excel statements', () => {
  it('imports an .xlsx statement with the same mapping', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Statement');
    sheet.addRow(['Date', 'Amount', 'Ref', 'Details']);
    sheet.addRow([new Date(Date.UTC(2026, 11, 2)), 500.5, 'X1', 'December receipt']);
    sheet.addRow([new Date(Date.UTC(2026, 11, 3)), -20, 'X2', 'Bank fee']);
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    const file = await uploadFile(bytes, XLSX, 'december.xlsx');
    const res = await post('/bank-statements', alice, {
      companyBankAccountId: bankAccount.id,
      fileObjectId: file,
      mapping,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      lineCount: 2,
      totalIn: '500.5000',
      totalOut: '20.0000',
      periodFrom: '2026-12-02',
    });
    const lines = await get(`/bank-statements/${(res.body as Item).id}/lines`, alice);
    expect((lines.body as { items: { amount: string }[] }).items.map((l) => l.amount)).toEqual([
      '500.5000',
      '-20.0000',
    ]);

    const notExcel = await uploadFile(Buffer.from('not a workbook'), XLSX, 'broken.xlsx');
    const bad = await post('/bank-statements', alice, {
      companyBankAccountId: bankAccount.id,
      fileObjectId: notExcel,
      mapping,
    });
    expect(bad.status).toBe(400);
  });
});

describe('the IBAN stays secret', () => {
  it('never appears in clear in a reconciliation response, the audit log or the columns', async () => {
    const responses = [
      JSON.stringify((await get('/reconciliation-matches', alice)).body),
      JSON.stringify((await get('/bank-statements', alice)).body),
      JSON.stringify((await get('/company-bank-accounts', alice)).body),
      JSON.stringify(await screen()),
    ].join('\n');
    expect(responses).not.toContain(IBAN);
    expect(responses).not.toContain('DOHB');

    const audit = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit.audit_log WHERE diff::text LIKE '%DOHB%'`,
    );
    expect(audit.rows[0]?.n).toBe('0');
    const matches = await owner.query<{ text: string }>(
      `SELECT row_to_json(m)::text AS text FROM gl.reconciliation_match m`,
    );
    expect(matches.rows.map((r) => r.text).join('\n')).not.toContain('DOHB');
  });
});
