/**
 * Cash locations, company bank accounts and bank statement import (phase 2 row 2.17a)
 * against real PostgreSQL and Redis: ledger-account rules, the IBAN kept only encrypted
 * (never in a response, a column or the audit log in clear), CSV import all-or-nothing, the
 * duplicate and overlap refusals, immutable lines, delete and restore with the lines.
 *
 * People (all invented), tenant A, company A1 (seeded standard chart): alice super_admin,
 * dave with no permissions. Every number and IBAN is invented.
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

const PASSWORD = 'synthetic-pass-bank-2';
const IBAN = 'QA58DOHB00001234567890ABCDEFG';
const IBAN_TYPED = 'qa58 dohb 0000 1234 5678 90ab cdef g';
const IBAN_OTHER = 'QA57DOHB00009876543210ZYXWVUT';

let owner: pg.Client;
let pool: Pool;
let redis: Redis;
let f: Fixture;
let app: Express;
let slugA = '';
let alice = '';
let dave = '';
let vault: BankVault;
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
const post = (path: string, token: string, body: Json = {}) =>
  auth(request(app).post(`${API_PREFIX}${path}`), token)
    .set('Idempotency-Key', randomUUID())
    .send(body);
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
const restore = (path: string, token: string, version: number) =>
  auth(request(app).post(`${API_PREFIX}${path}/restore`), token)
    .set('Idempotency-Key', randomUUID())
    .set('If-Match', `"${String(version)}"`)
    .send({});

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
  redis = createRedis(inject('redisUrl'), 'fibrex-test-gl-bank');
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
  vault = new BankVault(new SecretBox(env.DATA_ENCRYPTION_KEY), env.DATA_ENCRYPTION_KEY);
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

/** Puts a CSV in storage and registers it as an uploaded file; returns the file id. */
async function uploadCsv(text: string, mime = 'text/csv'): Promise<string> {
  const bytes = Buffer.from(text, 'utf8');
  const key = `bank-test/${randomUUID()}.csv`;
  storage.put(key, bytes);
  const row = await owner.query<{ id: string }>(
    `INSERT INTO files.file_object (tenant_id, company_id, bucket, object_key, sha256, size_bytes, mime_type, original_name)
     VALUES ($1, $2, 'memory', $3, $4, $5, $6, 'statement.csv') RETURNING id`,
    [
      f.tenantA,
      f.companyA1,
      key,
      createHash('sha256').update(bytes).digest('hex'),
      bytes.length,
      mime,
    ],
  );
  return row.rows[0]?.id ?? '';
}

const mapping = {
  dateColumn: 'Date',
  dateFormat: 'dmy',
  debitColumn: 'Debit',
  creditColumn: 'Credit',
  referenceColumn: 'Ref',
  descriptionColumn: 'Details',
};
const NOVEMBER = [
  'Date,Debit,Credit,Ref,Details',
  '01/11/2026,,"1,000.00",R1,Client payment',
  '05/11/2026,250.25,,R2,Fuel',
  '09/11/2026,,75.5,R3,Refund',
].join('\n');

let hand = '';
let bank = '';
let bankAccount: Item;

describe('cash locations', () => {
  it('ties a location to a postable asset account, one location per account', async () => {
    const made = await post('/cash-locations', alice, {
      name: 'Office cash',
      kind: 'hand',
      accountId: await accountId('1110'),
      currency: 'QAR',
    });
    expect(made.status).toBe(201);
    hand = (made.body as Item).id;

    // A header account, a liability account and an account already used are refused.
    for (const code of ['1100', '2110']) {
      const res = await post('/cash-locations', alice, {
        name: `Bad ${code}`,
        kind: 'hand',
        accountId: await accountId(code),
        currency: 'QAR',
      });
      expect(res.status).toBe(400);
    }
    const again = await post('/cash-locations', alice, {
      name: 'Second place',
      kind: 'hand',
      accountId: await accountId('1110'),
      currency: 'QAR',
    });
    expect(again.status).toBe(409);
    const badCurrency = await post('/cash-locations', alice, {
      name: 'Odd currency',
      kind: 'card',
      accountId: await accountId('1130'),
      currency: 'XXX',
    });
    expect(badCurrency.status).toBe(400);

    const bankLocation = await post('/cash-locations', alice, {
      name: 'Main bank',
      kind: 'bank',
      accountId: await accountId('1120'),
      currency: 'QAR',
    });
    expect(bankLocation.status).toBe(201);
    bank = (bankLocation.body as Item).id;
  });

  it('needs permissions and lists in name order', async () => {
    expect((await get('/cash-locations', dave)).status).toBe(403);
    const list = await get('/cash-locations', alice);
    expect(list.status).toBe(200);
    expect((list.body as { items: { name: string }[] }).items.map((i) => i.name)).toEqual([
      'Main bank',
      'Office cash',
    ]);
  });
});

describe('company bank accounts', () => {
  it('keeps the number only encrypted, hashed and masked', async () => {
    const wrongKind = await post('/company-bank-accounts', alice, {
      cashLocationId: hand,
      bankName: 'Synthetic Bank',
      iban: IBAN_TYPED,
    });
    expect(wrongKind.status).toBe(400);

    const made = await post('/company-bank-accounts', alice, {
      cashLocationId: bank,
      bankName: 'Synthetic Bank',
      iban: IBAN_TYPED,
      wpsEmployerId: 'EMP-1',
    });
    expect(made.status).toBe(201);
    bankAccount = made.body as Item;
    expect(bankAccount.ibanMasked).toBe('*************************DEFG');
    expect(JSON.stringify(made.body)).not.toContain(IBAN);
    expect(Object.keys(made.body as Json).join(',')).not.toMatch(/encrypted|hash/i);

    // The database holds ciphertext, never the number; the vault opens it again.
    const row = await owner.query<{ iban_encrypted: Buffer; iban_hash: string }>(
      `SELECT iban_encrypted, iban_hash FROM gl.company_bank_account WHERE id = $1`,
      [bankAccount.id],
    );
    const stored = row.rows[0];
    expect(stored?.iban_encrypted.toString('utf8')).not.toContain('DOHB');
    expect(stored?.iban_hash).toBe(vault.hash(f.tenantA, IBAN));
    expect(vault.open(stored?.iban_encrypted ?? Buffer.alloc(0), f.companyA1)).toBe(IBAN);
    expect(() => vault.open(stored?.iban_encrypted ?? Buffer.alloc(0), f.companyA2)).toThrow();

    // Neither the number, its hash nor the ciphertext reach the audit log.
    const audit = await owner.query<{ text: string }>(
      `SELECT diff::text AS text FROM audit.audit_log
        WHERE entity_type = 'gl.company_bank_account' AND entity_id = $1`,
      [bankAccount.id],
    );
    expect(audit.rowCount).toBeGreaterThan(0);
    const logged = audit.rows.map((r) => r.text).join('\n');
    expect(logged).toContain('[redacted]');
    expect(logged).not.toContain(IBAN);
    expect(logged).not.toContain(stored?.iban_hash ?? 'missing');
  });

  it('refuses the same number twice and reseals a changed one', async () => {
    const twin = await post('/cash-locations', alice, {
      name: 'Second bank',
      kind: 'bank',
      accountId: await accountId('1130'),
      currency: 'QAR',
    });
    const twinId = (twin.body as Item).id;
    const dup = await post('/company-bank-accounts', alice, {
      cashLocationId: twinId,
      bankName: 'Other Bank',
      iban: IBAN,
    });
    expect(dup.status).toBe(409);

    const changed = await patch(
      `/company-bank-accounts/${bankAccount.id}`,
      alice,
      bankAccount.version,
      {
        iban: IBAN_OTHER,
      },
    );
    expect(changed.status).toBe(200);
    expect((changed.body as Item).ibanMasked).toBe(`${'*'.repeat(IBAN_OTHER.length - 4)}WVUT`);
    bankAccount = changed.body as Item;
    const row = await owner.query<{ iban_hash: string }>(
      `SELECT iban_hash FROM gl.company_bank_account WHERE id = $1`,
      [bankAccount.id],
    );
    expect(row.rows[0]?.iban_hash).toBe(vault.hash(f.tenantA, IBAN_OTHER));
    // Remove the spare location so later tests stay simple.
    expect((await del(`/cash-locations/${twinId}`, alice, 1)).status).toBe(204);
  });

  it('keeps a location that still has a bank account', async () => {
    const loc = await get(`/cash-locations/${bank}`, alice);
    const res = await del(`/cash-locations/${bank}`, alice, (loc.body as Item).version);
    expect(res.status).toBe(422);
  });
});

describe('bank statement import', () => {
  let statement: Item;

  it('imports a CSV into signed lines and keeps the original', async () => {
    const file = await uploadCsv(NOVEMBER);
    const res = await post('/bank-statements', alice, {
      companyBankAccountId: bankAccount.id,
      fileObjectId: file,
      mapping,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    statement = res.body as Item;
    expect(statement).toMatchObject({
      lineCount: 3,
      totalIn: '1075.5000',
      totalOut: '250.2500',
      periodFrom: '2026-11-01',
      periodTo: '2026-11-09',
      currency: 'QAR',
      status: 'open',
    });
    const lines = await get(`/bank-statements/${statement.id}/lines`, alice);
    expect(lines.status).toBe(200);
    const items = (lines.body as { items: { amount: string; reference: string | null }[] }).items;
    expect(items.map((l) => l.amount)).toEqual(['1000.0000', '-250.2500', '75.5000']);
    expect(items.map((l) => l.reference)).toEqual(['R1', 'R2', 'R3']);
    const raw = await owner.query(
      `SELECT 1 FROM files.raw_input WHERE id = $1 AND kind = 'bank_file'`,
      [statement.rawInputId],
    );
    expect(raw.rowCount).toBe(1);
    expect((await get(`/bank-statements/${statement.id}/lines`, dave)).status).toBe(403);
  });

  it('refuses the same file again and an overlapping period', async () => {
    const same = await post('/bank-statements', alice, {
      companyBankAccountId: bankAccount.id,
      fileObjectId: await uploadCsv(NOVEMBER),
      mapping,
    });
    expect(same.status).toBe(422);
    expect((same.body as { code: string }).code).toBe('gl_statement_duplicate');

    const overlap = await post('/bank-statements', alice, {
      companyBankAccountId: bankAccount.id,
      fileObjectId: await uploadCsv(
        'Date,Debit,Credit,Ref,Details\n08/11/2026,,10,X1,Other file\n20/11/2026,5,,X2,Other',
      ),
      mapping,
    });
    expect(overlap.status).toBe(422);
    expect((overlap.body as { code: string }).code).toBe('gl_statement_overlap');
  });

  it('refuses a whole file with a bad row and writes nothing', async () => {
    const before = await owner.query(`SELECT count(*)::int AS n FROM gl.bank_statement`);
    const bad = await post('/bank-statements', alice, {
      companyBankAccountId: bankAccount.id,
      fileObjectId: await uploadCsv(
        'Date,Debit,Credit,Ref,Details\n01/12/2026,,10,A,ok\n31/02/2026,,5,B,bad date\n03/12/2026,x,,C,bad amount',
      ),
      mapping,
    });
    expect(bad.status).toBe(400);
    const paths = (bad.body as { errors: { path: string }[] }).errors.map((e) => e.path);
    expect(paths).toEqual(['rows.2.Date', 'rows.3.Debit']);
    const after = await owner.query(`SELECT count(*)::int AS n FROM gl.bank_statement`);
    expect(after.rows[0]).toEqual(before.rows[0]);

    const notCsv = await post('/bank-statements', alice, {
      companyBankAccountId: bankAccount.id,
      fileObjectId: await uploadCsv('x', 'image/png'),
      mapping,
    });
    expect(notCsv.status).toBe(400);
    const missing = await post('/bank-statements', alice, {
      companyBankAccountId: bankAccount.id,
      fileObjectId: await uploadCsv('A,B\n1,2'),
      mapping,
    });
    expect(missing.status).toBe(400);
  });

  it('never lets a line change, in the database', async () => {
    await expect(
      owner.query(`UPDATE gl.bank_statement_line SET amount = 1 WHERE statement_id = $1`, [
        statement.id,
      ]),
    ).rejects.toThrow(/gl_statement_line_immutable/);
    // Only the match status moves (row 2.17b).
    await owner.query(
      `UPDATE gl.bank_statement_line SET match_status = 'matched' WHERE statement_id = $1 AND line_no = 1`,
      [statement.id],
    );
    const blocked = await del(`/bank-statements/${statement.id}`, alice, statement.version);
    expect(blocked.status).toBe(422);
    await owner.query(
      `UPDATE gl.bank_statement_line SET match_status = 'unmatched' WHERE statement_id = $1`,
      [statement.id],
    );
  });

  it('deletes a statement with its lines, restores it, and keeps the account while statements exist', async () => {
    const inUse = await del(`/company-bank-accounts/${bankAccount.id}`, alice, bankAccount.version);
    expect(inUse.status).toBe(422);

    const gone = await del(`/bank-statements/${statement.id}`, alice, statement.version);
    expect(gone.status).toBe(204);
    const live = await owner.query(
      `SELECT count(*)::int AS n FROM gl.bank_statement_line WHERE statement_id = $1 AND deleted_at IS NULL`,
      [statement.id],
    );
    expect(live.rows[0]).toEqual({ n: 0 });

    // Deleting moved the version on by one.
    const back = await restore(`/bank-statements/${statement.id}`, alice, statement.version + 1);
    expect(back.status).toBe(200);
    const again = await owner.query(
      `SELECT count(*)::int AS n FROM gl.bank_statement_line WHERE statement_id = $1 AND deleted_at IS NULL`,
      [statement.id],
    );
    expect(again.rows[0]).toEqual({ n: 3 });
  });
});
