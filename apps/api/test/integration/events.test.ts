/**
 * Event outbox and webhooks (phase 2 row 2.12) against real PostgreSQL and Redis:
 *   - an event is written with the change and vanishes with a rollback;
 *   - the relay hands an event on once, and a consumer's work and "done" mark commit
 *     together (a failing consumer can run again; a finished one never runs twice);
 *   - notification rules now run from the outbox;
 *   - webhook subscriptions over HTTP (secret shown once, permissions, unknown types),
 *     signed delivery to a local receiver with a retry after a 500, the delivery log,
 *     manual retry, secret rotation;
 *   - the event browser shows only the caller's companies and tenant-level events.
 *
 * Data is invented: tenant A, companies A1 and A2 from the fixture.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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
import { createPrisma, type PrismaDb } from '../../src/kernel/db/prisma.js';
import { UnitOfWork, type DbContext } from '../../src/kernel/db/unit-of-work.js';
import { createEventRouter } from '../../src/kernel/events/event-router.js';
import { EventOutbox } from '../../src/kernel/events/outbox.js';
import { OutboxRelay, RELAY_CONSUMER } from '../../src/kernel/events/relay.js';
import {
  SIGNATURE_HEADER,
  verifyWebhookSignature,
  WEBHOOK_CONSUMER,
  WebhookDispatcher,
} from '../../src/kernel/events/webhooks.js';
import { createLogger } from '../../src/kernel/observability/logger.js';
import { syncPermissionCatalogue } from '../../src/kernel/permissions/catalogue.js';
import { PermissionService } from '../../src/kernel/permissions/permission-service.js';
import { createRedis } from '../../src/kernel/redis/client.js';
import {
  createNotifyConsumer,
  KERNEL_EVENT_TYPES,
  NOTIFY_CONSUMER,
  NotifyService,
} from '../../src/modules/notify/index.js';
import { createFixture, type Fixture } from './fixtures.js';
import { connectionUrl } from './global-setup.js';
import { connect, testDatabase } from './helpers.js';
import { TEST_AUTH_ENV } from './test-env.js';

const PASSWORD = 'synthetic-pass-events-1';

let owner: pg.Client;
let pool: Pool;
let redis: Redis;
let prisma: PrismaDb;
let uow: UnitOfWork;
let f: Fixture;
let app: Express;
let slugA = '';
let outbox: EventOutbox;
let relay: OutboxRelay;
let webhooks: WebhookDispatcher;
let receiver: Server;
let receiverUrl = '';
const token: Record<string, string> = {};
const roles = { admin: randomUUID(), user: randomUUID() };
const pushes: string[] = [];

/** What the local receiver got, and what it answers next (then 200). */
const received: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
const answers: number[] = [];

/** A consumer that fails while `flaky.failures` is above zero. */
const flaky = { failures: 0, runs: 0 };
const counter = { runs: 0 };

type Json = Record<string, unknown>;
interface DeliveryItem {
  id: string;
  status: string;
  attempt: number;
  statusCode: number | null;
  nextRetryAt: string | null;
}
const ctxA1 = (): DbContext => ({ tenantId: f.tenantA, companyIds: [f.companyA1] });
const auth = (req: request.Test, who: string) =>
  req.set('Authorization', `Bearer ${token[who] ?? ''}`);
const get = (path: string, who: string) => auth(request(app).get(`${API_PREFIX}${path}`), who);
const post = (path: string, who: string, body: Json = {}) =>
  auth(request(app).post(`${API_PREFIX}${path}`), who)
    .set('Idempotency-Key', randomUUID())
    .send(body);

async function until<T>(probe: () => Promise<T | undefined>, ms = 8_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

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

/** Records one event in its own committed transaction. */
const record = (context: DbContext, companyId: string | null, payload: Json = {}) =>
  uow.runAs(context, () =>
    outbox.record({
      eventType: 'system.test',
      companyId,
      aggregateType: 'test.thing',
      aggregateId: randomUUID(),
      payload,
    }),
  );

async function eventRow(id: string) {
  const row = await owner.query<{ occurred_at: Date; company_id: string | null }>(
    `SELECT occurred_at, company_id FROM integration.outbox_event WHERE id = $1`,
    [id],
  );
  const found = row.rows[0];
  if (found === undefined) throw new Error('event not found');
  return found;
}

async function jobFor(eventId: string, consumerKey: string) {
  const row = await eventRow(eventId);
  return {
    eventId,
    occurredAt: row.occurred_at.toISOString(),
    tenantId: f.tenantA,
    companyId: row.company_id,
    consumerKey,
  };
}

beforeAll(async () => {
  owner = await connect('owner');
  f = await createFixture(owner);
  const db = testDatabase();
  pool = createPool(connectionUrl(db, db.app), 6);
  redis = createRedis(inject('redisUrl'), 'fibrex-test-events');
  prisma = createPrisma(pool);
  await syncPermissionCatalogue(prisma);
  const slug = await owner.query<{ slug: string }>(
    `SELECT slug FROM platform.tenant WHERE id = $1`,
    [f.tenantA],
  );
  slugA = slug.rows[0]?.slug ?? '';
  await owner.query(
    `INSERT INTO iam.role (id, tenant_id, key, name, is_builtin) VALUES
       ($1, $3, 'super_admin', 'Super Admin', true), ($2, $3, 'user', 'User', true)`,
    [roles.admin, roles.user, f.tenantA],
  );
  await owner.query(
    `INSERT INTO iam.role_permission (tenant_id, role_id, permission_id)
     SELECT $1, $2, id FROM iam.permission`,
    [f.tenantA, roles.admin],
  );
  await addUser(f.userA, 'alice', roles.admin);
  await addUser(randomUUID(), 'oscar', roles.user);

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
  const box = new SecretBox(env.DATA_ENCRYPTION_KEY);
  outbox = new EventOutbox();
  relay = new OutboxRelay({ prisma, uow, redisUrl: inject('redisUrl'), logger });
  webhooks = new WebhookDispatcher({
    uow,
    redisUrl: inject('redisUrl'),
    box,
    logger,
    allowInsecure: true,
    attempts: 3,
    backoffMs: 20,
    timeoutMs: 2_000,
  });
  const notify = new NotifyService({
    uow,
    logger,
    email: { enqueue: () => Promise.resolve() },
    realtime: {
      notify: (_tenant, userId) => {
        pushes.push(userId);
      },
    },
  });
  relay.register(createNotifyConsumer(notify));
  relay.register(webhooks.consumer());
  relay.register({
    key: 'test.counter',
    eventTypes: ['system.test'],
    handle: () => {
      counter.runs += 1;
      return Promise.resolve();
    },
  });
  relay.register({
    key: 'test.flaky',
    eventTypes: ['system.test'],
    handle: () => {
      flaky.runs += 1;
      if (flaky.failures > 0) {
        flaky.failures -= 1;
        return Promise.reject(new Error('flaky consumer'));
      }
      return Promise.resolve();
    },
  });
  webhooks.startWorker();

  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.statusCode = answers.shift() ?? 200;
      res.end('ok');
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  receiverUrl = `http://127.0.0.1:${String((receiver.address() as AddressInfo).port)}/hook`;

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
      api.use(
        createEventRouter({
          uow,
          registry,
          permissions,
          box,
          webhooks,
          eventTypes: () => KERNEL_EVENT_TYPES,
        }),
      );
    },
  });
  for (const who of ['alice', 'oscar']) token[who] = await signIn(who);
});

afterAll(async () => {
  await webhooks.close();
  await relay.close();
  await new Promise((resolve) => receiver.close(resolve));
  const counters = await redis.keys('rl:*');
  if (counters.length > 0) await redis.del(...counters);
  await redis.quit();
  await pool.end();
  await owner.end();
});

describe('outbox', () => {
  it('writes the event with the change, and not at all when the change rolls back', async () => {
    const kept = await record(ctxA1(), f.companyA1, { n: 1 });
    expect((await eventRow(kept)).company_id).toBe(f.companyA1);

    const aggregateId = randomUUID();
    await expect(
      uow.runAs(ctxA1(), async () => {
        await outbox.record({
          eventType: 'system.test',
          companyId: f.companyA1,
          aggregateType: 'test.thing',
          aggregateId,
          payload: {},
        });
        throw new Error('the change failed');
      }),
    ).rejects.toThrow('the change failed');
    const gone = await owner.query(
      `SELECT 1 FROM integration.outbox_event WHERE aggregate_id = $1`,
      [aggregateId],
    );
    expect(gone.rowCount).toBe(0);
  });

  it('refuses an event for a company outside the transaction, and is insert-only', async () => {
    await expect(record(ctxA1(), f.companyA2)).rejects.toThrow();
    const id = await record(ctxA1(), f.companyA1);
    await expect(
      owner.query(`UPDATE integration.outbox_event SET payload = '{}' WHERE id = $1`, [id]),
    ).rejects.toThrow();
  });
});

describe('relay and consumers', () => {
  it('hands an event on once, and each consumer runs it once', async () => {
    const id = await record(ctxA1(), f.companyA1);
    expect(await relay.publishPending()).toBeGreaterThanOrEqual(1);
    await relay.publishPending();
    const marks = await owner.query(
      `SELECT 1 FROM integration.event_consumption WHERE event_id = $1 AND consumer_key = $2`,
      [id, RELAY_CONSUMER],
    );
    expect(marks.rowCount).toBe(1);
    const pending = await owner.query(
      `SELECT 1 FROM integration.outbox_pending(1000) WHERE id = $1`,
      [id],
    );
    expect(pending.rowCount).toBe(0);

    const before = counter.runs;
    expect(await relay.consume(await jobFor(id, 'test.counter'))).toBe(true);
    expect(await relay.consume(await jobFor(id, 'test.counter'))).toBe(false);
    expect(counter.runs).toBe(before + 1);
  });

  it('rolls back the mark of a consumer that fails, so it can run again', async () => {
    const id = await record(ctxA1(), f.companyA1);
    flaky.failures = 1;
    await expect(relay.consume(await jobFor(id, 'test.flaky'))).rejects.toThrow('flaky consumer');
    const none = await owner.query(
      `SELECT 1 FROM integration.event_consumption WHERE event_id = $1 AND consumer_key = 'test.flaky'`,
      [id],
    );
    expect(none.rowCount).toBe(0);
    expect(await relay.consume(await jobFor(id, 'test.flaky'))).toBe(true);
    expect(await relay.consume(await jobFor(id, 'test.flaky'))).toBe(false);
  });

  it('runs the notification rules from the outbox, once, and pushes after the commit', async () => {
    await owner.query(
      `INSERT INTO notify.notification_rule (tenant_id, name, event_type_key, recipients, title_template)
       VALUES ($1, 'Events test', 'system.test', $2, 'Hello {{who}}')`,
      [f.tenantA, JSON.stringify({ userIds: [f.userA] })],
    );
    const marker = randomUUID();
    const id = await record(ctxA1(), f.companyA1, { who: marker });
    pushes.length = 0;
    expect(await relay.consume(await jobFor(id, NOTIFY_CONSUMER))).toBe(true);
    expect(await relay.consume(await jobFor(id, NOTIFY_CONSUMER))).toBe(false);
    const rows = await owner.query(
      `SELECT title FROM notify.notification WHERE user_id = $1 AND title = $2`,
      [f.userA, `Hello ${marker}`],
    );
    expect(rows.rowCount).toBe(1);
    expect(pushes).toEqual([f.userA]);
  });
});

describe('webhooks', () => {
  let subscription: { id: string; secret: string; version: number };

  it('creates a subscription and shows the secret only once', async () => {
    const created = await post('/webhook-subscriptions', 'alice', {
      name: 'Receiver',
      url: receiverUrl,
      eventTypeKeys: ['system.test'],
    });
    expect(created.status).toBe(201);
    const body = created.body as { id: string; secret: string; version: number };
    expect(body.secret).toMatch(/^whsec_/);
    subscription = body;

    const read = await get(`/webhook-subscriptions/${body.id}`, 'alice');
    expect(read.status).toBe(200);
    expect(read.body).not.toHaveProperty('secret');
    const stored = await owner.query<{ secret_encrypted: Buffer }>(
      `SELECT secret_encrypted FROM integration.webhook_subscription WHERE id = $1`,
      [body.id],
    );
    expect(stored.rows[0]?.secret_encrypted.toString('utf8')).not.toContain(body.secret);
  });

  it('refuses unknown event types and callers without the permission', async () => {
    const unknown = await post('/webhook-subscriptions', 'alice', {
      name: 'Bad',
      url: receiverUrl,
      eventTypeKeys: ['no.such_event'],
    });
    expect(unknown.status).toBe(400);
    const denied = await post('/webhook-subscriptions', 'oscar', {
      name: 'Nope',
      url: receiverUrl,
      eventTypeKeys: ['*'],
    });
    expect(denied.status).toBe(403);
    expect((await get('/webhook-deliveries', 'oscar')).status).toBe(403);
    expect((await get('/events', 'oscar')).status).toBe(403);
  });

  it('delivers a signed event, retries after a 500 and logs every attempt', async () => {
    received.length = 0;
    answers.push(500);
    const id = await record(ctxA1(), f.companyA1, { amount: '12.5000' });
    expect(await relay.consume(await jobFor(id, WEBHOOK_CONSUMER))).toBe(true);

    const rows = await until(async () => {
      const res = await get(`/webhook-deliveries?eventId=${id}`, 'alice');
      const items = (res.body as { items: DeliveryItem[] }).items;
      return items.some((d) => d.status === 'succeeded') ? items : undefined;
    });
    const attempts = [...rows].sort((a, b) => a.attempt - b.attempt);
    expect(attempts.map((d) => [d.attempt, d.status])).toEqual([
      [1, 'failed'],
      [2, 'succeeded'],
    ]);
    expect(attempts[0]).toMatchObject({ statusCode: 500 });
    expect(attempts[0]?.nextRetryAt).not.toBeNull();

    const last = received.at(-1);
    expect(last).toBeDefined();
    const signature = String(last?.headers[SIGNATURE_HEADER]);
    expect(verifyWebhookSignature(subscription.secret, signature, last?.body ?? '')).toBe(true);
    expect(verifyWebhookSignature('whsec_wrong', signature, last?.body ?? '')).toBe(false);
    expect(JSON.parse(last?.body ?? '{}')).toMatchObject({
      id,
      type: 'system.test',
      companyId: f.companyA1,
      data: { amount: '12.5000' },
    });

    // Manual retry: one more attempt, marked manual.
    const failed = attempts[0]?.id ?? '';
    expect((await post(`/webhook-deliveries/${failed}/retry`, 'alice')).status).toBe(202);
    await until(async () => {
      const res = await get(`/webhook-deliveries?eventId=${id}`, 'alice');
      const items = (res.body as { items: { manual: boolean }[] }).items;
      return items.some((d) => d.manual) ? true : undefined;
    });
  });

  it('rotates the secret; deliveries are then signed with the new one', async () => {
    const rotated = await post(`/webhook-subscriptions/${subscription.id}/rotate-secret`, 'alice');
    expect(rotated.status).toBe(200);
    const secret = (rotated.body as { secret: string }).secret;
    expect(secret).not.toBe(subscription.secret);

    received.length = 0;
    const id = await record(ctxA1(), f.companyA1);
    await relay.consume(await jobFor(id, WEBHOOK_CONSUMER));
    const got = await until(() => Promise.resolve(received.at(-1)));
    const signature = String(got.headers[SIGNATURE_HEADER]);
    expect(verifyWebhookSignature(secret, signature, got.body)).toBe(true);
    expect(verifyWebhookSignature(subscription.secret, signature, got.body)).toBe(false);
  });
});

describe('event browser', () => {
  it("shows the caller's companies and tenant-level events, not other companies", async () => {
    const mine = await record(ctxA1(), f.companyA1);
    const tenantLevel = await record(ctxA1(), null);
    const other = await record({ tenantId: f.tenantA, companyIds: [f.companyA2] }, f.companyA2);
    await relay.publishPending();

    const res = await get('/events?type=system.test&pageSize=200', 'alice');
    expect(res.status).toBe(200);
    const items = (res.body as { items: { id: string; handledBy: { consumer: string }[] }[] })
      .items;
    const ids = items.map((e) => e.id);
    expect(ids).toContain(mine);
    expect(ids).toContain(tenantLevel);
    expect(ids).not.toContain(other);
    expect(items.find((e) => e.id === mine)?.handledBy.map((h) => h.consumer)).toContain(
      RELAY_CONSUMER,
    );

    const types = await get('/event-types', 'oscar');
    expect(types.status).toBe(200);
    expect((types.body as { items: { key: string }[] }).items.map((t) => t.key)).toContain(
      'system.test',
    );
  });
});
