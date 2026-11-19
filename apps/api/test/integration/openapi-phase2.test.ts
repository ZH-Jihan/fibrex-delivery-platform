/**
 * Phase 2 OpenAPI check (row 2.19): verifies that every Phase 2 router registers its paths
 * in the OpenAPI document. Routes are mounted with stub deps — registration is synchronous
 * and happens at router-creation time, so handlers (which need live deps) are never called.
 *
 * Purpose: confirm that registerRoute() was called for entity-definitions, records, formulas,
 * workflows, and data-exchange routes, keeping the document complete.
 * Depends on: createApp, Phase 2 router factories, createRedis.
 * Used by: `pnpm test` integration suite.
 */
import type { Express } from 'express';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { loadEnv } from '../../src/kernel/config/env.js';
import type { EntityDefinitionService } from '../../src/kernel/entities/entity-definition-service.js';
import { createEntityDefinitionRouter } from '../../src/kernel/entities/entity-definition-router.js';
import type { FormulaService } from '../../src/kernel/formulas/formula-service.js';
import { createFormulaRouter } from '../../src/kernel/formulas/formula-router.js';
import type { ImportQueue } from '../../src/kernel/imports/import-queue.js';
import type { ImportService } from '../../src/kernel/imports/import-service.js';
import type { ImportTargets } from '../../src/kernel/imports/import-targets.js';
import { createImportRouter } from '../../src/kernel/imports/import-router.js';
import type { ExportService } from '../../src/kernel/imports/export-service.js';
import { createLogger } from '../../src/kernel/observability/logger.js';
import type { PermissionService } from '../../src/kernel/permissions/permission-service.js';
import { createRecordRouter } from '../../src/kernel/records/record-router.js';
import { createRedis } from '../../src/kernel/redis/client.js';
import type { RecordService } from '../../src/kernel/records/record-service.js';
import type { UnitOfWork } from '../../src/kernel/db/unit-of-work.js';
import { createWorkflowRouter } from '../../src/kernel/workflows/workflow-router.js';
import type { WorkflowService } from '../../src/kernel/workflows/workflow-service.js';
import { TEST_AUTH_ENV } from './test-env.js';

const silent = createLogger({ level: 'silent', pretty: false, serviceName: 'test' });

// Stub deps: route registration is synchronous; handlers are never called in this test.
const noUow = {} as unknown as UnitOfWork;
// eslint-disable-next-line @typescript-eslint/require-await
const noPerm = { authorize: async () => undefined } as unknown as PermissionService;

let app: Express;
let redis: Redis;

beforeAll(() => {
  redis = createRedis(inject('redisUrl'), 'fibrex-test-openapi-p2');
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
      api.use(
        createEntityDefinitionRouter({
          uow: noUow,
          registry,
          permissions: noPerm,
          entities: {} as unknown as EntityDefinitionService,
        }),
      );
      api.use(
        createFormulaRouter({
          uow: noUow,
          registry,
          permissions: noPerm,
          formulas: {} as unknown as FormulaService,
        }),
      );
      api.use(
        createWorkflowRouter({
          uow: noUow,
          registry,
          permissions: noPerm,
          workflows: {} as unknown as WorkflowService,
        }),
      );
      api.use(
        createRecordRouter({
          uow: noUow,
          registry,
          permissions: noPerm,
          records: {} as unknown as RecordService,
        }),
      );
      api.use(
        createImportRouter({
          uow: noUow,
          registry,
          permissions: noPerm,
          service: {} as unknown as ImportService,
          exports: {} as unknown as ExportService,
          queue: {} as unknown as ImportQueue,
          targets: {} as unknown as ImportTargets,
        }),
      );
    },
  });
});

afterAll(async () => {
  await redis.quit();
});

describe('OpenAPI: Phase 2 paths', () => {
  it('registers entity-definitions, formulas, workflows, records and import paths', async () => {
    const res = await request(app).get('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    const paths = Object.keys((res.body as { paths: Record<string, unknown> }).paths);
    // Entity-definition builder (row 2.7)
    expect(paths.some((p) => p.startsWith('/entity-definitions'))).toBe(true);
    // Field definitions (row 2.7)
    expect(paths.some((p) => p.startsWith('/field-definitions'))).toBe(true);
    // Formulas (row 2.6)
    expect(paths.some((p) => p.startsWith('/formulas'))).toBe(true);
    // Workflows (row 2.11a)
    expect(paths.some((p) => p.startsWith('/workflow-definitions'))).toBe(true);
    // Custom records (row 2.8a)
    expect(paths.some((p) => p.startsWith('/records'))).toBe(true);
    // Import / export (row 2.8b)
    expect(paths.some((p) => p.startsWith('/import-mappings') || p.startsWith('/import-jobs'))).toBe(true);
  });
});
