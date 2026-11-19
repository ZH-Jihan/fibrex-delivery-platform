/**
 * People, row 3.4: the document expiry engine, end to end against real PostgreSQL and Redis
 * with a fixed clock (phase 3 plan section 6, "Daily job emails the consolidated expiry list").
 *
 * People (all invented), tenant A, company A1:
 *   alice  super_admin: every permission
 *   dave   viewer: reads documents only
 *   erin   admin: receives the in-app expiry alert through the seeded notification rule
 * Tenant B: bob, super_admin (isolation check).
 *
 * Documents of company A1, on day T0 = 2026-11-19:
 *   A Rahim passport +20 days   B Rahim QID +14   C Karim passport +7   D Karim QID 0
 *   E Salma passport -3          F company "Trade licence" +10
 * Owner rule: emails only at 14 and 7 days before, none on the day or after; expired = in-app.
 * The email list is synthetic (example.test), set through the seed function.
 */
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { OutboundMessage } from '../../src/adapters/messaging/interface.js';
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
import { NotifyService, syncEventTypes } from '../../src/modules/notify/index.js';
import {
  PARTY_PERMISSIONS,
  PartyReferenceRegistry,
  PartyService,
  PartyVault,
  createPartyModule,
} from '../../src/modules/party/index.js';
import {
  EXPIRY_EVENT,
  PEOPLE_PERMISSIONS,
  createPeopleModule,
  seedDocumentTypes,
  seedExpiryAlerts,
  type ExpiryService,
} from '../../src/modules/people/index.js';
import { createFixture, type Fixture } from './fixtures.js';
import { connectionUrl } from './global-setup.js';
import { connect, testDatabase } from './helpers.js';
import { TEST_AUTH_ENV } from './test-env.js';

const PASSWORD = 'synthetic-pass-3-4';
const LIST = ['office@example.test', 'hr@example.test'];
const DAY = 86_400_000;
const T0 = Date.parse('2026-11-19T06:00:00Z');

let owner: pg.Client;
let pool: Pool;
let redis: Redis;
let f: Fixture;
let app: Express;
let expiry: ExpiryService;
let notify: NotifyService;
let clock = T0;
let alice: string;
let dave: string;
let bob: string;
const sent: OutboundMessage[] = [];

const ids = {
  dave: randomUUID(),
  erin: randomUUID(),
  superAdmin: randomUUID(),
  viewer: randomUUID(),
  admin: randomUUID(),
  superAdminB: randomUUID(),
  rahim: randomUUID(),
  karim: randomUUID(),
  salma: randomUUID(),
};
const docs: Record<string, string> = {};

/** "YYYY-MM-DD", `days` from T0. */
const day = (days: number) => new Date(T0 + days * DAY).toISOString().slice(0, 10);

type Json = Record<string, unknown>;
const auth = (req: request.Test, token: string) => req.set('Authorization', `Bearer ${token}`);
const get = (path: string, token: string) => auth(request(app).get(`${API_PREFIX}${path}`), token);
const send = (method: 'post' | 'put', path: string, token: string, body: Json) =>
  auth(request(app)[method](`${API_PREFIX}${path}`), token)
    .set('Idempotency-Key', randomUUID())
    .send(body);

async function signIn(tenant: string, identifier: string): Promise<string> {
  const res = await request(app)
    .post(`${API_PREFIX}/auth/login`)
    .send({ tenant, identifier, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.body as { accessToken: string }).accessToken;
}

async function addUser(id: string, tenantId: string, username: string) {
  await owner.query(
    `INSERT INTO iam.user_account (id, tenant_id, username, display_name, must_change_password)
     VALUES ($1, $2, $3, $4, false)
     ON CONFLICT (id) DO UPDATE SET must_change_password = false`,
    [id, tenantId, username, `${username} test`],
  );
  await owner.query(
    `INSERT INTO iam.credential (tenant_id, user_id, kind, hash) VALUES ($1, $2, 'password', $3)
     ON CONFLICT DO NOTHING`,
    [tenantId, id, await hashPassword(PASSWORD)],
  );
}

async function addMembership(tenantId: string, userId: string, companyId: string, roleId: string) {
  const membershipId = randomUUID();
  await owner.query(
    `INSERT INTO iam.company_membership (id, tenant_id, user_id, company_id, is_default)
     VALUES ($1, $2, $3, $4, true)`,
    [membershipId, tenantId, userId, companyId],
  );
  await owner.query(
    `INSERT INTO iam.membership_role (tenant_id, membership_id, role_id) VALUES ($1, $2, $3)`,
    [tenantId, membershipId, roleId],
  );
}

async function grantKeys(tenantId: string, roleId: string, keys: readonly string[] | 'all') {
  await owner.query(
    `INSERT INTO iam.role_permission (tenant_id, role_id, permission_id)
     SELECT $1, $2, id FROM iam.permission WHERE $3::text[] IS NULL OR key = ANY ($3::text[])`,
    [tenantId, roleId, keys === 'all' ? null : keys],
  );
}

/** Alert log rows of company A1 as "doc:window", sorted. */
async function logRows(): Promise<string[]> {
  const res = await owner.query<{ document_id: string; window_days: number }>(
    `SELECT document_id::text, window_days FROM people.expiry_alert_log WHERE company_id = $1`,
    [f.companyA1],
  );
  const name = (id: string) => Object.entries(docs).find(([, v]) => v === id)?.[0] ?? id;
  return res.rows.map((r) => `${name(r.document_id)}:${String(r.window_days)}`).sort();
}

async function statusOf(key: string): Promise<string> {
  const res = await owner.query<{ status: string }>(
    `SELECT status FROM people.document WHERE id = $1`,
    [docs[key]],
  );
  return res.rows[0]?.status ?? '';
}

beforeAll(async () => {
  owner = await connect('owner');
  f = await createFixture(owner);
  const db = testDatabase();
  pool = createPool(connectionUrl(db, db.app), 3);
  redis = createRedis(inject('redisUrl'), 'fibrex-test-expiry');
  const prisma = createPrisma(pool);
  await syncPermissionCatalogue(prisma, [
    ...KERNEL_PERMISSIONS,
    ...PARTY_PERMISSIONS,
    ...PEOPLE_PERMISSIONS,
  ]);

  const slugs = await owner.query<{ id: string; slug: string }>(
    `SELECT id, slug FROM platform.tenant WHERE id IN ($1, $2)`,
    [f.tenantA, f.tenantB],
  );
  const slugA = slugs.rows.find((r) => r.id === f.tenantA)?.slug ?? '';
  const slugB = slugs.rows.find((r) => r.id === f.tenantB)?.slug ?? '';

  await owner.query(
    `INSERT INTO iam.role (id, tenant_id, key, name, is_builtin) VALUES
       ($1, $4, 'super_admin', 'Super Admin', true),
       ($2, $4, 'viewer', 'Viewer', true),
       ($3, $4, 'admin', 'Admin', true),
       ($5, $6, 'super_admin', 'Super Admin', true)`,
    [ids.superAdmin, ids.viewer, ids.admin, f.tenantA, ids.superAdminB, f.tenantB],
  );
  await grantKeys(f.tenantA, ids.superAdmin, 'all');
  await grantKeys(f.tenantB, ids.superAdminB, 'all');
  await grantKeys(f.tenantA, ids.viewer, ['people.document.read']);
  await grantKeys(f.tenantA, ids.admin, ['people.document.read']);

  await addUser(f.userA, f.tenantA, 'alice');
  await addUser(f.userB, f.tenantB, 'bob');
  await addUser(ids.dave, f.tenantA, 'dave');
  await addUser(ids.erin, f.tenantA, 'erin');
  await addMembership(f.tenantA, f.userA, f.companyA1, ids.superAdmin);
  await addMembership(f.tenantA, ids.dave, f.companyA1, ids.viewer);
  await addMembership(f.tenantA, ids.erin, f.companyA1, ids.admin);
  await addMembership(f.tenantB, f.userB, f.companyB1, ids.superAdminB);

  await owner.query(
    `INSERT INTO party.party (id, tenant_id, company_id, kind, display_name) VALUES
       ($1, $4, $5, 'person', 'Rahim Example'),
       ($2, $4, $5, 'person', 'Karim Example'),
       ($3, $4, $5, 'person', 'Salma Example')`,
    [ids.rahim, ids.karim, ids.salma, f.tenantA, f.companyA1],
  );
  await seedDocumentTypes(owner, f.tenantA, f.companyA1);
  await seedExpiryAlerts(owner, f.tenantA, f.companyA1, LIST);

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
  const audit = createAuditService();
  const vault = new PartyVault(new SecretBox(env.DATA_ENCRYPTION_KEY), env.DATA_ENCRYPTION_KEY);
  const attachables = new AttachableRegistry();
  notify = new NotifyService({
    uow,
    logger,
    realtime: { notify: () => undefined },
    email: { enqueue: () => Promise.resolve() },
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
      // Wired the same way as main.ts, with a fixed clock and a recording mail adapter.
      const modules = new ModuleRegistry({ kernelPermissions: KERNEL_PERMISSIONS });
      modules.register(
        createPartyModule({
          uow,
          registry,
          permissions,
          audit,
          vault,
          references: new PartyReferenceRegistry(),
        }),
      );
      const people = createPeopleModule({
        uow,
        registry,
        permissions,
        parties: new PartyService(vault),
        numbering: new NumberingService(),
        vault,
        audit,
        attachables,
        now: () => new Date(clock),
        expiryJob: {
          prisma,
          outbox: new EventOutbox(),
          logger,
          messaging: {
            send: (message) => {
              sent.push(message);
              return Promise.resolve();
            },
          },
        },
      });
      expiry = people.expiry;
      modules.register(people.manifest);
      modules.mount(api);
      for (const attachable of modules.attachables()) attachables.register(attachable);
    },
  });
  await syncEventTypes(prisma, [
    { key: EXPIRY_EVENT, moduleKey: 'people', label: 'Documents expiring' },
  ]);

  alice = await signIn(slugA, 'alice');
  dave = await signIn(slugA, 'dave');
  bob = await signIn(slugB, 'bob');

  const types = await owner.query<{ id: string; code: string }>(
    `SELECT id, code FROM people.document_type WHERE company_id = $1`,
    [f.companyA1],
  );
  const type = (code: string) => types.rows.find((r) => r.code === code)?.id;
  const add = async (key: string, body: Json) => {
    const res = await send('post', '/documents', alice, body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    docs[key] = (res.body as { id: string }).id;
  };
  const party = (ownerId: string, code: string, days: number) => ({
    ownerType: 'party',
    ownerId,
    documentTypeId: type(code),
    expiryDate: day(days),
  });
  await add('A', party(ids.rahim, 'passport', 20));
  await add('B', party(ids.rahim, 'qid', 14));
  await add('C', party(ids.karim, 'passport', 7));
  await add('D', party(ids.karim, 'qid', 0));
  await add('E', party(ids.salma, 'passport', -3));
  await add('F', {
    ownerType: 'company',
    ownerId: f.companyA1,
    customName: 'Trade licence',
    expiryDate: day(10),
  });
});

afterAll(async () => {
  await redis.quit();
  await pool.end();
  await owner.end();
});

describe('expiry job (fixed clock)', () => {
  it('lists the company for the job through the definer function', async () => {
    // The application role, with no tenant context: the definer function still sees it.
    const res = await pool.query<{ company_id: string }>(
      `SELECT company_id::text AS company_id FROM people.expiry_companies()`,
    );
    expect(res.rows.map((r) => r.company_id)).toContain(f.companyA1);
  });

  it('day T0: one consolidated email per address, windows logged, statuses refreshed', async () => {
    clock = T0;
    sent.length = 0;
    const result = await expiry.run();
    expect(result.failedCompanies).toBe(0);

    // One message to each address of the list, both with the same table.
    const ours = sent.filter((m) => m.text.includes('Trade licence'));
    expect(ours.map((m) => m.to).sort()).toEqual([...LIST].sort());
    // The table rows only (the heading carries today's date).
    const text = (ours[0]?.text ?? '').split('\n').slice(4).join('\n');
    expect(ours[0]?.text).toContain('Employee');
    expect(ours[0]?.text).toContain('Days left');
    // B (14 days), C (7) and F (10) only: not A (20), not D (on the day), not E (expired).
    expect(text).toContain(day(14));
    expect(text).toContain(day(7));
    expect(text).toContain(day(10));
    expect(text).not.toContain(day(20));
    expect(text).not.toContain(day(0));
    expect(text).not.toContain(day(-3));
    expect(text.match(/Rahim Example/g)).toHaveLength(1);
    // C caught up both windows but is listed once.
    expect(text.match(/Karim Example/g)).toHaveLength(1);
    expect(ours[0]?.subject).toMatch(/Documents expiring soon: 3/);

    // C logged at 14 and 7; E logged once as expired (in-app only).
    expect(await logRows()).toEqual(['B:14', 'C:14', 'C:7', 'E:-1', 'F:14']);
    const channels = await owner.query<{ window_days: number; channels: string[] }>(
      `SELECT window_days, channels FROM people.expiry_alert_log WHERE company_id = $1`,
      [f.companyA1],
    );
    for (const row of channels.rows) {
      expect(row.channels).toEqual(row.window_days === -1 ? ['in_app'] : ['email', 'in_app']);
    }

    expect(await statusOf('A')).toBe('valid');
    expect(await statusOf('D')).toBe('expiring');
    expect(await statusOf('E')).toBe('expired');
  });

  it('raises one outbox event that the seeded rule turns into an in-app alert for admins', async () => {
    const events = await owner.query<{ payload: Json }>(
      `SELECT payload FROM integration.outbox_event
        WHERE company_id = $1 AND event_type_key = $2`,
      [f.companyA1, EXPIRY_EVENT],
    );
    expect(events.rows).toHaveLength(1);
    const payload = events.rows[0]?.payload ?? {};
    expect(payload.expiringCount).toBe(3);
    expect(payload.expiredCount).toBe(1);
    // Never a document number in the payload.
    expect(JSON.stringify(payload)).not.toMatch(/number/i);

    const made = await notify.emit({
      tenantId: f.tenantA,
      companyId: f.companyA1,
      eventType: EXPIRY_EVENT,
      payload,
    });
    expect(made).toBe(1);
    const rows = await owner.query<{ user_id: string; title: string }>(
      `SELECT user_id::text, title FROM notify.notification WHERE event_type_key = $1 AND tenant_id = $2`,
      [EXPIRY_EVENT, f.tenantA],
    );
    expect(rows.rows.map((r) => r.user_id)).toEqual([ids.erin]);
    expect(rows.rows[0]?.title).toBe('Documents: 3 expiring soon, 1 expired');
  });

  it('a second run the same day sends and logs nothing', async () => {
    sent.length = 0;
    await expiry.run();
    expect(sent.filter((m) => LIST.includes(m.to))).toHaveLength(0);
    expect(await logRows()).toEqual(['B:14', 'C:14', 'C:7', 'E:-1', 'F:14']);
  });

  it('seven days later: the next windows alert, the newly expired one is in-app only', async () => {
    clock = T0 + 7 * DAY;
    sent.length = 0;
    await expiry.run();
    const ours = sent.filter((m) => m.text.includes('Trade licence'));
    expect(ours).toHaveLength(2);
    // The table rows only (the heading carries today's date).
    const text = (ours[0]?.text ?? '').split('\n').slice(4).join('\n');
    // A now at 13 days (14-day window), B at 7, F at 3 (7-day window); C is on its day.
    expect(text).toContain(day(20));
    expect(text).toContain(day(14));
    expect(text).not.toContain(day(7));
    expect(await logRows()).toEqual([
      'A:14',
      'B:14',
      'B:7',
      'C:14',
      'C:7',
      'D:-1',
      'E:-1',
      'F:14',
      'F:7',
    ]);
    expect(await statusOf('D')).toBe('expired');
  });

  it('a corrected expiry date alerts again', async () => {
    // A's date is corrected to T0 + 9: its 14-day window counts again for the new date.
    clock = T0;
    const current = await get(`/documents/${docs.A ?? ''}`, alice);
    const res = await auth(request(app).patch(`${API_PREFIX}/documents/${docs.A ?? ''}`), alice)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', `"${String((current.body as { version: number }).version)}"`)
      .send({ expiryDate: day(9) });
    expect(res.status).toBe(200);
    sent.length = 0;
    await expiry.run();
    expect(sent.filter((m) => m.text.includes('Rahim Example'))).toHaveLength(2);
    expect((await logRows()).filter((r) => r.startsWith('A:'))).toEqual(['A:14', 'A:14']);
  });
});

describe('expiring list and calendar', () => {
  interface Item {
    documentName: string;
    ownerName: string;
    expiryDate: string;
    daysLeft: number;
    status: string;
  }
  const items = (res: request.Response) => (res.body as { items: Item[] }).items;

  it('lists documents within N days, expired ones included, by expiry date', async () => {
    clock = T0;
    const res = await get('/documents/expiring?withinDays=14', dave);
    expect(res.status).toBe(200);
    const list = items(res);
    expect(list.map((i) => i.daysLeft)).toEqual([-3, 0, 7, 9, 10, 14]);
    expect(list[0]).toMatchObject({ ownerName: 'Salma Example', status: 'expired' });
    expect(list.find((i) => i.documentName === 'Trade licence')?.status).toBe('expiring');
  });

  it('the default range is 30 days', async () => {
    const res = await get('/documents/expiring', dave);
    expect((res.body as { withinDays: number }).withinDays).toBe(30);
    expect(items(res)).toHaveLength(6);
  });

  it('groups a month by day', async () => {
    const res = await get('/documents/expiry-calendar?month=2026-12', dave);
    expect(res.status).toBe(200);
    const body = res.body as { month: string; days: { date: string; items: Item[] }[] };
    expect(body.month).toBe('2026-12');
    expect(body.days.map((d) => d.date)).toEqual([day(14)]);
    const nov = await get('/documents/expiry-calendar?month=2026-11', dave);
    const novDays = (nov.body as { days: { date: string }[] }).days.map((d) => d.date);
    expect(novDays).toEqual([day(-3), day(0), day(7), day(9), day(10)]);
    expect((await get('/documents/expiry-calendar?month=2026-13', dave)).status).toBe(400);
  });

  it('shows nothing of another tenant', async () => {
    const res = await get('/documents/expiring?withinDays=365', bob);
    expect(res.status).toBe(200);
    expect(items(res)).toEqual([]);
  });
});

describe('expiry settings', () => {
  it('reads the seeded list and windows', async () => {
    const res = await get('/documents/expiry-settings', alice);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ companyId: f.companyA1, emails: LIST, windows: [14, 7] });
  });

  it('needs the settings permissions', async () => {
    expect((await get('/documents/expiry-settings', dave)).status).toBe(403);
    const res = await send('put', '/documents/expiry-settings', dave, {
      emails: LIST,
      windows: [7],
    });
    expect(res.status).toBe(403);
  });

  it('saves a new list and windows, audited; bad input is refused', async () => {
    const auditCount = async () =>
      (
        await owner.query(
          `SELECT 1 FROM audit.audit_log WHERE tenant_id = $1 AND entity_type = 'platform.setting'`,
          [f.tenantA],
        )
      ).rowCount ?? 0;
    const before = await auditCount();
    const bad = await send('put', '/documents/expiry-settings', alice, {
      emails: ['not-an-email'],
      windows: [7],
    });
    expect(bad.status).toBe(400);
    const res = await send('put', '/documents/expiry-settings', alice, {
      emails: ['office@example.test'],
      windows: [30, 7],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ emails: ['office@example.test'], windows: [30, 7] });
    expect(await auditCount()).toBe(before + 1);
    // The company default now drives the derived status: A (+9 at T0) and B (+14) are
    // within 30 days either way; a new document 20 days out is now "expiring".
    const created = await send('post', '/documents', alice, {
      ownerType: 'company',
      ownerId: f.companyA1,
      customName: 'Office lease',
      expiryDate: new Date(Date.now() + 20 * DAY).toISOString().slice(0, 10),
    });
    expect(created.status).toBe(201);
    expect((created.body as { status: string }).status).toBe('expiring');
  });
});
