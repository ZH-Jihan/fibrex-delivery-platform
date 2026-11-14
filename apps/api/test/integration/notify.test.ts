/**
 * Notifications and the job scheduler (Phase 1, commit 9), against real PostgreSQL, Redis
 * and a Mailpit container (the same mail catcher the development stack uses).
 *
 * People (all invented), tenant A, company A1:
 *   alice  super_admin, has an email address, receives events through the payload
 *   carol  clerk, has an email address, receives events through her role
 *   dave   clerk, has NO email address
 * Tenant B: bob, super_admin (isolation checks).
 *
 * Proves the plan's acceptance line: an event is emitted, the rule resolves, the Socket.IO
 * client receives it, and the BullMQ email job is delivered to Mailpit (read back through
 * the Mailpit API).
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { io as connectSocket, type Socket } from 'socket.io-client';
import request from 'supertest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { MessagingAdapter } from '../../src/adapters/messaging/interface.js';
import { SmtpMessagingAdapter } from '../../src/adapters/messaging/smtp.js';
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
import { createJobRouter, JOB_PERMISSIONS } from '../../src/kernel/jobs/job-router.js';
import { JobScheduler } from '../../src/kernel/jobs/scheduler.js';
import { createLogger } from '../../src/kernel/observability/logger.js';
import {
  KERNEL_PERMISSIONS,
  syncPermissionCatalogue,
} from '../../src/kernel/permissions/catalogue.js';
import { PermissionService } from '../../src/kernel/permissions/permission-service.js';
import { createRedis } from '../../src/kernel/redis/client.js';
import {
  EmailQueue,
  NOTIFY_PERMISSIONS,
  NotifyService,
  RealtimeGateway,
  createNotifyRouter,
  syncEventTypes,
  type NotificationView,
} from '../../src/modules/notify/index.js';
import { renderTemplate, validateTemplate } from '../../src/modules/notify/template.js';
import { createFixture, type Fixture } from './fixtures.js';
import { connectionUrl } from './global-setup.js';
import { connect, testDatabase } from './helpers.js';
import { TEST_AUTH_ENV } from './test-env.js';

const PASSWORD = 'synthetic-pass-8-1';
const EVENT = 'loan.approved';

let owner: pg.Client;
let pool: Pool;
let redis: Redis;
let f: Fixture;
let app: Express;
let httpServer: HttpServer;
let gateway: RealtimeGateway;
let uow: UnitOfWork;
let notify: NotifyService;
let emailQueue: EmailQueue;
let mailpit: StartedTestContainer;
let mailApi: string;
let scheduler: JobScheduler;
let slugA: string;
let slugB: string;
let alice: string;
let carol: string;
let bob: string;
const ids = {
  carol: randomUUID(),
  dave: randomUUID(),
  superAdmin: randomUUID(),
  clerk: randomUUID(),
  superAdminB: randomUUID(),
};

type Json = Record<string, unknown>;
const auth = (req: request.Test, token: string) => req.set('Authorization', `Bearer ${token}`);
const get = (path: string, token: string) => auth(request(app).get(`${API_PREFIX}${path}`), token);
const post = (path: string, token: string, body: Json = {}) =>
  auth(request(app).post(`${API_PREFIX}${path}`), token)
    .set('Idempotency-Key', randomUUID())
    .send(body);
const put = (path: string, token: string, body: Json) =>
  auth(request(app).put(`${API_PREFIX}${path}`), token)
    .set('Idempotency-Key', randomUUID())
    .send(body);

async function signIn(tenant: string, identifier: string): Promise<string> {
  const res = await request(app)
    .post(`${API_PREFIX}/auth/login`)
    .send({ tenant, identifier, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.body as { accessToken: string }).accessToken;
}

async function addUser(id: string, tenantId: string, username: string, email: string | null) {
  await owner.query(
    `INSERT INTO iam.user_account (id, tenant_id, username, display_name, email, must_change_password)
     VALUES ($1, $2, $3, $4, $5, false)
     ON CONFLICT (id) DO UPDATE SET must_change_password = false, email = EXCLUDED.email`,
    [id, tenantId, username, `${username} test`, email],
  );
  await owner.query(
    `INSERT INTO iam.credential (tenant_id, user_id, kind, hash) VALUES ($1, $2, 'password', $3)`,
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

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined>,
  timeoutMs = 15_000,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

interface MailSummary {
  Subject: string;
  To: { Address: string }[];
}
async function mailTo(address: string, subject: string): Promise<MailSummary | undefined> {
  const res = await fetch(`${mailApi}/api/v1/messages`);
  const list = (await res.json()) as { messages: MailSummary[] };
  return list.messages.find(
    (m) => m.Subject === subject && m.To.some((t) => t.Address === address),
  );
}

async function deliveries(notificationId: string, channel: string) {
  const rows = await owner.query<{ status: string; attempt: number }>(
    `SELECT status, attempt FROM notify.notification_delivery
      WHERE notification_id = $1 AND channel = $2 ORDER BY created_at, attempt`,
    [notificationId, channel],
  );
  return rows.rows;
}

beforeAll(async () => {
  owner = await connect('owner');
  f = await createFixture(owner);
  const db = testDatabase();
  pool = createPool(connectionUrl(db, db.app), 4);
  redis = createRedis(inject('redisUrl'), 'fibrex-test-notify');
  const prisma = createPrisma(pool);
  await syncPermissionCatalogue(prisma, [
    ...KERNEL_PERMISSIONS,
    ...NOTIFY_PERMISSIONS,
    ...JOB_PERMISSIONS,
  ]);
  await syncEventTypes(prisma, [
    { key: EVENT, moduleKey: 'loans', label: 'Loan approved' },
    { key: 'loan.rejected', moduleKey: 'loans', label: 'Loan rejected' },
  ]);

  mailpit = await new GenericContainer('axllent/mailpit:v1.21')
    .withExposedPorts(1025, 8025)
    .withWaitStrategy(Wait.forHttp('/livez', 8025))
    .start();
  mailApi = `http://${mailpit.getHost()}:${String(mailpit.getMappedPort(8025))}`;

  const slugs = await owner.query<{ id: string; slug: string }>(
    `SELECT id, slug FROM platform.tenant WHERE id IN ($1, $2)`,
    [f.tenantA, f.tenantB],
  );
  slugA = slugs.rows.find((r) => r.id === f.tenantA)?.slug ?? '';
  slugB = slugs.rows.find((r) => r.id === f.tenantB)?.slug ?? '';

  await owner.query(
    `INSERT INTO iam.role (id, tenant_id, key, name, is_builtin) VALUES
       ($1, $3, 'super_admin', 'Super Admin', true),
       ($2, $3, 'clerk', 'Clerk', true),
       ($4, $5, 'super_admin', 'Super Admin', true)`,
    [ids.superAdmin, ids.clerk, f.tenantA, ids.superAdminB, f.tenantB],
  );
  for (const [tenant, role] of [
    [f.tenantA, ids.superAdmin],
    [f.tenantB, ids.superAdminB],
  ] as const) {
    await owner.query(
      `INSERT INTO iam.role_permission (tenant_id, role_id, permission_id)
       SELECT $1, $2, id FROM iam.permission`,
      [tenant, role],
    );
  }
  await addUser(f.userA, f.tenantA, 'alice', 'alice@example.test');
  await addUser(f.userB, f.tenantB, 'bob', 'bob@example.test');
  await addUser(ids.carol, f.tenantA, 'carol', 'carol@example.test');
  await addUser(ids.dave, f.tenantA, 'dave', null);
  await addMembership(f.tenantA, f.userA, f.companyA1, ids.superAdmin);
  await addMembership(f.tenantA, ids.carol, f.companyA1, ids.clerk);
  await addMembership(f.tenantA, ids.dave, f.companyA1, ids.clerk);
  await addMembership(f.tenantB, f.userB, f.companyB1, ids.superAdminB);

  const env = loadEnv({
    DATABASE_URL: 'postgresql://unused@localhost:1/x',
    REDIS_URL: inject('redisUrl'),
    ...TEST_AUTH_ENV,
    RATE_LIMIT_ANONYMOUS: '10000',
    RATE_LIMIT_AUTHENTICATED: '10000',
    AUTH_RATE_LIMIT: '10000',
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

  // Real SMTP into the Mailpit container.
  const smtp = new SmtpMessagingAdapter({
    host: mailpit.getHost(),
    port: mailpit.getMappedPort(1025),
    from: 'Fibrex Test <no-reply@fibrex.test>',
    sms: { send: () => Promise.resolve() },
  });
  emailQueue = new EmailQueue({
    redisUrl: inject('redisUrl'),
    uow,
    messaging: smtp,
    logger,
    backoffMs: 100,
  });
  emailQueue.startWorker();
  const holder: { gw?: RealtimeGateway } = {};
  notify = new NotifyService({
    uow,
    logger,
    email: emailQueue,
    realtime: {
      notify: (t: string, u: string, n: NotificationView) => {
        holder.gw?.notify(t, u, n);
      },
    },
  });
  scheduler = new JobScheduler(inject('redisUrl'), logger, 'test-system-jobs');

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
      api.use(createNotifyRouter({ uow, registry, permissions, notify }));
      api.use(
        createJobRouter({
          registry,
          authorize: permissions.authorize,
          queues: () => [scheduler.getQueue(), emailQueue.getQueue()],
        }),
      );
    },
  });
  httpServer = createServer(app);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  gateway = new RealtimeGateway({ server: httpServer, tokens, corsOrigins: [] });
  holder.gw = gateway;

  alice = await signIn(slugA, 'alice');
  carol = await signIn(slugA, 'carol');
  bob = await signIn(slugB, 'bob');
}, 300_000);

afterAll(async () => {
  await scheduler.stop();
  await emailQueue.close().catch(() => undefined);
  await gateway.close();
  const counters = await redis.keys('rl:*');
  if (counters.length > 0) await redis.del(...counters);
  await redis.quit();
  await pool.end();
  await owner.end();
  await mailpit.stop();
});

function socketFor(token: string): Promise<Socket> {
  const port = (httpServer.address() as AddressInfo).port;
  const socket = connectSocket(`http://localhost:${String(port)}/realtime`, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
  });
  return new Promise((resolve, reject) => {
    socket.on('connect', () => {
      resolve(socket);
    });
    socket.on('connect_error', reject);
  });
}

describe('templates', () => {
  it('merges fields, leaves missing ones empty and cannot reach object internals', () => {
    expect(renderTemplate('Loan {{no}} for {{who}}', { no: 'L-1', who: 'A <b>' })).toBe(
      'Loan L-1 for A <b>',
    );
    expect(renderTemplate('[{{missing}}]', {})).toBe('[]');
    expect(renderTemplate('[{{constructor}}][{{__proto__}}]', {})).toBe('[][]');
    expect(validateTemplate('Hello {{name')).toBeDefined();
    expect(validateTemplate('Hello {{name}}')).toBeUndefined();
  });
});

describe('rules and delivery', () => {
  let ruleId: string;

  it('creates a rule through the API and rejects bad input', async () => {
    const bad = await post('/notification-rules', alice, {
      name: 'Bad',
      eventTypeKey: EVENT,
      channels: ['in_app'],
      recipients: {},
      titleTemplate: 'Oops {{',
    });
    expect(bad.status).toBe(400);
    const unknown = await post('/notification-rules', alice, {
      name: 'Unknown event',
      eventTypeKey: 'no.such_event',
      channels: ['in_app'],
      recipients: {},
      titleTemplate: 'x',
    });
    expect(unknown.status).toBe(400);
    const denied = await post('/notification-rules', carol, {
      name: 'Not allowed',
      eventTypeKey: EVENT,
      channels: ['in_app'],
      recipients: {},
      titleTemplate: 'x',
    });
    expect(denied.status).toBe(403);

    const created = await post('/notification-rules', alice, {
      name: 'Loan approved',
      eventTypeKey: EVENT,
      channels: ['in_app', 'email'],
      recipients: { payloadUserFields: ['approverId'], roleKeys: ['clerk'] },
      titleTemplate: 'Loan {{loanNo}} approved',
      bodyTemplate: 'Approved for {{borrower}}.',
    });
    expect(created.status).toBe(201);
    ruleId = (created.body as { id: string }).id;
  });

  it('pushes to the socket, queues the email, delivers it to Mailpit and records every step', async () => {
    const aliceSocket = await socketFor(alice);
    const received = new Promise<NotificationView>((resolve) => {
      aliceSocket.once('notification', resolve);
    });

    const created = await notify.emit({
      tenantId: f.tenantA,
      companyId: f.companyA1,
      eventType: EVENT,
      payload: { loanNo: 'L-1001', borrower: 'Sample Borrower', approverId: f.userA },
    });
    // alice (payload), carol and dave (role clerk) = 3 people.
    expect(created).toBe(3);

    const pushed = await received;
    aliceSocket.close();
    expect(pushed.title).toBe('Loan L-1001 approved');
    expect(pushed.body).toBe('Approved for Sample Borrower.');

    const mail = await waitFor('the email to alice in Mailpit', () =>
      mailTo('alice@example.test', 'Loan L-1001 approved'),
    );
    expect(mail.To[0]?.Address).toBe('alice@example.test');
    await waitFor('the email to carol in Mailpit', () =>
      mailTo('carol@example.test', 'Loan L-1001 approved'),
    );

    // alice's delivery history: queued, then sent.
    const aliceRows = await get('/notifications', alice);
    expect(aliceRows.status).toBe(200);
    const item = (aliceRows.body as { items: { id: string; read: boolean }[] }).items[0];
    expect(item?.read).toBe(false);
    const steps = await waitFor('the sent delivery row', async () => {
      const rows = await deliveries(item?.id ?? '', 'email');
      return rows.some((r) => r.status === 'sent') ? rows : undefined;
    });
    expect(steps.map((s) => s.status)).toEqual(['queued', 'sent']);
    expect((await deliveries(item?.id ?? '', 'in_app')).map((s) => s.status)).toEqual(['sent']);

    // dave has no email address: the email is skipped, the in-app notification still exists.
    const dave = await owner.query<{ status: string }>(
      `SELECT d.status FROM notify.notification_delivery d
         JOIN notify.notification n ON n.id = d.notification_id
        WHERE n.user_id = $1 AND d.channel = 'email'`,
      [ids.dave],
    );
    expect(dave.rows.map((r) => r.status)).toEqual(['skipped']);
  });

  it('lists, counts and marks read, for the caller only', async () => {
    const count = await get('/notifications/unread-count', carol);
    expect((count.body as { unread: number }).unread).toBe(1);
    const list = await get('/notifications?unreadOnly=true', carol);
    const id = (list.body as { items: { id: string }[] }).items[0]?.id ?? '';

    // Another person's notification is "not found", not "forbidden".
    expect((await post(`/notifications/${id}/read`, alice)).status).toBe(404);
    expect((await post(`/notifications/${id}/read`, bob)).status).toBe(404);

    expect((await post(`/notifications/${id}/read`, carol)).status).toBe(204);
    expect((await post(`/notifications/${id}/read`, carol)).status).toBe(204); // repeat is harmless
    const after = await get('/notifications/unread-count', carol);
    expect((after.body as { unread: number }).unread).toBe(0);
    const aliceCount = await get('/notifications/unread-count', alice);
    expect((aliceCount.body as { unread: number }).unread).toBe(1);

    const all = await post('/notifications/read-all', alice);
    expect((all.body as { marked: number }).marked).toBe(1);
    const bobList = await get('/notifications', bob);
    expect((bobList.body as { items: unknown[] }).items).toEqual([]);
  });

  it('respects preferences: a switched-off channel is not used', async () => {
    const saved = await put('/notification-preferences', carol, {
      eventType: EVENT,
      channel: 'email',
      enabled: false,
    });
    expect(saved.status).toBe(200);
    // Switching it off twice updates the same row.
    await put('/notification-preferences', carol, {
      eventType: EVENT,
      channel: 'email',
      enabled: false,
    });
    const prefs = await get('/notification-preferences', carol);
    expect((prefs.body as { items: unknown[] }).items).toHaveLength(1);
    expect(
      (
        await put('/notification-preferences', carol, {
          eventType: 'no.such_event',
          channel: 'email',
          enabled: false,
        })
      ).status,
    ).toBe(400);

    await notify.emit({
      tenantId: f.tenantA,
      companyId: f.companyA1,
      eventType: EVENT,
      payload: { loanNo: 'L-2002', borrower: 'Second', approverId: f.userA },
    });
    await waitFor('alice mail', () => mailTo('alice@example.test', 'Loan L-2002 approved'));
    // carol still has the in-app notification, but no email was queued for her.
    const carolRows = await owner.query<{ channel: string }>(
      `SELECT d.channel FROM notify.notification_delivery d
         JOIN notify.notification n ON n.id = d.notification_id
        WHERE n.user_id = $1 AND n.title = 'Loan L-2002 approved'`,
      [ids.carol],
    );
    expect(carolRows.rows.map((r) => r.channel)).toEqual(['in_app']);
  });

  it('sends a test of a rule to the caller only', async () => {
    const res = await post(`/notification-rules/${ruleId}/test`, alice, {
      payload: { loanNo: 'TEST-1', borrower: 'Nobody' },
    });
    expect(res.status).toBe(200);
    expect((res.body as { sent: number }).sent).toBe(1);
    const list = await get('/notifications?unreadOnly=true', alice);
    expect((list.body as { items: { title: string }[] }).items.map((i) => i.title)).toContain(
      'Loan TEST-1 approved',
    );
    expect((await post(`/notification-rules/${ruleId}/test`, carol, {})).status).toBe(403);
  });

  it('keeps one tenant out of another tenant notifications and rules', async () => {
    expect((await get('/notification-rules', bob)).body).toMatchObject({ items: [] });
    const created = await notify.emit({
      tenantId: f.tenantB,
      eventType: EVENT,
      payload: { loanNo: 'B-1', approverId: f.userA },
    });
    expect(created).toBe(0); // tenant B has no rule; tenant A's rule never applies
  });
});

describe('job scheduler', () => {
  it('runs a recurring job repeatedly and shows the queue in the job monitor', async () => {
    let runs = 0;
    scheduler.register({
      name: 'test-tick',
      everyMs: 200,
      run: () => {
        runs += 1;
        return Promise.resolve();
      },
    });
    await scheduler.start();
    await waitFor('two runs', () => Promise.resolve(runs >= 2 ? runs : undefined));

    const monitor = await get('/jobs', alice);
    expect(monitor.status).toBe(200);
    const names = (monitor.body as { items: { name: string }[] }).items.map((q) => q.name);
    expect(names).toContain('test-system-jobs');
    expect((await get('/jobs', carol)).status).toBe(403);
  });
});

describe('realtime gateway', () => {
  it('refuses a connection without a valid token', async () => {
    await expect(socketFor('not-a-token')).rejects.toThrow();
  });

  it('delivers only to the addressed user', async () => {
    const carolSocket = await socketFor(carol);
    const bobSocket = await socketFor(bob);
    let bobGot = 0;
    bobSocket.on('notification', () => {
      bobGot += 1;
    });
    const carolGot = new Promise<NotificationView>((resolve) => {
      carolSocket.once('notification', resolve);
    });
    gateway.notify(f.tenantA, ids.carol, {
      id: randomUUID(),
      eventType: EVENT,
      title: 'Direct',
      body: '',
      data: {},
      createdAt: new Date().toISOString(),
    });
    expect((await carolGot).title).toBe('Direct');
    await new Promise((r) => setTimeout(r, 200));
    expect(bobGot).toBe(0);
    carolSocket.close();
    bobSocket.close();
  });
});

describe('email retries', () => {
  it('records each failed attempt and succeeds when the server recovers', async () => {
    let calls = 0;
    const flaky: MessagingAdapter = {
      send: () => {
        calls += 1;
        return calls < 3 ? Promise.reject(new Error('mail server down')) : Promise.resolve();
      },
    };
    const logger = createLogger({ level: 'silent', pretty: false, serviceName: 'test' });
    const queue = new EmailQueue({
      redisUrl: inject('redisUrl'),
      uow,
      messaging: flaky,
      logger,
      backoffMs: 50,
    });
    // The test queue shares the queue name with the main one: pause the main worker's share
    // by using a unique notification and checking only its rows.
    await emailQueue.close();
    queue.startWorker();
    const notificationId = randomUUID();
    await queue.enqueue({
      tenantId: f.tenantA,
      userId: f.userA,
      notificationId,
      to: 'alice@example.test',
      subject: 'Retry test',
      text: 'Retry test',
    });
    const rows = await waitFor('the final success', async () => {
      const r = await deliveries(notificationId, 'email');
      return r.some((x) => x.status === 'sent') ? r : undefined;
    });
    expect(rows.map((r) => `${r.status}:${String(r.attempt)}`)).toEqual([
      'failed:1',
      'failed:2',
      'sent:3',
    ]);
    await queue.close();
  });
});
