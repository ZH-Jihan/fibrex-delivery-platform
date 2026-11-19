/**
 * Bulk scan upload API (SPEC 5.12, PLAN 3.10 `bulk_upload`, `bulk_upload_item`).
 *
 *   POST /bulk-uploads                          scans already uploaded (files module) -> one OCR job
 *                                               and one pending item per scan, with a suggested
 *                                               person and document type
 *   GET  /bulk-uploads                          recent batches with their item counts
 *   GET  /bulk-uploads/{id}                     one batch with its items and their OCR readings
 *   POST /bulk-uploads/{id}/items/{itemId}/confirm  staff's checked values -> a document
 *   POST /bulk-uploads/{id}/items/{itemId}/reject   staff drop the scan, with a reason
 *
 * Rules, and why:
 *   1. Each scan goes through the same OCR read as a single upload (`OcrEngine.createJob`) and
 *      each confirm goes through the same confirm (`OcrEngine.confirmJob`): one path from OCR
 *      to a document, with the normal document rules, whatever screen started it.
 *   2. A suggestion is only a suggestion. The person is suggested only when exactly one
 *      employee of the company matches the holder name (shared `suggestPartyId`); the type is
 *      the one OCR recognised. Staff may change both before confirming.
 *   3. A batch is all or nothing: if one file is refused (unknown file, not a scan) nothing is
 *      created and the error names the problem, so a half-read folder is never left behind.
 *      An OCR adapter failure is not a refusal: that item is kept with a failed job and staff
 *      can still type the values or reject it (OCR rule 4).
 *   4. An item is resolved once, from `pending`: the version check and the status check refuse
 *      a second confirm or reject. A batch is `completed` when no item is pending; the status
 *      is refreshed whenever an item is resolved.
 *   5. Confirming needs `people.bulk_upload.update` and `people.document.create`; the scan's
 *      company must match the document owner's (the OCR confirm checks it).
 *
 * Depends on: express, zod, @fibrex/shared (bulk upload and document schemas), ./ocr-router.ts
 * (OcrEngine), kernel/db, kernel/http, kernel/permissions. Used by: ./index.ts.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  BULK_ITEM_STATUSES,
  BULK_UPLOAD_STATUSES,
  bulkItemRejectSchema,
  bulkUploadCreateSchema,
  documentCreateSchema,
  suggestPartyId,
} from '@fibrex/shared';
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../../kernel/db/prisma.js';
import { createRepository } from '../../kernel/db/repository.js';
import { currentUnit, type UnitOfWork } from '../../kernel/db/unit-of-work.js';
import { ConflictError, NotFoundError } from '../../kernel/http/errors.js';
import { registerRoute } from '../../kernel/http/openapi.js';
import type { PermissionService } from '../../kernel/permissions/permission-service.js';
import { toDocumentItem } from './document-router.js';
import type { OcrEngine } from './ocr-router.js';

type UploadRow = NonNullable<Awaited<ReturnType<Db['bulkUpload']['findFirst']>>>;
type ItemRow = NonNullable<Awaited<ReturnType<Db['bulkUploadItem']['findFirst']>>>;
type OcrJobView = Awaited<ReturnType<OcrEngine['toJobItem']>>;

const idParams = z.object({ id: z.uuid() });
const itemParams = z.object({ id: z.uuid(), itemId: z.uuid() });

const itemView = z
  .object({
    id: z.uuid(),
    bulkUploadId: z.uuid(),
    fileObjectId: z.uuid(),
    ocrJobId: z.uuid(),
    status: z.enum(BULK_ITEM_STATUSES),
    suggestedPartyId: z.uuid().nullable(),
    suggestedPartyName: z.string().nullable(),
    suggestedDocumentTypeId: z.uuid().nullable(),
    documentId: z.uuid().nullable(),
    rejectReason: z.string().nullable(),
    version: z.number().int(),
    job: z.any(),
  })
  .meta({ id: 'BulkUploadItem' });
const uploadView = z
  .object({
    id: z.uuid(),
    status: z.enum(BULK_UPLOAD_STATUSES),
    uploadedCount: z.number().int(),
    pendingCount: z.number().int(),
    createdAt: z.iso.datetime(),
    items: z.array(itemView).optional(),
  })
  .meta({ id: 'BulkUpload' });

export interface BulkUploadRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  ocr: OcrEngine;
}

export function createBulkUploadRouter(deps: BulkUploadRouterDeps): Router {
  const { uow, registry, permissions, ocr } = deps;
  const uploads = createRepository<UploadRow>({ model: 'bulkUpload', scope: 'company' });
  const items = createRepository<ItemRow>({ model: 'bulkUploadItem', scope: 'company' });
  const router = Router();

  /** Items of a batch with their OCR job and the suggested person's name. */
  async function itemViews(rows: ItemRow[]) {
    const { db } = currentUnit();
    const jobs = await db.ocrJob.findMany({
      where: { id: { in: rows.map((r) => r.ocrJobId) } },
    });
    const jobById = new Map(jobs.map((j) => [j.id, j]));
    const partyIds = [
      ...new Set(rows.flatMap((r) => (r.suggestedPartyId ? [r.suggestedPartyId] : []))),
    ];
    const parties =
      partyIds.length === 0
        ? []
        : await db.party.findMany({
            where: { id: { in: partyIds } },
            select: { id: true, displayName: true },
          });
    const nameById = new Map(parties.map((p) => [p.id, p.displayName]));
    const out: (Omit<z.infer<typeof itemView>, 'job'> & { job: OcrJobView | null })[] = [];
    for (const r of rows) {
      const job = jobById.get(r.ocrJobId);
      out.push({
        id: r.id,
        bulkUploadId: r.bulkUploadId,
        fileObjectId: r.fileObjectId,
        ocrJobId: r.ocrJobId,
        status: r.status as (typeof BULK_ITEM_STATUSES)[number],
        suggestedPartyId: r.suggestedPartyId,
        suggestedPartyName: r.suggestedPartyId ? (nameById.get(r.suggestedPartyId) ?? null) : null,
        suggestedDocumentTypeId: r.suggestedDocumentTypeId,
        documentId: r.documentId,
        rejectReason: r.rejectReason,
        version: r.version,
        job: job === undefined ? null : await ocr.toJobItem(job),
      });
    }
    return out;
  }

  const uploadSummary = (row: UploadRow, pending: number) => ({
    id: row.id,
    status: row.status as (typeof BULK_UPLOAD_STATUSES)[number],
    uploadedCount: row.uploadedCount,
    pendingCount: pending,
    createdAt: row.createdAt.toISOString(),
  });

  /** Rule 4: `completed` when nothing is pending, `open` otherwise. */
  async function refreshStatus(uploadId: string): Promise<number> {
    const { db } = currentUnit();
    const pending = await db.bulkUploadItem.count({
      where: { bulkUploadId: uploadId, status: 'pending', deletedAt: null },
    });
    // The database trigger bumps the version and stamps the change; the status is derived
    // from the items, so no version check is needed here.
    await db.bulkUpload.updateMany({
      where: { id: uploadId, deletedAt: null },
      data: { status: pending === 0 ? 'completed' : 'open' },
    });
    return pending;
  }

  router.post('/bulk-uploads', async (req, res) => {
    const body = bulkUploadCreateSchema.parse(req.body);
    const out = await uow.run(async (db) => {
      await permissions.require('people.bulk_upload.create');
      await permissions.require('people.ocr_job.create');
      // The people an owner-less scan may be suggested to: employees of the company.
      const employees = await db.employee.findMany({
        where: { deletedAt: null },
        select: { partyId: true },
      });
      const people = await db.party.findMany({
        where: { id: { in: employees.map((e) => e.partyId) }, deletedAt: null },
        select: { id: true, displayName: true },
      });
      const candidates = people.map((p) => ({ id: p.id, names: [p.displayName] }));

      // Rule 3: read every scan first; the first refusal stops the whole batch.
      const read: { fileObjectId: string; jobId: string; companyId: string }[] = [];
      for (const fileObjectId of body.fileObjectIds) {
        const job = await ocr.createJob(db, { fileObjectId });
        read.push({ fileObjectId, jobId: job.id, companyId: job.companyId });
      }
      const companyId = read[0]?.companyId;
      if (companyId === undefined || read.some((r) => r.companyId !== companyId)) {
        throw new ConflictError('mixed_companies', 'All scans of a batch must be in one company.');
      }
      const upload = await uploads.create({
        companyId,
        status: 'open',
        uploadedCount: read.length,
      });
      const rows: ItemRow[] = [];
      for (const r of read) {
        const job = await db.ocrJob.findFirstOrThrow({ where: { id: r.jobId } });
        const view = await ocr.toJobItem(job);
        // Rule 2: suggestions come from the reading, and are only suggestions.
        rows.push(
          await items.create({
            companyId,
            bulkUploadId: upload.id,
            fileObjectId: r.fileObjectId,
            ocrJobId: r.jobId,
            suggestedPartyId: suggestPartyId(view.fields.holderName.value, candidates),
            suggestedDocumentTypeId: view.fields.documentTypeId.value,
            status: 'pending',
          }),
        );
      }
      return {
        ...uploadSummary(upload, rows.length),
        items: await itemViews(rows),
      };
    });
    res.status(201).json(out);
  });

  router.get('/bulk-uploads', async (_req, res) => {
    const out = await uow.run(async (db) => {
      await permissions.require('people.bulk_upload.read');
      const rows = await db.bulkUpload.findMany({
        where: { deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      const pending = await db.bulkUploadItem.groupBy({
        by: ['bulkUploadId'],
        where: { status: 'pending', deletedAt: null, bulkUploadId: { in: rows.map((r) => r.id) } },
        _count: { _all: true },
      });
      const pendingBy = new Map(pending.map((p) => [p.bulkUploadId, p._count._all]));
      return { items: rows.map((r) => uploadSummary(r, pendingBy.get(r.id) ?? 0)) };
    });
    res.json(out);
  });

  router.get('/bulk-uploads/:id', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const out = await uow.run(async (db) => {
      await permissions.require('people.bulk_upload.read');
      const upload = await uploads.get(id);
      const rows = await db.bulkUploadItem.findMany({
        where: { bulkUploadId: id, deletedAt: null },
        orderBy: { id: 'asc' },
      });
      return {
        ...uploadSummary(upload, rows.filter((r) => r.status === 'pending').length),
        items: await itemViews(rows),
      };
    });
    res.json(out);
  });

  /** The pending item of this batch (404 when it belongs to another batch). */
  async function pendingItem(uploadId: string, itemId: string): Promise<ItemRow> {
    const item = await items.get(itemId);
    if (item.bulkUploadId !== uploadId) throw new NotFoundError('No such scan in this batch');
    if (item.status !== 'pending') {
      throw new ConflictError('already_resolved', `This scan was already ${item.status}.`);
    }
    return item;
  }

  router.post('/bulk-uploads/:id/items/:itemId/confirm', async (req, res) => {
    const { id, itemId } = itemParams.parse(req.params);
    const body = documentCreateSchema.parse(req.body);
    const out = await uow.run(async () => {
      await permissions.require('people.bulk_upload.update');
      await permissions.require('people.ocr_job.read');
      await permissions.require('people.document.create');
      const item = await pendingItem(id, itemId);
      // Rule 1: the same confirm as a single scan (document rules, scan attached, job confirmed).
      const document = await ocr.confirmJob(item.ocrJobId, body);
      const updated = await items.update(item.id, item.version, {
        status: 'confirmed',
        documentId: document.id,
      });
      const pending = await refreshStatus(id);
      return { item: (await itemViews([updated]))[0], pendingCount: pending, document };
    });
    res.status(201).json({
      item: out.item,
      pendingCount: out.pendingCount,
      document: toDocumentItem(out.document),
    });
  });

  router.post('/bulk-uploads/:id/items/:itemId/reject', async (req, res) => {
    const { id, itemId } = itemParams.parse(req.params);
    const body = bulkItemRejectSchema.parse(req.body);
    const out = await uow.run(async () => {
      await permissions.require('people.bulk_upload.update');
      const item = await pendingItem(id, itemId);
      const updated = await items.update(item.id, item.version, {
        status: 'rejected',
        rejectReason: body.reason,
      });
      const pending = await refreshStatus(id);
      return { item: (await itemViews([updated]))[0], pendingCount: pending };
    });
    res.json(out);
  });

  const tags = ['Documents'];
  const json = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });
  registerRoute(registry, {
    method: 'post',
    path: '/bulk-uploads',
    tags,
    summary: 'Read many uploaded scans with OCR and suggest person and type (saves no document)',
    request: { body: json(bulkUploadCreateSchema) },
    responses: { 201: { description: 'The batch and its items', ...json(uploadView) } },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/bulk-uploads',
    tags,
    summary: 'Recent bulk uploads',
    responses: {
      200: { description: 'Batches', ...json(z.object({ items: z.array(uploadView) })) },
    },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/bulk-uploads/{id}',
    tags,
    summary: 'One bulk upload with its items',
    request: { params: idParams },
    responses: { 200: { description: 'The batch', ...json(uploadView) } },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/bulk-uploads/{id}/items/{itemId}/confirm',
    tags,
    summary: 'Confirm one scan: save the checked values as a document',
    request: { params: itemParams, body: json(documentCreateSchema) },
    responses: { 201: { description: 'The item and the new document' } },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/bulk-uploads/{id}/items/{itemId}/reject',
    tags,
    summary: 'Reject one scan, with a reason',
    request: { params: itemParams, body: json(bulkItemRejectSchema) },
    responses: { 200: { description: 'The item' } },
  });
  return router;
}
