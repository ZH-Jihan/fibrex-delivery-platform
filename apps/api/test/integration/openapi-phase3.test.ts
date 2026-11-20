/**
 * Phase 3 OpenAPI check (row 3.9): every Phase 3 route is listed in the OpenAPI document.
 * The people module is built with stub deps (route registration is synchronous, at router
 * creation; handlers are never called), then the document is read back and compared with the
 * list of routes the phase plan (section 4) and rows 3.1 to 3.8 promise.
 *
 * Depends on: createApp, createPeopleModule, createImportRouter. Used by: `pnpm test`.
 */
import type { Express } from 'express';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { loadEnv } from '../../src/kernel/config/env.js';
import { createImportRouter } from '../../src/kernel/imports/import-router.js';
import { createLogger } from '../../src/kernel/observability/logger.js';
import { createRedis } from '../../src/kernel/redis/client.js';
import { createPeopleModule } from '../../src/modules/people/index.js';
import { TEST_AUTH_ENV } from './test-env.js';

const silent = createLogger({ level: 'silent', pretty: false, serviceName: 'test' });
/** An empty stand-in for a dependency; route registration never calls it. */
const stub = (): never => ({}) as never;

let app: Express;
let redis: Redis;

beforeAll(() => {
  redis = createRedis(inject('redisUrl'), 'fibrex-test-openapi-p3');
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
      const people = createPeopleModule({
        uow,
        registry,
        permissions,
        parties: stub(),
        numbering: stub(),
        vault: stub(),
        audit: stub(),
        attachables: stub(),
        ocr: { adapter: stub(), storage: stub() },
      });
      for (const router of people.manifest.routers ?? []) api.use(router);
      api.use(
        createImportRouter({
          uow,
          registry,
          permissions,
          service: stub(),
          exports: stub(),
          queue: stub(),
          targets: stub(),
        }),
      );
    },
  });
});

afterAll(async () => {
  await redis.quit();
});

/** "METHOD /path" for every operation in the document. */
const EXPECTED = [
  // Employees (3.1) and their placements and employment periods
  'get /employees',
  'post /employees',
  'get /employees/{id}',
  'patch /employees/{id}',
  'delete /employees/{id}',
  'post /employees/duplicate-check',
  'get /employees/{employeeId}/placements',
  'post /employees/{employeeId}/placements',
  'get /employees/{employeeId}/employment-periods',
  'post /employees/{employeeId}/employment-periods',
  // Document types, requirements (3.2)
  'get /document-types',
  'post /document-types',
  'get /document-requirements',
  'post /document-requirements',
  // Documents (3.2), expiry (3.4)
  'get /documents',
  'post /documents',
  'get /documents/{id}',
  'post /documents/{id}/files',
  'post /documents/{id}/renew',
  'post /documents/{id}/reveal',
  'get /documents/expiring',
  'get /documents/expiry-calendar',
  'get /documents/expiry-settings',
  'put /documents/expiry-settings',
  // OCR (3.6) and bulk scan upload (3.7)
  'post /ocr/jobs',
  'get /ocr/jobs/{id}',
  'post /ocr/jobs/{id}/confirm',
  'get /bulk-uploads',
  'post /bulk-uploads',
  'get /bulk-uploads/{id}',
  'post /bulk-uploads/{id}/items/{itemId}/confirm',
  'post /bulk-uploads/{id}/items/{itemId}/reject',
  // Employee Excel import on the generic wizard (3.8)
  'get /import-targets',
  'get /import-targets/{entityKey}',
  'get /import-targets/{entityKey}/template',
];

describe('OpenAPI: Phase 3 routes', () => {
  it('lists every Phase 3 route', async () => {
    const res = await request(app).get('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    const doc = res.body as { paths: Record<string, Record<string, unknown>> };
    const listed = new Set<string>();
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const method of Object.keys(ops)) listed.add(`${method} ${path}`);
    }
    // Paths with a named id parameter may use {id} or the parent's name; compare loosely on
    // the shape (parameter names are replaced by {}).
    const shape = (s: string) => s.replace(/\{[^}]+\}/g, '{}');
    const listedShapes = new Set([...listed].map(shape));
    const missing = EXPECTED.filter((e) => !listedShapes.has(shape(e)));
    expect(missing).toEqual([]);
  });
});
