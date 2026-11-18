/**
 * Report engine base (phase 2 row 2.13) against real PostgreSQL:
 *   - code-registered reports are written to `cfg.report_definition`, and a second sync of the
 *     same code changes nothing;
 *   - the list shows only reports the caller's permissions allow; meta needs the permission;
 *   - run: paging, sort, filters, bad filter and bad sort refused, row-level security applies;
 *   - export: CSV, Excel and PDF files need `platform.report.export` as well;
 *   - saved reports: owner, sharing, 404 for strangers, 403 for a sharee who edits, unique name.
 *
 * Data is invented: tenant A, companies A1 and A2 from the fixture.
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
import { createPrisma, type PrismaDb } from '../../src/kernel/db/prisma.js';
import { UnitOfWork } from '../../src/kernel/db/unit-of-work.js';
import { createLogger } from '../../src/kernel/observability/logger.js';
import { syncPermissionCatalogue } from '../../src/kernel/permissions/catalogue.js';
import { PermissionService } from '../../src/kernel/permissions/permission-service.js';
import { createRedis } from '../../src/kernel/redis/client.js';
import { exportLogReport, KERNEL_REPORTS } from '../../src/kernel/reports/kernel-reports.js';
import { createReportRouter } from '../../src/kernel/reports/report-router.js';
import { ReportService } from '../../src/kernel/reports/report-service.js';
import { syncReportDefinitions } from '../../src/kernel/reports/report-sync.js';
import { createFixture, type Fixture } from './fixtures.js';
import { connectionUrl } from './global-setup.js';
import { connect, testDatabase } from './helpers.js';
import { TEST_AUTH_ENV } from './test-env.js';

const PASSWORD = 'synthetic-pass-reports-1';
const REPORT = 'integration.export_log';

let owner: pg.Client;
let pool: Pool;
let redis: Redis;
let prisma: PrismaDb;
let f: Fixture;
let app: Express;
let storage: MemoryStorageAdapter;
let slugA = '';
const token: Record<string, string> = {};
const ids = { alice: '', bob: '', carol: '', oscar: '' };
const roles = { admin: randomUUID(), reader: randomUUID(), none: randomUUID() };

type Json = Record<string, unknown>;
const auth = (req: request.Test, who: string) =>
  req.set('Authorization', `Bearer ${token[who] ?? ''}`);
const get = (path: string, who: string) => auth(request(app).get(`${API_PREFIX}${path}`), who);
const send = (method: 'post' | 'patch' | 'delete', path: string, who: string, body: Json = {}) =>
  auth(request(app)[method](`${API_PREFIX}${path}`), who)
    .set('Idempotency-Key', randomUUID())
    .send(body);
const post = (path: string, who: string, body: Json = {}) => send('post', path, who, body);

async function addUser(id: string, username: string, roleId: string) {
  await owner.query(
    `INSERT INTO iam.user_account (id, tenant_id, username, display_name, must_change_password)
     VALUES ($1, $2, $3, $4, false)
     ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, must_change_password = false`,
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

async function signIn(identifier: string): Promise<string> {
  const res = await request(app)
    .post(`${API_PREFIX}/auth/login`)
    .send({ tenant: slugA, identifier, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.body as { accessToken: string }).accessToken;
}

async function addExportJob(companyId: string, entityKey: string, format: string, rows: number) {
  await owner.query(
    `INSERT INTO integration.export_job (tenant_id, company_id, entity_key, format, row_count)
     VALUES ($1, $2, $3, $4, $5)`,
    [f.tenantA, companyId, entityKey, format, rows],
  );
}

beforeAll(async () => {
  owner = await connect('owner');
  f = await createFixture(owner);
  const db = testDatabase();
  pool = createPool(connectionUrl(db, db.app), 6);
  redis = createRedis(inject('redisUrl'), 'fibrex-test-reports');
  prisma = createPrisma(pool);
  await syncPermissionCatalogue(prisma);
  await syncReportDefinitions(prisma, KERNEL_REPORTS);
  const slug = await owner.query<{ slug: string }>(
    `SELECT slug FROM platform.tenant WHERE id = $1`,
    [f.tenantA],
  );
  slugA = slug.rows[0]?.slug ?? '';
  await owner.query(
    `INSERT INTO iam.role (id, tenant_id, key, name, is_builtin) VALUES
       ($1, $4, 'super_admin', 'Super Admin', true), ($2, $4, 'reader', 'Reader', false),
       ($3, $4, 'nobody', 'Nobody', false)`,
    [roles.admin, roles.reader, roles.none, f.tenantA],
  );
  await owner.query(
    `INSERT INTO iam.role_permission (tenant_id, role_id, permission_id)
     SELECT $1, $2, id FROM iam.permission`,
    [f.tenantA, roles.admin],
  );
  // The reader may see the report and keep saved reports, but not export.
  await owner.query(
    `INSERT INTO iam.role_permission (tenant_id, role_id, permission_id)
     SELECT $1, $2, id FROM iam.permission
      WHERE key = ANY ($3::text[])`,
    [
      f.tenantA,
      roles.reader,
      [
        'integration.export_job.read',
        'platform.saved_report.read',
        'platform.saved_report.create',
        'platform.saved_report.update',
        'platform.saved_report.delete',
        'platform.saved_report.restore',
      ],
    ],
  );
  ids.alice = f.userA;
  ids.bob = randomUUID();
  ids.carol = randomUUID();
  ids.oscar = randomUUID();
  await addUser(ids.alice, 'alice', roles.admin);
  await addUser(ids.bob, 'bob', roles.reader);
  await addUser(ids.carol, 'carol', roles.reader);
  await addUser(ids.oscar, 'oscar', roles.none);

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
  const box = new SecretBox(env.DATA_ENCRYPTION_KEY);
  storage = new MemoryStorageAdapter();
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
  const reports = new ReportService({
    permissions,
    storage,
    renderer: new StubPdfRenderer(),
    definitions: () => KERNEL_REPORTS,
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
      api.use(createReportRouter({ uow, registry, permissions, reports }));
    },
  });
  for (const who of ['alice', 'bob', 'carol', 'oscar']) token[who] = await signIn(who);

  await addExportJob(f.companyA1, 'vehicle', 'csv', 10);
  await addExportJob(f.companyA1, 'vehicle', 'xlsx', 30);
  await addExportJob(f.companyA1, 'driver', 'csv', 20);
  await addExportJob(f.companyA2, 'secret_other_company', 'csv', 99);
});

afterAll(async () => {
  const counters = await redis.keys('rl:*');
  if (counters.length > 0) await redis.del(...counters);
  await redis.quit();
  await pool.end();
  await owner.end();
});

interface RunBody {
  rows: { entityKey: string; rowCount: number }[];
  total: number;
  page: number;
  pageSize: number;
}

describe('definitions', () => {
  it('writes code-registered reports to the table and leaves an unchanged one alone', async () => {
    const row = async () =>
      (
        await owner.query<{ version: number; permission_key: string; module_key: string }>(
          `SELECT version, permission_key, module_key FROM cfg.report_definition WHERE key = $1`,
          [REPORT],
        )
      ).rows[0];
    const before = await row();
    expect(before?.permission_key).toBe('integration.export_job.read');
    expect(before?.module_key).toBe('integration');
    await syncReportDefinitions(prisma, KERNEL_REPORTS);
    expect((await row())?.version).toBe(before?.version);
    await syncReportDefinitions(prisma, [{ ...exportLogReport, label: 'Export log (renamed)' }]);
    expect((await row())?.version).toBe((before?.version ?? 0) + 1);
    await syncReportDefinitions(prisma, KERNEL_REPORTS);
  });

  it('refuses the same key declared twice', async () => {
    await expect(syncReportDefinitions(prisma, [exportLogReport, exportLogReport])).rejects.toThrow(
      /twice/,
    );
  });
});

describe('listing and meta', () => {
  it('lists only what the caller may open', async () => {
    for (const who of ['alice', 'bob']) {
      const res = await get('/reports', who);
      expect(res.status).toBe(200);
      expect((res.body as { items: { key: string }[] }).items.map((r) => r.key)).toEqual([REPORT]);
    }
    const none = await get('/reports', 'oscar');
    expect(none.status).toBe(200);
    expect((none.body as { items: unknown[] }).items).toEqual([]);
  });

  it('gives columns and filters to a permitted caller, 403 to others, 404 to an unknown key', async () => {
    const ok = await get(`/reports/${REPORT}/meta`, 'bob');
    expect(ok.status).toBe(200);
    const body = ok.body as { columns: { key: string }[]; filters: { key: string }[] };
    expect(body.columns.map((c) => c.key)).toContain('rowCount');
    expect(body.filters.map((c) => c.key)).toContain('from');
    expect((await get(`/reports/${REPORT}/meta`, 'oscar')).status).toBe(403);
    expect((await get('/reports/nothing.here/meta', 'alice')).status).toBe(404);
  });
});

describe('running', () => {
  it("pages, sorts and filters, and shows only the caller's company", async () => {
    const all = await post(`/reports/${REPORT}/run`, 'bob', { pageSize: 2, page: 1 });
    expect(all.status).toBe(200);
    const body = all.body as RunBody;
    expect(body.total).toBe(3);
    expect(body.rows).toHaveLength(2);
    expect(JSON.stringify(body)).not.toContain('secret_other_company');

    const sorted = await post(`/reports/${REPORT}/run`, 'bob', {
      sort: { key: 'rowCount', direction: 'asc' },
    });
    expect((sorted.body as RunBody).rows.map((r) => r.rowCount)).toEqual([10, 20, 30]);

    const filtered = await post(`/reports/${REPORT}/run`, 'bob', {
      filters: { entityKey: 'vehicle', format: 'xlsx' },
    });
    expect((filtered.body as RunBody).rows.map((r) => r.rowCount)).toEqual([30]);

    const future = await post(`/reports/${REPORT}/run`, 'bob', { filters: { from: '2999-01-01' } });
    expect((future.body as RunBody).total).toBe(0);
    const today = new Date().toISOString().slice(0, 10);
    const sameDay = await post(`/reports/${REPORT}/run`, 'bob', {
      filters: { from: today, to: today },
    });
    expect((sameDay.body as RunBody).total).toBe(3);
  });

  it('refuses unknown filters, wrong kinds, unsortable columns and callers without permission', async () => {
    const unknown = await post(`/reports/${REPORT}/run`, 'bob', { filters: { nope: 'x' } });
    expect(unknown.status).toBe(400);
    expect(JSON.stringify(unknown.body)).toContain('filters.nope');
    expect(
      (await post(`/reports/${REPORT}/run`, 'bob', { filters: { from: 'yesterday' } })).status,
    ).toBe(400);
    expect(
      (await post(`/reports/${REPORT}/run`, 'bob', { sort: { key: 'format', direction: 'asc' } }))
        .status,
    ).toBe(400);
    expect((await post(`/reports/${REPORT}/run`, 'bob', { pageSize: 5000 })).status).toBe(400);
    expect((await post(`/reports/${REPORT}/run`, 'oscar')).status).toBe(403);
  });
});

describe('exporting', () => {
  async function fileText(fileId: string): Promise<{ text: string; mime: string; name: string }> {
    const file = await owner.query<{
      object_key: string;
      mime_type: string;
      original_name: string;
    }>(`SELECT object_key, mime_type, original_name FROM files.file_object WHERE id = $1`, [
      fileId,
    ]);
    const row = file.rows[0];
    const bytes = await storage.read(row?.object_key ?? '');
    return {
      text: bytes?.toString('utf8') ?? '',
      mime: row?.mime_type ?? '',
      name: row?.original_name ?? '',
    };
  }

  it('writes a CSV with the labels as headings and respects filters', async () => {
    const res = await post(`/reports/${REPORT}/export`, 'alice', {
      format: 'csv',
      filters: { entityKey: 'vehicle' },
    });
    expect(res.status).toBe(201);
    const body = res.body as { fileId: string; rowCount: number; format: string };
    expect(body.rowCount).toBe(2);
    const file = await fileText(body.fileId);
    expect(file.mime).toBe('text/csv');
    expect(file.name).toMatch(/^integration-export_log-\d{4}-\d{2}-\d{2}\.csv$/);
    const lines = file.text.trim().split(/\r?\n/);
    expect(lines[0]).toBe('When,Record type,Format,Status,Rows');
    expect(lines).toHaveLength(3);
    expect(file.text).not.toContain('driver');
  });

  it('writes Excel and PDF files', async () => {
    const xlsx = await post(`/reports/${REPORT}/export`, 'alice', { format: 'xlsx' });
    expect(xlsx.status).toBe(201);
    const x = await fileText((xlsx.body as { fileId: string }).fileId);
    expect(x.mime).toContain('spreadsheetml');
    const pdf = await post(`/reports/${REPORT}/export`, 'alice', { format: 'pdf' });
    expect(pdf.status).toBe(201);
    const p = await fileText((pdf.body as { fileId: string }).fileId);
    expect(p.mime).toBe('application/pdf');
    expect(p.text.startsWith('%PDF')).toBe(true);
  });

  it('needs the export permission as well as the report permission', async () => {
    // Bob can run the report but holds no `platform.report.export`.
    expect((await post(`/reports/${REPORT}/run`, 'bob')).status).toBe(200);
    expect((await post(`/reports/${REPORT}/export`, 'bob', { format: 'csv' })).status).toBe(403);
    expect((await post(`/reports/${REPORT}/export`, 'alice', { format: 'docx' })).status).toBe(400);
    expect(
      (await post(`/reports/${REPORT}/export`, 'alice', { format: 'csv', filters: { bad: '1' } }))
        .status,
    ).toBe(400);
  });
});

describe('saved reports', () => {
  interface Saved {
    id: string;
    name: string;
    ownerUserId: string;
    sharedWith: string[];
    version: number;
  }
  const form = (name: string, extra: Json = {}) => ({
    reportKey: REPORT,
    name,
    filters: { entityKey: 'vehicle' },
    columns: ['entityKey', 'rowCount'],
    ...extra,
  });
  let savedId = '';
  let savedVersion = 1;

  it('is created by a permitted person, checked against the report, and unique by name', async () => {
    const created = await post('/saved-reports', 'bob', form('Vehicles only'));
    expect(created.status).toBe(201);
    const item = created.body as Saved;
    expect(item.ownerUserId).toBe(ids.bob);
    savedId = item.id;
    savedVersion = item.version;

    expect((await post('/saved-reports', 'bob', form('Vehicles only'))).status).toBe(409);
    expect(
      (await post('/saved-reports', 'bob', form('Bad filter', { filters: { zzz: '1' } }))).status,
    ).toBe(400);
    expect(
      (await post('/saved-reports', 'bob', form('Bad column', { columns: ['nope'] }))).status,
    ).toBe(400);
    expect(
      (await post('/saved-reports', 'bob', form('Ghost', { reportKey: 'nothing.here' }))).status,
    ).toBe(404);
    // Oscar has neither the report permission nor the saved-report permissions.
    expect((await post('/saved-reports', 'oscar', form('Nope'))).status).toBe(403);
  });

  it('is private to its owner until shared', async () => {
    expect((await get(`/saved-reports/${savedId}`, 'carol')).status).toBe(404);
    const carolList = await get('/saved-reports', 'carol');
    expect((carolList.body as { items: Saved[] }).items).toEqual([]);

    const shared = await send('patch', `/saved-reports/${savedId}`, 'bob', {
      sharedWith: [ids.carol],
    }).set('If-Match', `"${String(savedVersion)}"`);
    expect(shared.status).toBe(200);
    savedVersion = (shared.body as Saved).version;

    expect((await get(`/saved-reports/${savedId}`, 'carol')).status).toBe(200);
    const list = await get(`/saved-reports?reportKey=${REPORT}`, 'carol');
    expect((list.body as { items: Saved[] }).items.map((s) => s.id)).toEqual([savedId]);
  });

  it('may be changed or deleted only by the owner', async () => {
    const edit = await send('patch', `/saved-reports/${savedId}`, 'carol', {
      name: 'Hijacked',
    }).set('If-Match', `"${String(savedVersion)}"`);
    expect(edit.status).toBe(403);
    const remove = await send('delete', `/saved-reports/${savedId}`, 'carol', {
      reason: 'not mine',
    }).set('If-Match', `"${String(savedVersion)}"`);
    expect(remove.status).toBe(403);

    const mine = await send('delete', `/saved-reports/${savedId}`, 'bob', {
      reason: 'no longer needed',
    }).set('If-Match', `"${String(savedVersion)}"`);
    expect(mine.status).toBe(204);
    expect((await get(`/saved-reports/${savedId}`, 'bob')).status).toBe(404);

    // Carol cannot restore it; Bob can.
    const gone = await get('/saved-reports?deleted=true', 'bob');
    const deleted = (gone.body as { items: Saved[] }).items.find((s) => s.id === savedId);
    expect(deleted).toBeDefined();
    const version = `"${String(deleted?.version)}"`;
    expect(
      (await send('post', `/saved-reports/${savedId}/restore`, 'carol').set('If-Match', version))
        .status,
    ).toBe(404);
    expect(
      (await send('post', `/saved-reports/${savedId}/restore`, 'bob').set('If-Match', version))
        .status,
    ).toBe(200);
  });
});
