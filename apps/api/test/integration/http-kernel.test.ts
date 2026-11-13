/**
 * HTTP kernel behaviour through the real Express app, with a real Redis:
 * request ids, problem documents, health and readiness, idempotency keys, rate limits,
 * security headers, CORS, and the OpenAPI document.
 *
 * Test-only routes are mounted through createApp's `mountApi` hook, the same hook modules
 * will use.
 */
import { randomUUID } from 'node:crypto';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import type { Express, Router } from 'express';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { z } from 'zod';
import { createApp } from '../../src/app.js';
import { loadEnv } from '../../src/kernel/config/env.js';
import { registerRoute } from '../../src/kernel/http/openapi.js';
import { createLogger } from '../../src/kernel/observability/logger.js';
import { createRedis } from '../../src/kernel/redis/client.js';

const silent = createLogger({ level: 'silent', pretty: false, serviceName: 'test' });

function testEnv(over: Record<string, string> = {}) {
  return loadEnv({
    DATABASE_URL: 'postgresql://unused@localhost:1/x',
    REDIS_URL: 'redis://localhost:1',
    CORS_ORIGINS: 'http://localhost:5173',
    TRUST_PROXY_HOPS: '1',
    BODY_LIMIT: '1kb',
    ...over,
  });
}

/** Counters and gates the test routes use to prove how often a handler really ran. */
const calls = { echo: 0, flaky: 0 };
let releaseSlow: () => void = () => undefined;

function mountTestRoutes(api: Router, registry: OpenAPIRegistry): void {
  const echoBody = z.object({ name: z.string().min(1) }).meta({ id: 'EchoBody' });
  api.post('/test/echo', (req, res) => {
    const body = echoBody.parse(req.body);
    calls.echo += 1;
    res.status(201).json({ call: calls.echo, name: body.name });
  });
  registerRoute(registry, {
    method: 'post',
    path: '/test/echo',
    request: { body: { content: { 'application/json': { schema: echoBody } } } },
    responses: { 201: { description: 'Created' } },
  });

  api.post('/test/slow', async (_req, res) => {
    await new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    res.json({ done: true });
  });

  api.post('/test/flaky', (_req, res) => {
    calls.flaky += 1;
    if (calls.flaky === 1) throw new Error('database exploded at 10.9.9.9');
    res.json({ ok: calls.flaky });
  });

  api.get('/test/boom', () => {
    throw new Error('secret internal detail');
  });

  api.get('/test/ping', (_req, res) => {
    res.json({ pong: true });
  });

  api.post('/auth/login-like', (_req, res) => {
    res.json({ exempt: true });
  });
}

let redis: Redis;
let app: Express;

beforeAll(() => {
  redis = createRedis(inject('redisUrl'), 'fibrex-test');
  app = createApp({
    env: testEnv(),
    logger: silent,
    redis,
    readinessChecks: [
      {
        name: 'redis',
        check: async () => {
          await redis.ping();
        },
      },
    ],
    mountApi: mountTestRoutes,
  });
});

afterAll(async () => {
  await redis.quit();
});

interface ProblemLike {
  code?: string;
  errors: { path: string }[];
}

/** supertest bodies are untyped; problem documents are read through this. */
const body = (res: request.Response | undefined): ProblemLike =>
  (res?.body ?? { errors: [] }) as ProblemLike;

/** A unique client address per test, so rate-limit and idempotency scopes never collide. */
const ip = () =>
  `10.${String(Math.floor(Math.random() * 250))}.${String(Math.floor(Math.random() * 250))}.${String(Math.floor(Math.random() * 250))}`;

describe('request id and problem documents', () => {
  it('generates a request id and returns it in the header and in errors', async () => {
    const res = await request(app).get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    const id = res.headers['x-request-id'];
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body).toMatchObject({ code: 'route_not_found', status: 404, requestId: id });
  });

  it('keeps a well-formed incoming request id and replaces a malformed one', async () => {
    const kept = await request(app).get('/health').set('X-Request-Id', 'proxy-abc-12345');
    expect(kept.headers['x-request-id']).toBe('proxy-abc-12345');
    // Newlines cannot even be sent (Node rejects them), but other junk can.
    const replaced = await request(app)
      .get('/health')
      .set('X-Request-Id', 'bad id {"injected":1} <script>');
    expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('turns unexpected errors into a generic 500 without leaking details', async () => {
    const res = await request(app).get('/api/v1/test/boom');
    expect(res.status).toBe(500);
    expect(body(res).code).toBe('internal_error');
    expect(JSON.stringify(res.body)).not.toContain('secret internal detail');
    expect(JSON.stringify(res.body)).not.toContain('at ');
  });

  it('reports Zod validation failures per field', async () => {
    const res = await request(app)
      .post('/api/v1/test/echo')
      .set('Idempotency-Key', randomUUID())
      .send({ name: '' });
    expect(res.status).toBe(400);
    expect(body(res).code).toBe('validation_failed');
    expect(body(res).errors[0]?.path).toBe('name');
  });

  it('rejects malformed JSON and oversized bodies', async () => {
    const bad = await request(app)
      .post('/api/v1/test/echo')
      .set('Idempotency-Key', randomUUID())
      .set('Content-Type', 'application/json')
      .send('{"name":');
    expect(body(bad).code).toBe('malformed_json');
    const big = await request(app)
      .post('/api/v1/test/echo')
      .set('Idempotency-Key', randomUUID())
      .send({ name: 'x'.repeat(2000) });
    expect(big.status).toBe(413);
  });
});

describe('health and readiness', () => {
  it('reports liveness and readiness', async () => {
    expect((await request(app).get('/health')).body).toEqual({ status: 'ok' });
    expect((await request(app).get('/ready')).body).toEqual({
      status: 'ready',
      checks: { redis: 'ok' },
    });
  });

  it('returns 503 naming the failing check without leaking its error', async () => {
    const failing = createApp({
      env: testEnv(),
      logger: silent,
      redis,
      readinessChecks: [
        {
          name: 'redis',
          check: async () => {
            await redis.ping();
          },
        },
        {
          name: 'database',
          check: () => Promise.reject(new Error('password authentication failed for fibrex_app')),
        },
      ],
    });
    const res = await request(failing).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'not_ready', checks: { redis: 'ok', database: 'failed' } });
  });
});

describe('idempotency keys', () => {
  it('requires a key on writes, except exempt auth routes', async () => {
    const res = await request(app).post('/api/v1/test/echo').send({ name: 'a' });
    expect(res.status).toBe(400);
    expect(body(res).code).toBe('idempotency_key_required');
    const exempt = await request(app).post('/api/v1/auth/login-like').send({});
    expect(exempt.status).toBe(200);
  });

  it('runs the handler once and replays the first response for a repeated key', async () => {
    const key = randomUUID();
    const client = ip();
    const before = calls.echo;
    const first = await request(app)
      .post('/api/v1/test/echo')
      .set('X-Forwarded-For', client)
      .set('Idempotency-Key', key)
      .send({ name: 'Rahim', x: 1 });
    // Same body with keys in a different order is the same request.
    const second = await request(app)
      .post('/api/v1/test/echo')
      .set('X-Forwarded-For', client)
      .set('Idempotency-Key', key)
      .send({ x: 1, name: 'Rahim' });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(calls.echo).toBe(before + 1);
  });

  it('refuses the same key with a different request', async () => {
    const key = randomUUID();
    const client = ip();
    await request(app)
      .post('/api/v1/test/echo')
      .set('X-Forwarded-For', client)
      .set('Idempotency-Key', key)
      .send({ name: 'a' });
    const res = await request(app)
      .post('/api/v1/test/echo')
      .set('X-Forwarded-For', client)
      .set('Idempotency-Key', key)
      .send({ name: 'b' });
    expect(res.status).toBe(422);
    expect(body(res).code).toBe('idempotency_key_reused');
  });

  it('scopes keys per caller', async () => {
    const key = randomUUID();
    const a = await request(app)
      .post('/api/v1/test/echo')
      .set('X-Forwarded-For', ip())
      .set('Idempotency-Key', key)
      .send({ name: 'a' });
    const b = await request(app)
      .post('/api/v1/test/echo')
      .set('X-Forwarded-For', ip())
      .set('Idempotency-Key', key)
      .send({ name: 'b' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.headers['idempotent-replayed']).toBeUndefined();
  });

  it('answers 409 while the first request with the key is still running', async () => {
    const key = randomUUID();
    const client = ip();
    const slow = request(app)
      .post('/api/v1/test/slow')
      .set('X-Forwarded-For', client)
      .set('Idempotency-Key', key)
      .send({});
    const slowDone = slow.then((r) => r);
    // Give the first request time to claim the key.
    await new Promise((r) => setTimeout(r, 300));
    const dup = await request(app)
      .post('/api/v1/test/slow')
      .set('X-Forwarded-For', client)
      .set('Idempotency-Key', key)
      .send({});
    expect(dup.status).toBe(409);
    expect(body(dup).code).toBe('idempotency_request_in_progress');
    releaseSlow();
    expect((await slowDone).status).toBe(200);
  });

  it('releases the key after a server error so the client can retry', async () => {
    const key = randomUUID();
    const client = ip();
    calls.flaky = 0;
    const first = await request(app)
      .post('/api/v1/test/flaky')
      .set('X-Forwarded-For', client)
      .set('Idempotency-Key', key)
      .send({});
    expect(first.status).toBe(500);
    await new Promise((r) => setTimeout(r, 50));
    const retry = await request(app)
      .post('/api/v1/test/flaky')
      .set('X-Forwarded-For', client)
      .set('Idempotency-Key', key)
      .send({});
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({ ok: 2 });
  });
});

describe('rate limiting', () => {
  it('allows the limit, then answers 429 with Retry-After; callers are counted separately', async () => {
    const limited = createApp({
      env: testEnv({ RATE_LIMIT_ANONYMOUS: '3' }),
      logger: silent,
      redis,
      readinessChecks: [],
      mountApi: mountTestRoutes,
    });
    const client = ip();
    const statuses: number[] = [];
    let last: request.Response | undefined;
    for (let i = 0; i < 4; i += 1) {
      last = await request(limited).get('/api/v1/test/ping').set('X-Forwarded-For', client);
      statuses.push(last.status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(body(last).code).toBe('rate_limited');
    expect(Number(last?.headers['retry-after'])).toBeGreaterThan(0);
    expect(last?.headers['ratelimit-limit']).toBe('3');
    expect(last?.headers['ratelimit-remaining']).toBe('0');

    const other = await request(limited).get('/api/v1/test/ping').set('X-Forwarded-For', ip());
    expect(other.status).toBe(200);
  });

  it('does not rate-limit health probes', async () => {
    const limited = createApp({
      env: testEnv({ RATE_LIMIT_ANONYMOUS: '1' }),
      logger: silent,
      redis,
      readinessChecks: [],
    });
    const client = ip();
    for (let i = 0; i < 3; i += 1) {
      expect((await request(limited).get('/health').set('X-Forwarded-For', client)).status).toBe(
        200,
      );
    }
  });
});

describe('when Redis is down', () => {
  it('rate limiting fails open but writes fail closed (no duplicate protection, no write)', async () => {
    const deadRedis = createRedis('redis://localhost:1/0', 'fibrex-dead');
    deadRedis.on('error', () => undefined);
    try {
      const degraded = createApp({
        env: testEnv(),
        logger: silent,
        redis: deadRedis,
        readinessChecks: [],
        mountApi: mountTestRoutes,
      });
      const read = await request(degraded).get('/api/v1/test/ping');
      expect(read.status).toBe(200);
      const before = calls.echo;
      const write = await request(degraded)
        .post('/api/v1/test/echo')
        .set('Idempotency-Key', randomUUID())
        .send({ name: 'a' });
      expect(write.status).toBe(503);
      expect(body(write).code).toBe('idempotency_unavailable');
      expect(calls.echo).toBe(before);
    } finally {
      deadRedis.disconnect();
    }
  });
});

describe('security headers and CORS', () => {
  it('sends Helmet headers and no X-Powered-By', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('allows only configured origins', async () => {
    const ok = await request(app).get('/health').set('Origin', 'http://localhost:5173');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const bad = await request(app).get('/health').set('Origin', 'https://evil.example');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('OpenAPI', () => {
  it('serves a 3.1 document with registered routes, the Problem schema and Idempotency-Key', async () => {
    const res = await request(app).get('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    const doc = res.body as {
      openapi: string;
      paths: Record<
        string,
        Record<
          string,
          {
            parameters?: { name: string; in: string; required?: boolean }[];
            responses: Record<string, unknown>;
          }
        >
      >;
      components: { schemas: Record<string, unknown> };
    };
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/health', '/ready', '/test/echo']),
    );
    const post = doc.paths['/test/echo']?.post;
    expect(post?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
      ]),
    );
    expect(Object.keys(post?.responses ?? {})).toEqual(
      expect.arrayContaining(['201', '400', '429', '500']),
    );
    expect(Object.keys(doc.components.schemas)).toEqual(
      expect.arrayContaining(['Problem', 'EchoBody']),
    );
  });

  it('serves Swagger UI', async () => {
    const res = await request(app).get('/api/docs/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('swagger-ui');
  });
});
