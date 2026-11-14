/**
 * Audit and recycle-bin endpoints (docs/PLAN.md section 5.5).
 *
 *   GET  /audit-log                               Activity Log: filters, newest first
 *   GET  /audit-log/export                        the same filters as a CSV file (logged)
 *   GET  /audit-log/verify                        recompute the tamper-evidence hash chain
 *   GET  /history/{entityType}/{entityId}         every change of one record (History tab)
 *   GET  /recycle-bin?module=&entityType=         deleted records per type
 *   POST /recycle-bin/{entityType}/{id}/restore   restore one
 *
 * Every handler validates its input, opens a unit of work (which sets the row-level
 * security context) and asks the permission layer before touching data, in that order.
 * Permission keys: audit.log.read, audit.log.export, audit.log.verify, recycle_bin.view,
 * recycle_bin.restore.
 *
 * Depends on: express, zod, ./audit-service.ts, ./recycle-bin.ts, ../db/unit-of-work.ts,
 * ../http/openapi.ts, ../http/crud-router.ts (the Authorize type).
 * Used by: src/main.ts once authentication exists (commit 7).
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { Router } from 'express';
import { z } from 'zod';
import type { UnitOfWork } from '../db/unit-of-work.js';
import type { Authorize } from '../http/crud-router.js';
import { problemSchema, registerRoute } from '../http/openapi.js';
import { AUDIT_MAX_PAGE_SIZE, type AuditFilter, type AuditService } from './audit-service.js';
import type { RecycleBin } from './recycle-bin.js';

export interface AuditRouterDeps {
  uow: UnitOfWork;
  authorize: Authorize;
  registry: OpenAPIRegistry;
  audit: AuditService;
  recycleBin: RecycleBin;
}

const entityType = z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/, {
  message: 'Use the form module.record, for example platform.branch',
});

const paging = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(AUDIT_MAX_PAGE_SIZE).default(50),
};

const filterShape = {
  userId: z.uuid().optional(),
  module: z.string().min(1).max(63).optional(),
  action: z.string().min(1).max(40).optional(),
  entityType: entityType.optional(),
  entityId: z.uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
};

const listQuery = z.object({ ...paging, ...filterShape });
const exportQuery = z.object({ ...filterShape, format: z.literal('csv').default('csv') });
const historyParams = z.object({ entityType, entityId: z.uuid() });
const recycleQuery = z.object({
  ...paging,
  module: z.string().min(1).max(63).optional(),
  entityType: entityType.optional(),
});
const restoreParams = z.object({ entityType, id: z.uuid() });

const auditEntry = z
  .object({
    id: z.uuid(),
    at: z.iso.datetime(),
    seq: z.number().int().nullable(),
    userId: z.uuid().nullable(),
    impersonatorId: z.uuid().nullable(),
    roleKeys: z.array(z.string()),
    ip: z.string().nullable(),
    requestId: z.string().nullable(),
    companyId: z.uuid().nullable(),
    moduleKey: z.string(),
    entityType: z.string(),
    entityId: z.uuid().nullable(),
    action: z.string(),
    diff: z.unknown(),
    meta: z.unknown(),
  })
  .meta({ id: 'AuditEntry' });

const auditPage = z
  .object({
    items: z.array(auditEntry),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
  })
  .meta({ id: 'AuditPage' });

const verification = z
  .object({
    ok: z.boolean(),
    sealsChecked: z.number().int(),
    rowsChecked: z.number().int(),
    unsealedRows: z.number().int(),
    failedSealId: z.uuid().nullable(),
    failedFromSeq: z.number().int().nullable(),
    failure: z.string().nullable(),
  })
  .meta({ id: 'AuditChainVerification' });

const recycleItem = z
  .object({
    entityType: z.string(),
    id: z.uuid(),
    description: z.string(),
    deletedAt: z.iso.datetime().nullable(),
    deletedBy: z.uuid().nullable(),
    deleteReason: z.string().nullable(),
    version: z.number().int(),
  })
  .meta({ id: 'RecycleBinItem' });

const recycleResponse = z
  .object({
    types: z.array(
      z.object({
        entityType: z.string(),
        moduleKey: z.string(),
        label: z.string(),
        count: z.number().int(),
      }),
    ),
    items: z.array(recycleItem),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
  })
  .meta({ id: 'RecycleBin' });

function toFilter(query: z.infer<typeof exportQuery> | z.infer<typeof listQuery>): AuditFilter {
  return {
    userId: query.userId,
    moduleKey: query.module,
    action: query.action,
    entityType: query.entityType,
    entityId: query.entityId,
    from: query.from,
    to: query.to,
  };
}

export function createAuditRouter(deps: AuditRouterDeps): Router {
  const { uow, authorize, registry, audit, recycleBin } = deps;
  const router = Router();

  /** Runs `work` inside a unit of work, after the permission check. */
  const perform = <T>(permission: string, work: () => Promise<T>): Promise<T> =>
    uow.run(async () => {
      await authorize(permission);
      return work();
    });

  router.get('/audit-log', async (req, res) => {
    const query = listQuery.parse(req.query);
    res.json(
      await perform('audit.log.read', () =>
        audit.list(toFilter(query), query.page, query.pageSize),
      ),
    );
  });

  router.get('/audit-log/export', async (req, res) => {
    const query = exportQuery.parse(req.query);
    const result = await perform('audit.log.export', () => audit.exportCsv(toFilter(query)));
    res
      .status(200)
      .setHeader('Content-Type', 'text/csv; charset=utf-8')
      .setHeader('Content-Disposition', 'attachment; filename="audit-log.csv"')
      .send(result.csv);
  });

  router.get('/audit-log/verify', async (_req, res) => {
    res.json(await perform('audit.log.verify', () => audit.verify()));
  });

  router.get('/history/:entityType/:entityId', async (req, res) => {
    const params = historyParams.parse(req.params);
    const query = z.object(paging).parse(req.query);
    res.json(
      await perform('audit.log.read', () =>
        audit.history(params.entityType, params.entityId, query.page, query.pageSize),
      ),
    );
  });

  router.get('/recycle-bin', async (req, res) => {
    const query = recycleQuery.parse(req.query);
    res.json(
      await perform('recycle_bin.view', async () => {
        const types = await recycleBin.summary(query.module);
        // Records are listed for one type at a time; without a type the caller gets the
        // per-type counts and picks one.
        const page =
          query.entityType === undefined
            ? { items: [], total: 0, page: query.page, pageSize: query.pageSize }
            : await recycleBin.list(query.entityType, query.page, query.pageSize);
        return { types, ...page };
      }),
    );
  });

  router.post('/recycle-bin/:entityType/:id/restore', async (req, res) => {
    const params = restoreParams.parse(req.params);
    res.json(
      await perform('recycle_bin.restore', () => recycleBin.restore(params.entityType, params.id)),
    );
  });

  // ---- OpenAPI ------------------------------------------------------------------------
  const json = (description: string, schema: z.ZodType) => ({
    description,
    content: { 'application/json': { schema } },
  });
  const problem = (description: string) => ({
    description,
    content: { 'application/problem+json': { schema: problemSchema } },
  });
  const filterQuery = z.object({
    userId: z.uuid().optional(),
    module: z.string().optional(),
    action: z.string().optional(),
    entityType: z.string().optional(),
    entityId: z.uuid().optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
  });
  const pageQuery = z.object({
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(AUDIT_MAX_PAGE_SIZE).optional(),
  });

  registerRoute(registry, {
    method: 'get',
    path: '/audit-log',
    tags: ['Audit'],
    summary: 'Activity log, newest first',
    request: { query: filterQuery.extend(pageQuery.shape) },
    responses: { 200: json('One page of audit entries', auditPage) },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/audit-log/export',
    tags: ['Audit'],
    summary: 'Export the filtered activity log as CSV (the export is logged)',
    request: { query: filterQuery.extend({ format: z.literal('csv').optional() }) },
    responses: {
      200: { description: 'CSV file', content: { 'text/csv': { schema: z.string() } } },
      422: problem('More rows than one export allows; narrow the filters'),
    },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/audit-log/verify',
    tags: ['Audit'],
    summary: 'Check the tamper-evidence hash chain of the audit log',
    responses: { 200: json('Result of the check', verification) },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/history/{entityType}/{entityId}',
    tags: ['Audit'],
    summary: 'Every recorded change of one record, newest first',
    request: { params: historyParams, query: pageQuery },
    responses: { 200: json('One page of audit entries', auditPage) },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/recycle-bin',
    tags: ['Recycle bin'],
    summary: 'Deleted records: counts per type, and the records of one type',
    request: {
      query: pageQuery.extend({
        module: z.string().optional(),
        entityType: z.string().optional(),
      }),
    },
    responses: { 200: json('Recycle bin', recycleResponse), 404: problem('Unknown record type') },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/recycle-bin/{entityType}/{id}/restore',
    tags: ['Recycle bin'],
    summary: 'Restore a deleted record',
    request: { params: restoreParams },
    responses: {
      200: json('The restored record', recycleItem),
      404: problem('Not found, not deleted, or not visible to you'),
      409: problem('A live record already uses the same unique value'),
    },
  });

  return router;
}
