/**
 * Report API (phase 2 row 2.13; PLAN 5.9 "Reports").
 *
 *   GET    /reports                    reports the caller may open (their own permission)
 *   GET    /reports/{key}/meta         columns and filters of one report
 *   POST   /reports/{key}/run          one page of rows (filters, sort, page)
 *   POST   /reports/{key}/export       CSV, Excel or PDF file (`platform.report.export` too);
 *                                      answers with a file id for the audited download
 *   /saved-reports                     CRUD of a person's saved filters and columns
 *
 * Saved reports belong to their owner. The owner may share one with named users: they can
 * open and run it, but still need the report's own permission to see any rows, and only the
 * owner may change, delete or restore it. Someone with no access gets 404, not 403, so a
 * saved report's existence is not revealed.
 *
 * Depends on: express, zod, @fibrex/shared (report schemas), kernel/http, kernel/db,
 * ./report-service.ts. Used by: src/main.ts.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  checkReportFilters,
  MAX_REPORT_PAGE_SIZE,
  reportExportSchema,
  reportRunSchema,
  savedReportFormSchema,
} from '@fibrex/shared';
import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import type { Db } from '../db/prisma.js';
import { createRepository, type Repository } from '../db/repository.js';
import { currentUnit, type UnitOfWork } from '../db/unit-of-work.js';
import { createCrudRouter } from '../http/crud-router.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../http/errors.js';
import { registerRoute } from '../http/openapi.js';
import type { ReportDef as ReportDefinition } from '../module-registry/manifest.js';
import type { PermissionService } from '../permissions/permission-service.js';
import type { ReportService } from './report-service.js';

type SavedReportRow = NonNullable<Awaited<ReturnType<Db['savedReport']['findFirst']>>>;

export interface ReportRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  reports: ReportService;
}

const keyParams = z.object({ key: z.string().min(1).max(100) });
const columnSpec = z.object({
  key: z.string(),
  label: z.string(),
  type: z.string(),
  sortable: z.boolean().optional(),
});
const filterSpec = z.object({
  key: z.string(),
  label: z.string(),
  type: z.string(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  lookup: z.string().optional(),
});
const reportListItem = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string(),
  moduleKey: z.string(),
});
const reportMeta = reportListItem.extend({
  columns: z.array(columnSpec),
  filters: z.array(filterSpec),
  maxPageSize: z.number().int(),
});
const runResult = z.object({
  rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
const exportResult = z.object({
  fileId: z.uuid(),
  fileName: z.string(),
  format: z.enum(['csv', 'xlsx', 'pdf']),
  rowCount: z.number().int(),
});

const savedUpdate = savedReportFormSchema
  .pick({ name: true, filters: true, columns: true, sharedWith: true })
  .partial();
const savedItem = z
  .object({
    id: z.uuid(),
    reportKey: z.string(),
    ownerUserId: z.uuid(),
    name: z.string(),
    filters: z.record(z.string(), z.string()),
    columns: z.array(z.string()),
    sharedWith: z.array(z.string()),
    version: z.number().int(),
    deletedAt: z.string().nullable(),
  })
  .meta({ id: 'SavedReport' });

const asStrings = (value: Prisma.JsonValue): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

function toItem(row: SavedReportRow) {
  const filters: Record<string, string> = {};
  if (row.filters !== null && typeof row.filters === 'object' && !Array.isArray(row.filters)) {
    for (const [k, v] of Object.entries(row.filters)) if (typeof v === 'string') filters[k] = v;
  }
  return {
    id: row.id,
    reportKey: row.reportKey,
    ownerUserId: row.ownerUserId,
    name: row.name,
    filters,
    columns: asStrings(row.columns),
    sharedWith: asStrings(row.sharedWith),
    version: row.version,
    deletedAt: row.deletedAt === null ? null : row.deletedAt.toISOString(),
  };
}

export function createReportRouter(deps: ReportRouterDeps): Router {
  const { uow, registry, permissions, reports } = deps;
  const router = Router();
  const tags = ['Reports'];

  const describe = (def: ReportDefinition) => ({
    key: def.key,
    label: def.label,
    description: def.description ?? '',
    moduleKey: def.key.split('.')[0] ?? def.key,
  });

  router.get('/reports', async (_req, res) => {
    const items = await uow.run(async () => (await reports.list()).map(describe));
    res.json({ items });
  });
  registerRoute(registry, {
    method: 'get',
    path: '/reports',
    tags,
    summary: 'Reports the caller may open',
    responses: {
      200: {
        description: 'Reports',
        content: { 'application/json': { schema: z.object({ items: z.array(reportListItem) }) } },
      },
    },
  });

  router.get('/reports/:key/meta', async (req, res) => {
    const { key } = keyParams.parse(req.params);
    const def = await uow.run(() => reports.open(key));
    res.json({
      ...describe(def),
      columns: def.columns,
      filters: def.filters,
      maxPageSize: MAX_REPORT_PAGE_SIZE,
    });
  });
  registerRoute(registry, {
    method: 'get',
    path: '/reports/{key}/meta',
    tags,
    summary: 'Columns and filters of a report',
    request: { params: keyParams },
    responses: {
      200: { description: 'Report', content: { 'application/json': { schema: reportMeta } } },
    },
  });

  router.post('/reports/:key/run', async (req, res) => {
    const { key } = keyParams.parse(req.params);
    const body = reportRunSchema.parse(req.body ?? {});
    const result = await uow.run(() => reports.run(key, body, body.page, body.pageSize));
    res.json({ ...result, page: body.page, pageSize: body.pageSize });
  });
  registerRoute(registry, {
    method: 'post',
    path: '/reports/{key}/run',
    tags,
    summary: 'Run a report: one page of rows',
    request: {
      params: keyParams,
      body: { content: { 'application/json': { schema: reportRunSchema } } },
    },
    responses: {
      200: { description: 'Rows', content: { 'application/json': { schema: runResult } } },
    },
  });

  router.post('/reports/:key/export', async (req, res) => {
    const { key } = keyParams.parse(req.params);
    const body = reportExportSchema.parse(req.body ?? {});
    const result = await uow.run(() => reports.export(key, body, body.format, body.companyId));
    res.status(201).json(result);
  });
  registerRoute(registry, {
    method: 'post',
    path: '/reports/{key}/export',
    tags,
    summary: 'Export a report to CSV, Excel or PDF; download with /files/{fileId}/download-url',
    request: {
      params: keyParams,
      body: { content: { 'application/json': { schema: reportExportSchema } } },
    },
    responses: {
      201: {
        description: 'The stored file',
        content: { 'application/json': { schema: exportResult } },
      },
    },
  });

  // ---- Saved reports -------------------------------------------------------------------

  const base = createRepository<SavedReportRow>({ model: 'savedReport', scope: 'tenant' });
  const me = (): string => {
    const id = currentUnit().context.userId;
    if (id === undefined) throw new ForbiddenError('Saved reports belong to a signed-in person');
    return id;
  };
  const visibleTo = (row: SavedReportRow, userId: string): boolean =>
    row.ownerUserId === userId || asStrings(row.sharedWith).includes(userId);

  /** Filters and columns must exist on the report, so a saved report never fails later. */
  const checkContent = (def: ReportDefinition, data: { filters?: unknown; columns?: unknown }) => {
    const issues = [];
    if (data.filters !== undefined) {
      const checked = checkReportFilters(def.filters, data.filters as Record<string, string>);
      for (const p of checked.problems) {
        issues.push({ path: `filters.${p.key}`, message: p.message, code: 'invalid_filter' });
      }
    }
    if (Array.isArray(data.columns)) {
      for (const column of data.columns as string[]) {
        if (!def.columns.some((c) => c.key === column)) {
          issues.push({ path: 'columns', message: `No column ${column}`, code: 'invalid_column' });
        }
      }
    }
    if (issues.length > 0) throw new ValidationError(issues);
  };
  /** A row the caller owns; 404 for one they cannot see, 403 for one only shared with them. */
  const owned = async (id: string): Promise<SavedReportRow> => {
    const row = await base.get(id);
    const userId = me();
    if (!visibleTo(row, userId)) throw new NotFoundError();
    if (row.ownerUserId !== userId) {
      throw new ForbiddenError('Only the owner can change a saved report');
    }
    return row;
  };

  const repository: Repository<SavedReportRow> = {
    list: (options) => {
      const userId = me();
      const mine = { ownerUserId: userId };
      // The recycle bin shows only the caller's own; the live list adds what is shared with them.
      const scope =
        options.deleted === true
          ? mine
          : { OR: [mine, { sharedWith: { array_contains: [userId] } }] };
      return base.list({ ...options, where: { ...(options.where ?? {}), ...scope } });
    },
    get: async (id) => {
      const row = await base.get(id);
      if (!visibleTo(row, me())) throw new NotFoundError();
      return row;
    },
    create: async (data) => {
      const form = data as z.infer<typeof savedReportFormSchema>;
      // The caller must be able to open the report, and its filters and columns must exist.
      const def = await reports.open(form.reportKey);
      checkContent(def, form);
      return base.create({ ...form, ownerUserId: me() });
    },
    update: async (id, version, changes) => {
      const row = await owned(id);
      checkContent(reports.find(row.reportKey), changes);
      return base.update(id, version, changes);
    },
    softDelete: async (id, version, reason) => {
      await owned(id);
      return base.softDelete(id, version, reason);
    },
    restore: async (id, version) => {
      const gone = await currentUnit().db.savedReport.findFirst({
        where: { id, ownerUserId: me(), deletedAt: { not: null } },
        select: { id: true },
      });
      if (gone === null) throw new NotFoundError();
      return base.restore(id, version);
    },
  };

  router.use(
    createCrudRouter<SavedReportRow>(
      { uow, authorize: permissions.authorize, registry },
      {
        path: '/saved-reports',
        resource: 'platform.saved_report',
        tag: 'Reports',
        repository,
        schemas: {
          create: savedReportFormSchema,
          update: savedUpdate,
          item: savedItem,
          filter: z.object({ reportKey: z.string().optional() }),
        },
        toItem,
        toWhere: (filter) =>
          filter.reportKey === undefined ? {} : { reportKey: filter.reportKey },
      },
    ),
  );

  return router;
}
