/**
 * Phase 4 OpenAPI check (row 4.10): every Phase 4 route is listed in the OpenAPI document.
 * The performance and tracking modules are built with stub deps (route registration is
 * synchronous, at router creation; handlers are never called), then the document is read back
 * and compared with the routes rows 4.3 to 4.9b built (sync, Google connection, sync sources and
 * mappings, unmatched riders, performance reports, daily summary, tracking, FDB check).
 *
 * Depends on: createApp, createPerformanceModule, createTrackingModule. Used by: `pnpm test`.
 */
import type { Express } from 'express';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { loadEnv } from '../../src/kernel/config/env.js';
import { createLogger } from '../../src/kernel/observability/logger.js';
import { createRedis } from '../../src/kernel/redis/client.js';
import { createPerformanceModule } from '../../src/modules/performance/index.js';
import { createTrackingModule } from '../../src/modules/tracking/index.js';
import { TEST_AUTH_ENV } from './test-env.js';

const silent = createLogger({ level: 'silent', pretty: false, serviceName: 'test' });
/** An empty stand-in for a dependency; route registration never calls it. */
const stub = (): never => ({}) as never;

let app: Express;
let redis: Redis;

beforeAll(() => {
  redis = createRedis(inject('redisUrl'), 'fibrex-test-openapi-p4');
  const env = loadEnv({
    DATABASE_URL: 'postgresql://unused@localhost:1/x',
    REDIS_URL: 'redis://localhost:1',
    ...TEST_AUTH_ENV,
  });
  app = createApp({
    env,
    logger: silent,
    redis,
    readinessChecks: [],
    mountApi(api, registry) {
      const uow = stub();
      const permissions = stub();
      const performance = createPerformanceModule({
        uow,
        registry,
        permissions,
        sync: stub(),
        syncQueue: stub(),
        google: stub(),
        box: stub(),
        parties: stub(),
        employees: stub(),
        summary: stub(),
        fdb: stub(),
        fdbApply: stub(),
      });
      const tracking = createTrackingModule({ uow, registry, permissions, tracking: stub() });
      for (const router of performance.routers ?? []) api.use(router);
      for (const router of tracking.routers ?? []) api.use(router);
    },
  });
});

afterAll(async () => {
  await redis.quit();
});

/** "method /path" for every operation the phase plan (section 5) and rows 4.3 to 4.9b promise. */
const EXPECTED = [
  // Sync sources, runs and mappings (4.3, 4.4, 4.5a)
  'get /client-platforms',
  'get /sync-sources',
  'post /sync-sources',
  'get /sync-sources/{id}',
  'put /sync-sources/{id}',
  'post /sync-sources/{id}/test-headers',
  'get /sync-sources/{id}/column-mappings',
  'post /sync-sources/{id}/column-mappings',
  'post /sync-sources/{id}/run',
  'post /sync-sources/{id}/reimport',
  'post /sync-sources/{id}/upload',
  'get /sync-runs',
  'get /sync-runs/{id}',
  'get /sync-runs/{id}/errors',
  'get /sync-runs/{id}/raw',
  // Google connection (4.4)
  'get /google-connection',
  'post /google-connection/start',
  'post /google-connection/callback',
  'post /google-connection/disconnect',
  'post /google-connection/test',
  // Unmatched riders (4.5b, 4.5c)
  'get /unmatched-identifiers',
  'post /unmatched-identifiers/re-resolve',
  'get /unmatched-identifiers/{id}/candidates',
  'post /unmatched-identifiers/{id}/link',
  'post /unmatched-identifiers/{id}/create-employee',
  'post /unmatched-identifiers/{id}/ignore',
  // Performance reports and the daily summary (4.6a, 4.6b, 4.8c)
  'get /performance/report-options',
  'get /performance/person/{partyId}',
  'get /performance/person/{partyId}/platform-details',
  'get /performance/summary',
  'put /performance/summary',
  'post /performance/summary/send-now',
  // Tracking (4.7, 4.8)
  'get /tracking',
  'get /tracking/settings',
  'put /tracking/settings',
  'get /tracking/cross-check',
  'get /tracking/{partyId}/details',
  'get /tracking/{partyId}/history',
  'post /tracking/entries',
  'patch /tracking/entries/{id}',
  'post /tracking/calls',
  'post /tracking/operator-periods',
  'patch /tracking/operator-periods/{id}',
  // Snoonu FDB report check (4.9, 4.9b)
  'get /performance/fdb-check',
  'get /performance/fdb-check/runs',
  'post /performance/fdb-check/run',
  'post /performance/fdb-check/differences/{id}/review',
  'get /performance/fdb-check/apply-all/preview',
  'post /performance/fdb-check/apply-all',
  'post /performance/fdb-check/differences/{id}/apply',
];

describe('OpenAPI: Phase 4 routes', () => {
  it('lists every Phase 4 route', async () => {
    const res = await request(app).get('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    const doc = res.body as { paths: Record<string, Record<string, unknown>> };
    const listed = new Set<string>();
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const method of Object.keys(ops)) listed.add(`${method} ${path}`);
    }
    // Parameter names may differ between the plan and the router; compare the shape only.
    const shape = (s: string) => s.replace(/\{[^}]+\}/g, '{}');
    const listedShapes = new Set([...listed].map(shape));
    const missing = EXPECTED.filter((e) => !listedShapes.has(shape(e)));
    expect(missing).toEqual([]);
  });
});
