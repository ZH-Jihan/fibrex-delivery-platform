/**
 * Retention API (phase 2 row 2.18; PLAN 5.9 "Retention").
 *
 *   /retention-policies                     CRUD (kernel CRUD factory, `platform.retention_policy.*`)
 *   POST /retention-policies/{id}/dry-run   count what the policy would affect now; writes one
 *                                           run row, changes no data (`platform.retention_policy.dry_run`)
 *   GET  /retention-runs?policyId=          the insert-only run log (`platform.retention_run.read`)
 *
 * Rules on top of the plain permissions, and why (see the safety rules in
 * ./retention-service.ts):
 *   1. A policy can never name audit, ledger (gl), journal or payroll data: 400 here, and a
 *      CHECK in the database behind it.
 *   2. A new policy is always `dry_run`. Switching it to `live` is refused until a module
 *      has registered a retention target for the entity type (422 `retention_no_target`).
 *   3. The entity key never changes after creation (runs and legal basis refer to it).
 *   4. There is no run endpoint that changes data: only the dry run is exposed.
 *
 * Depends on: express, zod, kernel/db, kernel/http, kernel/permissions, ./retention-service.
 * Used by: src/main.ts, the recycle bin (policy repository).
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { Router } from 'express';
import { z } from 'zod';
import { createRepository, MAX_PAGE_SIZE, type Repository } from '../db/repository.js';
import type { UnitOfWork } from '../db/unit-of-work.js';
import { createCrudRouter } from '../http/crud-router.js';
import { UnprocessableError } from '../http/errors.js';
import { problemSchema, registerRoute } from '../http/openapi.js';
import type { PermissionService } from '../permissions/permission-service.js';
import {
  isProtectedEntityKey,
  type RetentionPolicyRow,
  type RetentionRunRow,
  type RetentionService,
} from './retention-service.js';

const entityKey = z
  .string()
  .trim()
  .regex(
    /^[a-z][a-z0-9_]{0,49}(\.[a-z][a-z0-9_]{0,49})?$/,
    'lower-case letters, digits, _ and one .',
  )
  .refine((key) => !isProtectedEntityKey(key), {
    message: 'Audit, ledger, journal and payroll data can never have a retention policy',
  });
const keepMonths = z.number().int().min(1).max(1200);
const action = z.enum(['archive', 'anonymise']);
const legalBasis = z.string().trim().min(1).max(2000);

const policyCreate = z.strictObject({
  entityKey,
  keepMonths,
  action,
  legalBasis,
  active: z.boolean().default(true),
});
const policyUpdate = z
  .strictObject({
    keepMonths,
    action,
    legalBasis,
    mode: z.enum(['dry_run', 'live']),
    active: z.boolean(),
  })
  .partial();
const policyItem = z
  .object({
    id: z.uuid(),
    entityKey: z.string(),
    keepMonths: z.number().int(),
    action: z.string(),
    legalBasis: z.string(),
    mode: z.string(),
    active: z.boolean(),
    version: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    deletedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'RetentionPolicy' });
const toPolicyItem = (row: RetentionPolicyRow): z.infer<typeof policyItem> => ({
  id: row.id,
  entityKey: row.entityKey,
  keepMonths: row.keepMonths,
  action: row.action,
  legalBasis: row.legalBasis,
  mode: row.mode,
  active: row.active,
  version: row.version,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  deletedAt: row.deletedAt?.toISOString() ?? null,
});

const runItem = z
  .object({
    id: z.uuid(),
    policyId: z.uuid(),
    runAt: z.iso.datetime(),
    dryRun: z.boolean(),
    status: z.string(),
    rowsAffected: z.number().int(),
    archiveFileId: z.uuid().nullable(),
    note: z.string().nullable(),
  })
  .meta({ id: 'RetentionRun' });
const toRunItem = (row: RetentionRunRow): z.infer<typeof runItem> => ({
  id: row.id,
  policyId: row.policyId,
  runAt: row.runAt.toISOString(),
  dryRun: row.dryRun,
  status: row.status,
  rowsAffected: row.rowsAffected,
  archiveFileId: row.archiveFileId,
  note: row.note,
});
const runList = z.object({
  policyId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
});
const idParams = z.object({ id: z.uuid() });

/** The repository behind `/retention-policies` and the recycle bin; adds rule 2. */
export function createRetentionPolicyRepository(
  retention?: RetentionService,
): Repository<RetentionPolicyRow> {
  const base = createRepository<RetentionPolicyRow>({ model: 'retentionPolicy', scope: 'tenant' });
  return {
    ...base,
    update: async (id, version, changes) => {
      if (changes.mode === 'live') {
        const current = await base.get(id);
        if (!retention?.hasTarget(current.entityKey)) {
          throw new UnprocessableError(
            'retention_no_target',
            'No module has registered this record type for retention, so it cannot go live',
          );
        }
      }
      return base.update(id, version, changes);
    },
  };
}

export interface RetentionRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  retention: RetentionService;
}

export function createRetentionRouter(deps: RetentionRouterDeps): Router {
  const { uow, registry, permissions, retention } = deps;
  const router = Router();
  const crud = { uow, authorize: permissions.authorize, registry };

  router.use(
    createCrudRouter<RetentionPolicyRow>(crud, {
      path: '/retention-policies',
      resource: 'platform.retention_policy',
      tag: 'Retention',
      repository: createRetentionPolicyRepository(retention),
      schemas: { create: policyCreate, update: policyUpdate, item: policyItem },
      toItem: toPolicyItem,
    }),
  );

  router.post('/retention-policies/:id/dry-run', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const run = await uow.run(async () => {
      await permissions.authorize('platform.retention_policy.dry_run');
      return retention.dryRunById(id);
    });
    res.status(201).json(toRunItem(run));
  });
  registerRoute(registry, {
    method: 'post',
    path: '/retention-policies/{id}/dry-run',
    tags: ['Retention'],
    summary: 'Count what a policy would affect now (changes no data; writes one run row)',
    request: { params: idParams },
    responses: {
      201: { description: 'The run', content: { 'application/json': { schema: runItem } } },
      404: {
        description: 'No such policy',
        content: { 'application/problem+json': { schema: problemSchema } },
      },
    },
  });

  router.get('/retention-runs', async (req, res) => {
    const query = runList.parse(req.query);
    const page = await uow.run(async (db) => {
      await permissions.authorize('platform.retention_run.read');
      const where = query.policyId === undefined ? {} : { policyId: query.policyId };
      const [rows, total] = await Promise.all([
        db.retentionRun.findMany({
          where,
          orderBy: [{ runAt: 'desc' }, { id: 'desc' }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
        db.retentionRun.count({ where }),
      ]);
      return { items: rows.map(toRunItem), total, page: query.page, pageSize: query.pageSize };
    });
    res.json(page);
  });
  registerRoute(registry, {
    method: 'get',
    path: '/retention-runs',
    tags: ['Retention'],
    summary: 'The retention run log, newest first',
    request: { query: runList },
    responses: {
      200: {
        description: 'A page of runs',
        content: {
          'application/json': {
            schema: z.object({ items: z.array(runItem), total: z.number().int() }),
          },
        },
      },
    },
  });

  return router;
}
