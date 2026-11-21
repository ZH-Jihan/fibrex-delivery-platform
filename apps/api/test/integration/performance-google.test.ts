/**
 * Row 4.4: the read-only Google Sheets reader, through the real routes, the real BullMQ sync
 * queue and worker, the real permission service and the real database. Google itself is
 * the fake in test/fixtures/fake-google.ts: recorded answer shapes, invented tokens, the fake
 * Snoonu sheet. Nothing reaches the network.
 *
 * Checked: consent start asks for read-only access; a callback with a bad state is refused
 * before Google is asked; the refresh token is sealed (not in the row, not in any answer,
 * "[redacted]" in the audit log) and a used state cannot be used again; sync sources are
 * created from a pasted URL and keep the tab in the column mapping; "test headers" reads row
 * 3 only; Run now reads the sheet through the queue and stores the figures, reusing the
 * access token; a sheet not shared fails at once with one alert; an IMPORTRANGE error is
 * retried, never read as zeros; invalid_grant alerts admins to reconnect (Excel as the
 * fallback), marks the connection, and stops asking Google until someone reconnects;
 * disconnect forgets and revokes the grant.
 * Row 4.4b (service account, the default mode): the status shows the service account email
 * and never the key; a new source defaults to the service account; Test headers and Run now
 * sign in with a JWT signed by a throwaway RSA key and read through the real queue while the
 * OAuth grant is disconnected; a sheet not shared with the service account fails at once
 * with one alert that names the email to share with.
 * Everything is invented: tenant A, company A1, user alice (super admin).
 */
import { generateKeyPairSync, randomUUID, verify, type KeyObject } from 'node:crypto';
import type { Express } from 'express';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { GoogleClient } from '../../src/adapters/google/google-client.js';
import {
  parseServiceAccountKey,
  ServiceAccountClient,
} from '../../src/adapters/google/service-account.js';
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
  GoogleConnectionService,
  GoogleSheetsProvider,
  PERFORMANCE_PERMISSIONS,
  ReportSourceProviders,
  SYNC_PROBLEM_EVENT,
  SyncQueue,
  SyncService,
  createPerformanceModule,
  seedClientPlatforms,
} from '../../src/modules/performance/index.js';
import { FAKE_SCOPE, FakeGoogle, JWT_BEARER } from '../fixtures/fake-google.js';
import { snoonuGrid } from '../fixtures/snoonu-daily-report.js';
import { createFixture, type Fixture } from './fixtures.js';
import { connectionUrl } from './global-setup.js';
import { connect, testDatabase } from './helpers.js';
import { TEST_AUTH_ENV } from './test-env.js';

const PASSWORD = 'synthetic-pass-4-4';
const READ_ON = '2026-11-20';
const NOW = new Date('2026-11-20T01:30:00.000Z');
const SHEET_ID = 'FakeSpreadsheetId_0123456789abcdefABCDEF';
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=0`;
const REFRESH_1 = 'fake-refresh-token-one';
const REFRESH_2 = 'fake-refresh-token-two';

let owner: pg.Client;
let pool: Pool;
let redis: Redis;
let f: Fixture;
let app: Express;
let queue: SyncQueue;
let alice: string;
let platformId: string;
let sourceId = '';
let box: SecretBox;
const google = new FakeGoogle();
const SA_EMAIL = 'fake-sheet-reader@fake-project-44b.iam.gserviceaccount.com';
let saPublicKey: KeyObject;
let saPemBody = '';

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
  rowsRead: number;
}

async function finishedRuns(count: number): Promise<RunItem[]> {
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

async function runNow(expectedTotal: number): Promise<RunItem> {
  const res = await post(`/sync-sources/${sourceId}/run`, { readOn: READ_ON });
  expect(res.status).toBe(202);
  const [newest] = await finishedRuns(expectedTotal);
  if (newest === undefined) throw new Error('no run');
  return newest;
}

async function errorsOf(runId: string): Promise<{ code: string; message: string }[]> {
  const res = await get(`/sync-runs/${runId}/errors`);
  return (res.body as { items: { code: string; message: string }[] }).items;
}

async function alerts(runId: string): Promise<Json[]> {
  const r = await owner.query<{ payload: Json }>(
    `SELECT payload FROM integration.outbox_event WHERE event_type_key = $1 AND aggregate_id = $2`,
    [SYNC_PROBLEM_EVENT, runId],
  );
  return r.rows.map((row) => row.payload);
}

/** Starts consent and returns the state Google would send back. */
async function startConsent(): Promise<string> {
  const res = await post('/google-connection/start');
  expect(res.status).toBe(200);
  const url = new URL((res.body as { authorizationUrl: string }).authorizationUrl);
  expect(url.searchParams.get('scope')).toBe(FAKE_SCOPE);
  return url.searchParams.get('state') ?? '';
}

async function settingsRow(): Promise<{
  id: string;
  settings_encrypted: string | null;
  active: boolean;
}> {
  const r = await owner.query<{ id: string; settings_encrypted: string | null; active: boolean }>(
    `SELECT id, settings_encrypted, active FROM integration.adapter_config
      WHERE tenant_id = $1 AND provider = 'google_sheets' AND deleted_at IS NULL`,
    [f.tenantA],
  );
  const row = r.rows[0];
  if (row === undefined) throw new Error('no adapter_config row');
  return row;
}

beforeAll(async () => {
  owner = await connect('owner');
  f = await createFixture(owner);
  const db = testDatabase();
  pool = createPool(connectionUrl(db, db.app), 4);
  redis = createRedis(inject('redisUrl'), 'fibrex-test-performance-google');
  const prisma = createPrisma(pool);
  await syncPermissionCatalogue(prisma, [...KERNEL_PERMISSIONS, ...PERFORMANCE_PERMISSIONS]);
  await syncEventTypes(prisma, createPerformanceModule().eventTypes ?? []);
  const slug =
    (
      await owner.query<{ slug: string }>(`SELECT slug FROM platform.tenant WHERE id = $1`, [
        f.tenantA,
      ])
    ).rows[0]?.slug ?? '';

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

  const env = loadEnv({
    DATABASE_URL: 'postgresql://unused@localhost:1/x',
    REDIS_URL: 'redis://localhost:1',
    ...TEST_AUTH_ENV,
    RATE_LIMIT_ANONYMOUS: '10000',
    RATE_LIMIT_AUTHENTICATED: '10000',
    AUTH_RATE_LIMIT: '10000',
  });
  box = new SecretBox(env.DATA_ENCRYPTION_KEY);
  const vault = new PartyVault(box, env.DATA_ENCRYPTION_KEY);
  const logger = createLogger({ level: 'silent', pretty: false, serviceName: 'test' });
  const uow = new UnitOfWork(prisma);

  // The real reader and connection, over the fake Google.
  const client = new GoogleClient(
    {
      clientId: 'fake-client-id.apps.googleusercontent.com',
      clientSecret: 'fake-client-secret',
      redirectUri: 'http://localhost:5173/settings/google-connection/callback',
    },
    { fetch: google.fetch, sleep: () => Promise.resolve(), backoffMs: 1 },
  );
  // Row 4.4b: a throwaway RSA key, generated for this run only.
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  saPublicKey = pair.publicKey;
  saPemBody = pem.split('\n')[5] ?? '';
  const serviceAccount = new ServiceAccountClient(
    parseServiceAccountKey(
      JSON.stringify({
        type: 'service_account',
        private_key_id: 'fake-key-44b',
        private_key: pem,
        client_email: SA_EMAIL,
        token_uri: 'https://oauth2.googleapis.com/token',
      }),
    ),
    { fetch: google.fetch, sleep: () => Promise.resolve(), backoffMs: 1 },
  );
  const connection = new GoogleConnectionService({ uow, box, client, serviceAccount });
  const providers = new ReportSourceProviders();
  providers.register(new GoogleSheetsProvider(connection));
  const service = new SyncService({
    uow,
    storage: new MemoryStorageAdapter(),
    parties: new PartyService(vault),
    providers,
    outbox: new EventOutbox(),
    box,
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
    queueName: `performance-google-test-${randomUUID()}`,
  });
  queue.startWorker();

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
        createPerformanceModule({
          uow,
          registry,
          permissions,
          sync: service,
          syncQueue: queue,
          google: connection,
          box,
        }),
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

describe('Google Sheets reader (row 4.4)', () => {
  it('refuses a callback whose state does not match, before asking Google', async () => {
    const status = await get('/google-connection');
    expect(status.body).toMatchObject({ state: 'not_connected', configured: true });

    await startConsent();
    const bad = await post('/google-connection/callback', { code: 'fake-code', state: 'forged' });
    expect(bad.status).toBe(400);
    expect((bad.body as { code: string }).code).toBe('google_bad_state');
    expect(google.callsTo('oauth2.googleapis.com', '/token')).toHaveLength(0);
  });

  it('seals the refresh token: not in the row, not in any answer, redacted in the audit log', async () => {
    const state = await startConsent();
    google.token.authorization_code.push(FakeGoogle.grant(REFRESH_1));
    const res = await post('/google-connection/callback', { code: 'fake-code-1', state });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: 'connected', scope: FAKE_SCOPE, connectedBy: f.userA });
    expect(JSON.stringify(res.body)).not.toContain(REFRESH_1);
    expect(JSON.stringify((await get('/google-connection')).body)).not.toContain(REFRESH_1);

    const row = await settingsRow();
    expect(row.active).toBe(true);
    expect(row.settings_encrypted).not.toBeNull();
    expect(row.settings_encrypted).not.toContain(REFRESH_1);
    expect(Buffer.from(row.settings_encrypted ?? '', 'base64').toString('latin1')).not.toContain(
      REFRESH_1,
    );
    const opened = JSON.parse(
      box
        .open(
          Buffer.from(row.settings_encrypted ?? '', 'base64'),
          `integration.adapter_config:google_sheets:${f.tenantA}`,
        )
        .toString('utf8'),
    ) as { refreshToken: string; pending: unknown };
    expect(opened.refreshToken).toBe(REFRESH_1);
    expect(opened.pending).toBeNull();

    const audit = await owner.query<{ diff: unknown }>(
      `SELECT diff FROM audit.audit_log WHERE entity_id = $1`,
      [row.id],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    const text = JSON.stringify(audit.rows);
    expect(text).not.toContain(REFRESH_1);
    expect(text).toContain('[redacted]');

    // The same state cannot be used twice.
    const again = await post('/google-connection/callback', { code: 'fake-code-1', state });
    expect(again.status).toBe(400);
  });

  it('creates a sheet source from a pasted URL and tests row 3 headers only', async () => {
    google.sheet = snoonuGrid();
    google.token.refresh_token.push(FakeGoogle.access('fake-access-1'));
    const created = await post('/sync-sources', {
      clientPlatformId: platformId,
      name: 'Snoonu daily report',
      adapterKind: 'sheet',
      authMode: 'oauth',
      spreadsheet: SHEET_URL,
      tab: 'Daily Report',
      scheduleCron: '0 4 * * *',
      timeZone: 'Asia/Qatar',
    });
    expect(created.status).toBe(201);
    const body = created.body as {
      id: string;
      spreadsheetId: string;
      tab: string;
      version: number;
    };
    expect(body.spreadsheetId).toBe(SHEET_ID);
    expect(body.tab).toBe('Daily Report');
    sourceId = body.id;

    const bad = await post('/sync-sources', {
      clientPlatformId: platformId,
      name: 'No sheet',
      adapterKind: 'sheet',
      spreadsheet: 'not a sheet',
    });
    expect(bad.status).toBe(400);

    const test = await post(`/sync-sources/${sourceId}/test-headers`);
    expect(test.status).toBe(200);
    const headers = (test.body as { ok: boolean; headers: string[] }).headers;
    expect((test.body as { ok: boolean }).ok).toBe(true);
    expect(headers[0]).toBe('Public ID');
    const [read] = google.callsTo('sheets.googleapis.com').slice(-1);
    expect(decodeURIComponent(read?.url.pathname ?? '')).toContain(
      `${SHEET_ID}/values/'Daily Report'!3:3`,
    );

    const direct = await post('/google-connection/test', {
      spreadsheet: SHEET_ID,
      tab: 'Daily Report',
      authMode: 'oauth',
    });
    expect((direct.body as { headers: string[] }).headers).toEqual(headers);
  });

  it('Run now reads the sheet through the queue and stores the figures, reusing the access token', async () => {
    const refreshesBefore = google.callsTo('oauth2.googleapis.com', '/token').length;
    const run = await runNow(1);
    expect(run.status).toBe('succeeded');
    expect(run.rowsRead).toBeGreaterThan(0);
    const stored = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM performance.daily_performance WHERE client_platform_id = $1 AND is_current`,
      [platformId],
    );
    expect(Number(stored.rows[0]?.n)).toBeGreaterThan(0);
    // The access token from the header test was still valid: no new refresh.
    expect(google.callsTo('oauth2.googleapis.com', '/token')).toHaveLength(refreshesBefore);
    const tabRead = google.callsTo('sheets.googleapis.com').slice(-1)[0];
    expect(decodeURIComponent(tabRead?.url.pathname ?? '')).toMatch(/values\/'Daily Report'$/);
    // Row 4.5a: the run detail names the business dates the run stored.
    const detail = (await get(`/sync-runs/${run.id}`)).body as {
      storedDates: { date: string; rows: number }[];
    };
    expect(detail.storedDates.length).toBeGreaterThan(0);
    expect(detail.storedDates[0]?.rows).toBeGreaterThan(0);
    expect(detail.storedDates[0]?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('a sheet not shared with the account fails at once, with one alert and the Excel fallback', async () => {
    google.values.push(
      FakeGoogle.sheetsError(403, 'PERMISSION_DENIED', 'The caller does not have permission'),
    );
    const run = await runNow(2);
    expect(run.status).toBe('failed');
    const [error] = await errorsOf(run.id);
    expect(error?.code).toBe('not_shared');
    expect(error?.message).toContain('Excel');
    expect(await alerts(run.id)).toHaveLength(1);
    google.values.length = 0;
  });

  it('an IMPORTRANGE error is unreadable (retried, then one alert), never stored as zeros', async () => {
    const before = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM performance.daily_performance WHERE client_platform_id = $1 AND is_current`,
      [platformId],
    );
    google.values.push({ status: 200, body: { values: [['#REF!']] } });
    await post(`/sync-sources/${sourceId}/run`, { readOn: READ_ON });
    const [last, firstTry] = await finishedRuns(4);
    expect(last?.status).toBe('failed');
    expect(firstTry?.status).toBe('failed');
    expect((await errorsOf(last?.id ?? ''))[0]?.code).toBe('sheet_unreadable');
    expect(await alerts(firstTry?.id ?? '')).toHaveLength(0);
    expect(await alerts(last?.id ?? '')).toHaveLength(1);
    const after = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM performance.daily_performance WHERE client_platform_id = $1 AND is_current`,
      [platformId],
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    google.values.length = 0;
  });

  it('invalid_grant alerts admins to reconnect, marks the connection and stops asking Google', async () => {
    // The cached access token is refused (401), so the reader refreshes: Google says invalid_grant.
    google.values.push(FakeGoogle.sheetsError(401, 'UNAUTHENTICATED', 'Invalid Credentials'));
    google.token.refresh_token.splice(
      0,
      google.token.refresh_token.length,
      FakeGoogle.invalidGrant(),
    );
    const run = await runNow(5);
    expect(run.status).toBe('failed');
    const [error] = await errorsOf(run.id);
    expect(error?.code).toBe('access_revoked');
    const [alert] = await alerts(run.id);
    expect(alert?.problem).toBe('source_not_configured');
    expect(String(alert?.message)).toMatch(/reconnect Google/);
    expect(String(alert?.message)).toMatch(/Excel/);

    const status = await get('/google-connection');
    expect(status.body).toMatchObject({ state: 'reconnect_needed' });
    expect((await settingsRow()).active).toBe(false);

    // The next run fails without asking Google for a token again.
    const tokenCalls = google.callsTo('oauth2.googleapis.com', '/token').length;
    const next = await runNow(6);
    expect((await errorsOf(next.id))[0]?.code).toBe('access_revoked');
    expect(google.callsTo('oauth2.googleapis.com', '/token')).toHaveLength(tokenCalls);
    google.values.length = 0;
  });

  it('reconnecting clears the problem, revokes the old token, and the sheet reads again', async () => {
    const state = await startConsent();
    google.token.authorization_code.splice(
      0,
      google.token.authorization_code.length,
      FakeGoogle.grant(REFRESH_2),
    );
    google.token.refresh_token.splice(
      0,
      google.token.refresh_token.length,
      FakeGoogle.access('fake-access-2'),
    );
    const res = await post('/google-connection/callback', { code: 'fake-code-2', state });
    expect(res.body).toMatchObject({ state: 'connected', problem: null });
    const revoked = google
      .callsTo('oauth2.googleapis.com', '/revoke')
      .map((c) => c.form?.get('token'));
    expect(revoked).toContain(REFRESH_1);

    const run = await runNow(7);
    expect(run.status).toBe('succeeded');
  });

  it('changing the tab writes a new mapping version; a stale version is refused', async () => {
    const current = (await get(`/sync-sources/${sourceId}`)).body as { version: number };
    const form = {
      clientPlatformId: platformId,
      name: 'Snoonu daily report',
      adapterKind: 'sheet',
      authMode: 'oauth',
      spreadsheet: SHEET_ID,
      tab: 'Daily Report (copy)',
      version: current.version,
    };
    const put = await auth(request(app).put(`${API_PREFIX}/sync-sources/${sourceId}`))
      .set('Idempotency-Key', randomUUID())
      .send(form);
    expect(put.status).toBe(200);
    expect((put.body as { tab: string }).tab).toBe('Daily Report (copy)');
    const mappings = await owner.query<{ v: number }>(
      `SELECT mapping_version AS v FROM performance.column_mapping WHERE sync_source_id = $1`,
      [sourceId],
    );
    expect(mappings.rows).toHaveLength(1);
    const stale = await auth(request(app).put(`${API_PREFIX}/sync-sources/${sourceId}`))
      .set('Idempotency-Key', randomUUID())
      .send(form);
    expect(stale.status).toBe(409);
  });

  it('lists and saves column mapping versions; a later valid-from waits; a header cannot mean two fields (row 4.5a)', async () => {
    interface Listed {
      versions: { mappingVersion: number }[];
      effective: { tab: string; fields: Record<string, { aliases: string[] }> };
      effectiveVersion: number;
    }
    const first = (await get(`/sync-sources/${sourceId}/column-mappings`)).body as Listed;
    expect(first.versions).toHaveLength(1);
    expect(first.effectiveVersion).toBe(1);

    const base = first.effective;
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const saved = await post(`/sync-sources/${sourceId}/column-mappings`, {
      mapping: { ...base, fields: { ...base.fields, name: { aliases: ['Name', 'Rider name'] } } },
      validFrom: future,
    });
    expect(saved.status).toBe(201);
    expect((saved.body as { mappingVersion: number }).mappingVersion).toBe(2);
    const second = (await get(`/sync-sources/${sourceId}/column-mappings`)).body as Listed;
    // Version 2 is saved but not valid yet: the engine (and the editor) still use version 1.
    expect(second.versions.map((v) => v.mappingVersion)).toEqual([2, 1]);
    expect(second.effectiveVersion).toBe(1);

    const clash = await post(`/sync-sources/${sourceId}/column-mappings`, {
      mapping: { ...base, fields: { ...base.fields, name: { aliases: ['Public ID'] } } },
    });
    expect(clash.status).toBe(400);
    const noKey = await post(`/sync-sources/${sourceId}/column-mappings`, {
      mapping: { ...base, fields: { name: { aliases: ['Name'] } } },
    });
    expect(noKey.status).toBe(400);
  });

  it('tests the header rows of a mapping that is not saved yet (row 4.5a)', async () => {
    google.token.refresh_token.push(FakeGoogle.access('fake-access-45a'));
    const res = await post(`/sync-sources/${sourceId}/test-headers`, {
      tab: 'Daily Report',
      headerRow: 3,
      blockLabelRow: 2,
    });
    const body = res.body as { ok: boolean; headers: string[]; labels: string[] };
    expect(body.ok).toBe(true);
    expect(body.headers[0]).toBe('Public ID');
    expect(body.labels).toContain('Delivered');
  });

  it('disconnect forgets the grant and revokes it at Google', async () => {
    const res = await post('/google-connection/disconnect');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: 'not_connected' });
    const revoked = google
      .callsTo('oauth2.googleapis.com', '/revoke')
      .map((c) => c.form?.get('token'));
    expect(revoked).toContain(REFRESH_2);
    expect((await settingsRow()).settings_encrypted).toBeNull();
  });
});

describe('Google Sheets reader with the service account (row 4.4b)', () => {
  const MIRROR_ID = 'FakeMirrorSheetId_44b_0123456789abcdefAB';
  let oauthSourceId = '';

  it('status shows the service account email and never the key', async () => {
    const res = await get('/google-connection');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      state: 'not_connected',
      serviceAccount: { configured: true, email: SA_EMAIL, problem: null },
      defaultAuthMode: 'service_account',
    });
    expect(JSON.stringify(res.body)).not.toContain(saPemBody);
    expect(JSON.stringify(res.body)).not.toContain('PRIVATE KEY');
  });

  it('a new source defaults to the service account and tests headers with a signed JWT', async () => {
    oauthSourceId = sourceId;
    const created = await post('/sync-sources', {
      clientPlatformId: platformId,
      name: 'Snoonu mirror sheet',
      adapterKind: 'sheet',
      spreadsheet: MIRROR_ID,
    });
    expect(created.status).toBe(201);
    const body = created.body as { id: string; authMode: string; spreadsheetId: string };
    expect(body.authMode).toBe('service_account');
    expect(body.spreadsheetId).toBe(MIRROR_ID);
    sourceId = body.id;
    // The older OAuth source keeps its mode.
    expect(
      ((await get(`/sync-sources/${oauthSourceId}`)).body as { authMode: string }).authMode,
    ).toBe('oauth');

    // Sealed with the spreadsheet id; the key is nowhere in the row.
    const row = await owner.query<{ config_encrypted: Buffer }>(
      `SELECT config_encrypted FROM performance.sync_source WHERE id = $1`,
      [sourceId],
    );
    const sealed = row.rows[0]?.config_encrypted ?? Buffer.alloc(0);
    expect(sealed.toString('latin1')).not.toContain(MIRROR_ID);

    google.sheet = snoonuGrid();
    google.token[JWT_BEARER].push(FakeGoogle.access('sa-access-1'));
    const test = await post(`/sync-sources/${sourceId}/test-headers`);
    expect(test.body).toMatchObject({ ok: true });
    expect((test.body as { headers: string[] }).headers[0]).toBe('Public ID');
    const [tokenCall] = google
      .callsTo('oauth2.googleapis.com', '/token')
      .filter((c) => c.form?.get('grant_type') === JWT_BEARER);
    const [h = '', c = '', sig = ''] = (tokenCall?.form?.get('assertion') ?? '').split('.');
    expect(
      verify('sha256', Buffer.from(`${h}.${c}`), saPublicKey, Buffer.from(sig, 'base64url')),
    ).toBe(true);
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(claims).toMatchObject({ iss: SA_EMAIL, scope: FAKE_SCOPE });
    const read = google.callsTo('sheets.googleapis.com').slice(-1)[0];
    expect(read?.authorization).toBe('Bearer sa-access-1');
    expect(decodeURIComponent(read?.url.pathname ?? '')).toContain(
      `${MIRROR_ID}/values/'Daily Report'!3:3`,
    );

    const direct = await post('/google-connection/test', { spreadsheet: MIRROR_ID });
    expect(direct.body).toMatchObject({ ok: true });
  });

  it('Run now reads the mirror sheet through the queue with the cached service-account token', async () => {
    const jwtCalls = () =>
      google
        .callsTo('oauth2.googleapis.com', '/token')
        .filter((c) => c.form?.get('grant_type') === JWT_BEARER).length;
    const before = jwtCalls();
    const run = await runNow(1);
    expect(run.status).toBe('succeeded');
    expect(run.rowsRead).toBeGreaterThan(0);
    expect(jwtCalls()).toBe(before);
    const tabRead = google.callsTo('sheets.googleapis.com').slice(-1)[0];
    expect(tabRead?.authorization).toBe('Bearer sa-access-1');
    expect(decodeURIComponent(tabRead?.url.pathname ?? '')).toMatch(
      new RegExp(`${MIRROR_ID}/values/'Daily Report'$`),
    );
  });

  it('a mirror sheet not shared with the service account fails at once, naming the email', async () => {
    google.values.push(
      FakeGoogle.sheetsError(403, 'PERMISSION_DENIED', 'The caller does not have permission'),
    );
    const run = await runNow(2);
    expect(run.status).toBe('failed');
    const [error] = await errorsOf(run.id);
    expect(error?.code).toBe('not_shared');
    expect(error?.message).toContain(`add ${SA_EMAIL} as Viewer`);
    expect(error?.message).not.toContain(saPemBody);
    expect(await alerts(run.id)).toHaveLength(1);
    google.values.length = 0;
  });
});
