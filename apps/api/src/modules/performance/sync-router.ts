/**
 * Sync API (phase 4 row 4.3; PLAN 5.13).
 *
 *   POST /sync-sources/{id}/run        Run now (body: optional readOn)
 *   POST /sync-sources/{id}/reimport   Re-import a date range (body: from, to)
 *   POST /sync-sources/{id}/upload     A day's Excel file (body: fileObjectId, readOn)
 *   GET  /sync-runs                    run log (filter by source, status)
 *   GET  /sync-runs/{id}               one run
 *   GET  /sync-runs/{id}/errors        what went wrong, by sheet row
 *   GET  /sync-runs/{id}/raw           the raw snapshot the run read (download it through
 *                                      /files/{fileObjectId}/download-url)
 *
 * The three POST routes only check the request and queue the run (202): the run itself
 * happens in the sync queue's worker (./sync-queue.ts), the same path as the 04:00 job, as
 * the person who clicked. The run then shows in GET /sync-runs. The file of an upload comes
 * through the normal signed upload (`/files/uploads`), like every other file.
 *
 * Sources, column mappings, "test" and the unmatched queue actions arrive with rows 4.4 and
 * 4.5.
 *
 * Depends on: express, zod, kernel/db, kernel/http, kernel/permissions, ./sync-service.ts,
 * ./sync-queue.ts. Used by: ./index.ts.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { Router } from 'express';
import { z } from 'zod';
import { currentUnit, type UnitOfWork } from '../../kernel/db/unit-of-work.js';
import { NotFoundError, ValidationError } from '../../kernel/http/errors.js';
import { registerRoute } from '../../kernel/http/openapi.js';
import type { PermissionService } from '../../kernel/permissions/permission-service.js';
import { addDays } from './cycle.js';
import type { SyncQueue } from './sync-queue.js';
import type { SyncRequest, SyncService } from './sync-service.js';

/** Longest range one re-import may cover (two Snoonu cycles). */
const MAX_REIMPORT_DAYS = 62;

const idParams = z.object({ id: z.uuid() });
const runBody = z.object({ readOn: z.iso.date().optional() });
const reimportBody = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  readOn: z.iso.date().optional(),
});
const uploadBody = z.object({
  fileObjectId: z.uuid(),
  /** The day the file was downloaded; it holds figures up to the day before. */
  readOn: z.iso.date(),
});
const queuedResponse = z
  .object({ queued: z.literal(true), jobId: z.string(), syncSourceId: z.uuid() })
  .meta({ id: 'SyncQueued' });
const runList = z.object({
  syncSourceId: z.uuid().optional(),
  status: z.enum(['running', 'succeeded', 'partial', 'failed']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
const errorList = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(100),
});

const runItem = z
  .object({
    id: z.uuid(),
    companyId: z.uuid(),
    syncSourceId: z.uuid(),
    businessDate: z.iso.date(),
    trigger: z.enum(['scheduled', 'manual', 'reimport', 'upload']),
    status: z.enum(['running', 'succeeded', 'partial', 'failed']),
    rangeFrom: z.iso.date().nullable(),
    rangeTo: z.iso.date().nullable(),
    rowsRead: z.number().int(),
    matched: z.number().int(),
    unmatched: z.number().int(),
    errorsCount: z.number().int(),
    rawInputId: z.uuid().nullable(),
    snapshotReused: z.boolean(),
    layoutChanged: z.boolean(),
    supersededByRunId: z.uuid().nullable(),
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
    createdBy: z.uuid().nullable(),
  })
  .meta({ id: 'SyncRun' });
const runDetail = runItem
  .extend({ storedDates: z.array(z.object({ date: z.iso.date(), rows: z.number().int() })) })
  .meta({ id: 'SyncRunDetail' });
const runPage = z
  .object({
    items: z.array(runItem),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
  })
  .meta({ id: 'SyncRunPage' });
const errorItem = z
  .object({
    id: z.uuid(),
    rowNo: z.number().int().nullable(),
    code: z.string(),
    message: z.string(),
  })
  .meta({ id: 'SyncRunError' });
const errorPage = z
  .object({
    items: z.array(errorItem),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
  })
  .meta({ id: 'SyncRunErrorPage' });
const rawItem = z
  .object({
    id: z.uuid(),
    kind: z.string(),
    sha256: z.string(),
    receivedAt: z.string(),
    fileObjectId: z.uuid().nullable(),
    reused: z.boolean(),
    meta: z.record(z.string(), z.unknown()),
  })
  .meta({ id: 'SyncRunRaw' });

const day = (value: Date | null) => (value === null ? null : value.toISOString().slice(0, 10));

interface RunRow {
  id: string;
  companyId: string;
  syncSourceId: string;
  businessDate: Date;
  trigger: string;
  status: string;
  rangeFrom: Date | null;
  rangeTo: Date | null;
  rowsRead: number;
  matched: number;
  unmatched: number;
  errorsCount: number;
  rawInputId: string | null;
  snapshotReused: boolean;
  layoutChanged: boolean;
  supersededByRunId: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  createdBy: string | null;
}

function toRunItem(row: RunRow) {
  return {
    id: row.id,
    companyId: row.companyId,
    syncSourceId: row.syncSourceId,
    businessDate: day(row.businessDate) ?? '',
    trigger: row.trigger,
    status: row.status,
    rangeFrom: day(row.rangeFrom),
    rangeTo: day(row.rangeTo),
    rowsRead: row.rowsRead,
    matched: row.matched,
    unmatched: row.unmatched,
    errorsCount: row.errorsCount,
    rawInputId: row.rawInputId,
    snapshotReused: row.snapshotReused,
    layoutChanged: row.layoutChanged,
    supersededByRunId: row.supersededByRunId,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    createdBy: row.createdBy,
  };
}

export interface SyncRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  service: SyncService;
  queue: SyncQueue;
}

export function createSyncRouter(deps: SyncRouterDeps): Router {
  const { uow, registry, permissions, service, queue } = deps;
  const router = Router();

  /** Checks the request in a unit of work, then queues it (after the commit). */
  async function queueRun(sourceId: string, request: SyncRequest) {
    const checked = await uow.run(async (db) => {
      await permissions.require('performance.sync_run.run');
      await service.validateRequest(request);
      const source = await db.syncSource.findFirst({
        where: { id: sourceId },
        select: { tenantId: true, companyId: true },
      });
      if (source === null) throw new NotFoundError();
      return { ...source, userId: currentUnit().context.userId };
    });
    const jobId = await queue.enqueue({
      tenantId: checked.tenantId,
      companyId: checked.companyId,
      userId: checked.userId,
      request,
    });
    return { queued: true as const, jobId, syncSourceId: sourceId };
  }

  router.post('/sync-sources/:id/run', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const body = runBody.parse(req.body ?? {});
    res.status(202).json(
      await queueRun(id, {
        syncSourceId: id,
        trigger: 'manual',
        ...(body.readOn === undefined ? {} : { readOn: body.readOn }),
      }),
    );
  });

  router.post('/sync-sources/:id/reimport', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const body = reimportBody.parse(req.body);
    if (body.from > body.to) {
      throw new ValidationError([
        { path: 'to', code: 'range_order', message: 'The range must end on or after its start.' },
      ]);
    }
    if (addDays(body.from, MAX_REIMPORT_DAYS - 1) < body.to) {
      throw new ValidationError([
        {
          path: 'to',
          code: 'range_too_long',
          message: `A re-import covers at most ${String(MAX_REIMPORT_DAYS)} days.`,
        },
      ]);
    }
    res.status(202).json(
      await queueRun(id, {
        syncSourceId: id,
        trigger: 'reimport',
        range: { from: body.from, to: body.to },
        ...(body.readOn === undefined ? {} : { readOn: body.readOn }),
      }),
    );
  });

  router.post('/sync-sources/:id/upload', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const body = uploadBody.parse(req.body);
    res.status(202).json(
      await queueRun(id, {
        syncSourceId: id,
        trigger: 'upload',
        fileObjectId: body.fileObjectId,
        readOn: body.readOn,
      }),
    );
  });

  router.get('/sync-runs', async (req, res) => {
    const query = runList.parse(req.query);
    const page = await uow.run(async (db) => {
      await permissions.require('performance.sync_run.read');
      const where = {
        deletedAt: null,
        ...(query.syncSourceId === undefined ? {} : { syncSourceId: query.syncSourceId }),
        ...(query.status === undefined ? {} : { status: query.status }),
      };
      const [items, total] = await Promise.all([
        db.syncRun.findMany({
          where,
          orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
        db.syncRun.count({ where }),
      ]);
      return { items: items.map(toRunItem), total, page: query.page, pageSize: query.pageSize };
    });
    res.json(page);
  });

  async function findRun(id: string) {
    const { db } = currentUnit();
    await permissions.require('performance.sync_run.read');
    const run = await db.syncRun.findFirst({ where: { id, deletedAt: null } });
    if (run === null) throw new NotFoundError();
    return run;
  }

  router.get('/sync-runs/:id', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const detail = await uow.run(async (db) => {
      const run = await findRun(id);
      // Which business dates this run stored figures for (a re-import stores several).
      const stored = await db.dailyPerformance.groupBy({
        by: ['businessDate'],
        where: { syncRunId: id },
        _count: { _all: true },
        orderBy: { businessDate: 'asc' },
      });
      return {
        ...toRunItem(run),
        storedDates: stored.map((s) => ({ date: day(s.businessDate) ?? '', rows: s._count._all })),
      };
    });
    res.json(detail);
  });

  router.get('/sync-runs/:id/errors', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const query = errorList.parse(req.query);
    const page = await uow.run(async (db) => {
      await findRun(id);
      const where = { syncRunId: id };
      const [items, total] = await Promise.all([
        db.syncRunError.findMany({
          where,
          orderBy: [{ rowNo: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
        db.syncRunError.count({ where }),
      ]);
      return {
        items: items.map((e) => ({ id: e.id, rowNo: e.rowNo, code: e.code, message: e.message })),
        total,
        page: query.page,
        pageSize: query.pageSize,
      };
    });
    res.json(page);
  });

  router.get('/sync-runs/:id/raw', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const raw = await uow.run(async (db) => {
      const run = await findRun(id);
      if (run.rawInputId === null) throw new NotFoundError();
      const row = await db.rawInput.findFirst({ where: { id: run.rawInputId } });
      if (row === null) throw new NotFoundError();
      return {
        id: row.id,
        kind: row.kind,
        sha256: row.sha256,
        receivedAt: row.receivedAt.toISOString(),
        fileObjectId: row.fileObjectId,
        reused: run.snapshotReused,
        meta: row.meta as Record<string, unknown>,
      };
    });
    res.json(raw);
  });

  const tags = ['Performance sync'];
  const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });
  const queued = { 202: { description: 'The run is queued', content: json(queuedResponse) } };
  registerRoute(registry, {
    method: 'post',
    path: '/sync-sources/{id}/run',
    tags,
    summary: 'Run a sync now (reads the configured source)',
    request: { params: idParams, body: { content: json(runBody) } },
    responses: queued,
  });
  registerRoute(registry, {
    method: 'post',
    path: '/sync-sources/{id}/reimport',
    tags,
    summary: 'Re-import a date range from the configured source',
    request: { params: idParams, body: { content: json(reimportBody) } },
    responses: queued,
  });
  registerRoute(registry, {
    method: 'post',
    path: '/sync-sources/{id}/upload',
    tags,
    summary: "Sync from an uploaded day's Excel file (same layout as the sheet)",
    request: { params: idParams, body: { content: json(uploadBody) } },
    responses: queued,
  });
  registerRoute(registry, {
    method: 'get',
    path: '/sync-runs',
    tags,
    summary: 'Sync runs, newest first',
    request: { query: runList },
    responses: { 200: { description: 'The runs', content: json(runPage) } },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/sync-runs/{id}',
    tags,
    summary: 'One sync run',
    request: { params: idParams },
    responses: {
      200: { description: 'The run and the dates it stored', content: json(runDetail) },
    },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/sync-runs/{id}/errors',
    tags,
    summary: 'Errors of a sync run',
    request: { params: idParams, query: errorList },
    responses: { 200: { description: 'The errors', content: json(errorPage) } },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/sync-runs/{id}/raw',
    tags,
    summary: 'The raw snapshot a sync run read',
    request: { params: idParams },
    responses: { 200: { description: 'The snapshot', content: json(rawItem) } },
  });
  return router;
}
