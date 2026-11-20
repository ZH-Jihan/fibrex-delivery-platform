/**
 * Import API (phase 2 plan row 2.8a): load a sheet into any record type.
 *
 *   GET  /import-targets/{entityKey}      the fields a mapping can fill
 *   POST /imports                         open a job from an uploaded CSV file
 *   GET  /imports, /imports/{id}          list and read jobs
 *   POST /imports/{id}/preview            apply a mapping (saved or written out), check every row
 *   GET  /imports/{id}/rows               the previewed rows with their problems
 *   POST /imports/{id}/commit             create the good rows in a background job
 *   POST /imports/{id}/rollback           soft-delete everything the import created
 *   /import-mappings                      CRUD of saved mappings (`integration.import_mapping.*`)
 *   POST /exports, GET /exports[/{id}]    bulk export to CSV or Excel (row 2.8b, ./export-service)
 *   Upload may be CSV or Excel (.xlsx); both are read into the same sheet shape.
 *
 * The permission to change a job is `integration.import_job.*`; on top of that the caller
 * must hold the target's own create permission (a custom type's `custom.<key>.create`), so
 * an import is never a way around the permissions of the record type itself. Those checks
 * are in the service, not here, so the worker and tests cannot skip them.
 *
 * Depends on: express, zod, kernel/http, ./import-service, ./import-queue. Used by: src/main.ts.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { importMappingSchema } from '@fibrex/shared';
import { Router } from 'express';
import { z } from 'zod';
import { createRepository } from '../db/repository.js';
import { currentUnit, type UnitOfWork } from '../db/unit-of-work.js';
import { createCrudRouter } from '../http/crud-router.js';
import { MAX_PAGE_SIZE } from '../db/repository.js';
import { ValidationError } from '../http/errors.js';
import { problemSchema, registerRoute } from '../http/openapi.js';
import type { PermissionService } from '../permissions/permission-service.js';
import type { ExportJobRow, ExportService } from './export-service.js';
import type { ImportQueue } from './import-queue.js';
import type { ImportJobRow, ImportRowRow, ImportService } from './import-service.js';
import type { ImportTargets } from './import-targets.js';
import { buildXlsx } from './xlsx-sheet.js';
import type { Db } from '../db/prisma.js';

export type MappingRow = NonNullable<Awaited<ReturnType<Db['importMapping']['findFirst']>>>;

/** The repository of saved mappings (also behind the recycle bin). */
export const createImportMappingRepository = () =>
  createRepository<MappingRow>({ model: 'importMapping', scope: 'tenant' });

const entityKey = z.string().regex(/^[a-z][a-z0-9_]{0,49}(\.[a-z][a-z0-9_]{0,49})?$/);

const mappingCreate = z.strictObject({
  entityKey,
  name: z.string().trim().min(1).max(200),
  columnMap: importMappingSchema.shape.columnMap,
  transforms: importMappingSchema.shape.transforms,
});
const mappingUpdate = z
  .strictObject({
    name: z.string().trim().min(1).max(200),
    columnMap: importMappingSchema.shape.columnMap,
    transforms: importMappingSchema.shape.transforms,
  })
  .partial();
const mappingItem = z
  .object({
    id: z.uuid(),
    entityKey: z.string(),
    name: z.string(),
    columnMap: z.record(z.string(), z.string()),
    transforms: z.record(z.string(), z.array(z.unknown())),
    version: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    deletedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'ImportMapping' });
const mappingFilter = z.object({ entityKey: entityKey.optional() });

const jobCreate = z.strictObject({
  entityKey,
  /** A file already uploaded through the signed upload (`/files`). */
  fileObjectId: z.uuid(),
  companyId: z.uuid().optional(),
});
const previewBody = z.strictObject({
  mappingId: z.uuid().optional(),
  mapping: importMappingSchema.optional(),
});
const commitBody = z.strictObject({ skipInvalid: z.boolean().default(false) });
const rollbackBody = z.strictObject({ reason: z.string().trim().min(3).max(500) });
const jobList = z.object({
  status: z
    .enum(['uploaded', 'previewed', 'queued', 'committed', 'rolled_back', 'failed'])
    .optional(),
  entityKey: entityKey.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
});
const rowList = z.object({
  onlyErrors: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(100),
});
const idParams = z.object({ id: z.uuid() });

const jobItem = z
  .object({
    id: z.uuid(),
    entityKey: z.string(),
    companyId: z.uuid(),
    rawInputId: z.uuid(),
    mappingId: z.uuid().nullable(),
    mapping: z.unknown().nullable(),
    status: z.string(),
    previewNo: z.number().int(),
    stats: z.record(z.string(), z.unknown()),
    version: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'ImportJob' });
const rowItem = z
  .object({
    rowNo: z.number().int(),
    raw: z.record(z.string(), z.unknown()),
    normalised: z.record(z.string(), z.unknown()),
    errors: z.array(z.object({ path: z.string(), code: z.string(), message: z.string() })),
  })
  .meta({ id: 'ImportRow' });
const targetItem = z
  .object({
    key: z.string(),
    label: z.string(),
    fields: z.array(z.object({ key: z.string(), label: z.string(), required: z.boolean() })),
  })
  .meta({ id: 'ImportTarget' });

export function toMappingItem(row: MappingRow) {
  return {
    id: row.id,
    entityKey: row.entityKey,
    name: row.name,
    columnMap: row.columnMap as Record<string, string>,
    transforms: row.transforms as Record<string, unknown[]>,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

export function toJobItem(row: ImportJobRow) {
  return {
    id: row.id,
    entityKey: row.entityKey,
    companyId: row.companyId,
    rawInputId: row.rawInputId,
    mappingId: row.mappingId,
    mapping: row.mapping,
    status: row.status,
    previewNo: row.previewNo,
    stats: row.stats as Record<string, unknown>,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const toRowItem = (row: ImportRowRow) => ({
  rowNo: row.rowNo,
  raw: row.raw as Record<string, unknown>,
  normalised: row.normalised as Record<string, unknown>,
  errors: row.errors as { path: string; code: string; message: string }[],
});

const exportCreate = z.strictObject({
  entityKey,
  format: z.enum(['csv', 'xlsx']),
  /** Exact field values to filter by, `field key -> value`. */
  filters: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,59}$/), z.string().max(500)).default({}),
  companyId: z.uuid().optional(),
});
const exportList = z.object({
  entityKey: entityKey.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
});
const exportItem = z
  .object({
    id: z.uuid(),
    entityKey: z.string(),
    format: z.string(),
    filters: z.record(z.string(), z.unknown()),
    status: z.string(),
    rowCount: z.number().int(),
    fileObjectId: z.uuid().nullable(),
    error: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'ExportJob' });

export function toExportItem(row: ExportJobRow) {
  return {
    id: row.id,
    entityKey: row.entityKey,
    format: row.format,
    filters: row.filters as Record<string, unknown>,
    status: row.status,
    rowCount: row.rowCount,
    fileObjectId: row.fileObjectId,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface ImportRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  service: ImportService;
  exports: ExportService;
  queue: ImportQueue;
  targets: ImportTargets;
}

export function createImportRouter(deps: ImportRouterDeps): Router {
  const { uow, registry, permissions, service, queue, targets } = deps;
  const exportService = deps.exports;
  const router = Router();
  const tags = ['Imports'];

  // Saved mappings: plain CRUD, plus a check that the record type can be imported at all.
  const mappings = createImportMappingRepository();
  router.use(
    createCrudRouter<MappingRow>(
      { uow, authorize: permissions.authorize, registry },
      {
        path: '/import-mappings',
        resource: 'integration.import_mapping',
        tag: 'Imports',
        repository: {
          ...mappings,
          create: async (data) => {
            await targets.resolve(String(data.entityKey));
            return mappings.create(data);
          },
        },
        schemas: {
          create: mappingCreate,
          update: mappingUpdate,
          item: mappingItem,
          filter: mappingFilter,
        },
        toItem: toMappingItem,
        toWhere: (filter) => filter,
      },
    ),
  );

  // Module targets (employees ...) the caller may import into; custom types come from
  // /entity-definitions. A target the caller lacks the permission for is left out.
  router.get('/import-targets', async (_req, res) => {
    const items = await uow.run(async () => {
      const allowed: { key: string; label: string }[] = [];
      for (const target of targets.listRegistered()) {
        try {
          await permissions.require(target.createPermission);
          allowed.push({ key: target.key, label: target.label });
        } catch {
          // Not allowed: the target is simply not offered.
        }
      }
      return allowed;
    });
    res.json({ items });
  });

  // The blank Excel template: one heading per field (required ones marked with *), plus the
  // target's example row. Sent as base64 so the web client's JSON call can carry it.
  router.get('/import-targets/:entityKey/template', async (req, res) => {
    const key = entityKey.parse(req.params.entityKey);
    const described = await uow.run(() => service.describeTarget(key));
    const target = await targets.resolve(key);
    const columns = described.fields.map((f) => f.label);
    const example: Record<string, string> = {};
    for (const field of described.fields) {
      const value = target.templateExample?.[field.key];
      if (value !== undefined) example[field.label] = value;
    }
    const file = await buildXlsx(
      described.label,
      columns,
      Object.keys(example).length > 0 ? [example] : [],
    );
    res.json({
      fileName: `${key.replace(/\./g, '-')}-import-template.xlsx`,
      contentBase64: file.toString('base64'),
    });
  });

  router.get('/import-targets/:entityKey', async (req, res) => {
    const key = entityKey.parse(req.params.entityKey);
    res.json(await uow.run(() => service.describeTarget(key)));
  });

  router.post('/imports', async (req, res) => {
    const body = jobCreate.parse(req.body);
    const job = await uow.run(() =>
      service.createJob({
        entityKey: body.entityKey,
        fileObjectId: body.fileObjectId,
        ...(body.companyId === undefined ? {} : { companyId: body.companyId }),
      }),
    );
    res.status(201).json(toJobItem(job));
  });

  router.get('/imports', async (req, res) => {
    const query = jobList.parse(req.query);
    const page = await uow.run(() =>
      service.list({
        page: query.page,
        pageSize: query.pageSize,
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.entityKey === undefined ? {} : { entityKey: query.entityKey }),
      }),
    );
    res.json({ ...page, items: page.items.map(toJobItem) });
  });

  router.get('/imports/:id', async (req, res) => {
    const { id } = idParams.parse(req.params);
    res.json(toJobItem(await uow.run(() => service.get(id))));
  });

  router.post('/imports/:id/preview', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const body = previewBody.parse(req.body);
    if ((body.mappingId === undefined) === (body.mapping === undefined)) {
      throw new ValidationError([
        {
          path: 'mapping',
          code: 'one_of',
          message: 'Send either mappingId or mapping, not both and not neither.',
        },
      ]);
    }
    const job = await uow.run(() =>
      service.preview(id, {
        ...(body.mappingId === undefined ? {} : { mappingId: body.mappingId }),
        ...(body.mapping === undefined ? {} : { mapping: body.mapping }),
      }),
    );
    res.json(toJobItem(job));
  });

  router.get('/imports/:id/rows', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const query = rowList.parse(req.query);
    const page = await uow.run(() => service.rows(id, query));
    res.json({ ...page, items: page.items.map(toRowItem) });
  });

  router.post('/imports/:id/commit', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const body = commitBody.parse(req.body);
    // The job is marked queued and the transaction ends BEFORE it is put on the queue, so
    // the worker can never pick it up while it still looks `previewed`.
    const { job, userId } = await uow.run(async () => ({
      job: await service.requestCommit(id, { skipInvalid: body.skipInvalid }),
      userId: currentUnit().context.userId,
    }));
    await queue.enqueue({
      tenantId: job.tenantId,
      companyId: job.companyId,
      userId,
      jobId: job.id,
    });
    res.status(202).json(toJobItem(job));
  });

  router.post('/imports/:id/rollback', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const body = rollbackBody.parse(req.body);
    res.json(toJobItem(await uow.run(() => service.rollback(id, body.reason))));
  });

  // Bulk export: the file is built in the request and downloaded from `/files/{id}/download-url`.
  router.post('/exports', async (req, res) => {
    const body = exportCreate.parse(req.body);
    const job = await uow.run(() =>
      exportService.run({
        entityKey: body.entityKey,
        format: body.format,
        filters: body.filters,
        ...(body.companyId === undefined ? {} : { companyId: body.companyId }),
      }),
    );
    res.status(201).json(toExportItem(job));
  });
  router.get('/exports', async (req, res) => {
    const query = exportList.parse(req.query);
    const page = await uow.run(() =>
      exportService.list({
        page: query.page,
        pageSize: query.pageSize,
        ...(query.entityKey === undefined ? {} : { entityKey: query.entityKey }),
      }),
    );
    res.json({ ...page, items: page.items.map(toExportItem) });
  });
  router.get('/exports/:id', async (req, res) => {
    const { id } = idParams.parse(req.params);
    res.json(toExportItem(await uow.run(() => exportService.get(id))));
  });

  const problem = (description: string) => ({
    description,
    content: { 'application/problem+json': { schema: problemSchema } },
  });
  const ok = (schema: z.ZodType, description = 'OK') => ({
    description,
    content: { 'application/json': { schema } },
  });
  const jobPage = z.object({
    items: z.array(jobItem),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
  });
  const rowPage = z.object({
    items: z.array(rowItem),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
  });
  const body = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });
  registerRoute(registry, {
    method: 'get',
    path: '/import-targets',
    tags,
    summary: 'Module record kinds (such as employees) the caller can import into',
    responses: {
      200: ok(z.object({ items: z.array(z.object({ key: z.string(), label: z.string() })) })),
    },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/import-targets/{entityKey}/template',
    tags,
    summary: 'A blank Excel import template (base64) with one heading per field',
    request: { params: z.object({ entityKey }) },
    responses: {
      200: ok(z.object({ fileName: z.string(), contentBase64: z.string() })),
      404: problem('This record type cannot be imported'),
    },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/import-targets/{entityKey}',
    tags,
    summary: 'The fields a mapping can fill for a record type',
    request: { params: z.object({ entityKey }) },
    responses: { 200: ok(targetItem), 404: problem('This record type cannot be imported') },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/imports',
    tags,
    summary: 'Open an import job from an uploaded CSV file (kept as a raw input)',
    request: { body: body(jobCreate) },
    responses: { 201: ok(jobItem, 'The new job'), 400: problem('Not a usable CSV file') },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/imports',
    tags,
    summary: 'List import jobs, newest first',
    request: { query: jobList },
    responses: { 200: ok(jobPage) },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/imports/{id}',
    tags,
    summary: 'One import job with its counts',
    request: { params: idParams },
    responses: { 200: ok(jobItem), 404: problem('No such import') },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/imports/{id}/preview',
    tags,
    summary: 'Apply a mapping to every row and check it; can be repeated',
    request: { params: idParams, body: body(previewBody) },
    responses: {
      200: ok(jobItem),
      400: problem('The mapping does not fit the file or the record type'),
      422: problem('The import is not in a state that can be previewed'),
    },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/imports/{id}/rows',
    tags,
    summary: 'The previewed rows, with onlyErrors=true for the ones to fix',
    request: { params: idParams, query: rowList },
    responses: { 200: ok(rowPage), 404: problem('No such import') },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/imports/{id}/commit',
    tags,
    summary: 'Create the good rows in a background job (all or nothing)',
    request: { params: idParams, body: body(commitBody) },
    responses: {
      202: ok(jobItem, 'Queued'),
      422: problem('Rows have errors, nothing to import, or wrong state'),
    },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/exports',
    tags,
    summary: 'Export every record of a type (optionally filtered) to CSV or Excel',
    request: { body: body(exportCreate) },
    responses: {
      201: ok(exportItem, 'The export and its file'),
      404: problem('This record type cannot be exported'),
      422: problem('Too many rows: add a filter'),
    },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/exports',
    tags,
    summary: 'List exports, newest first',
    request: { query: exportList },
    responses: {
      200: ok(
        z.object({
          items: z.array(exportItem),
          total: z.number().int(),
          page: z.number().int(),
          pageSize: z.number().int(),
        }),
      ),
    },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/exports/{id}',
    tags,
    summary: 'One export',
    request: { params: idParams },
    responses: { 200: ok(exportItem), 404: problem('No such export') },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/imports/{id}/rollback',
    tags,
    summary: 'Soft-delete everything this import created',
    request: { params: idParams, body: body(rollbackBody) },
    responses: { 200: ok(jobItem), 422: problem('The import is not committed') },
  });

  return router;
}
