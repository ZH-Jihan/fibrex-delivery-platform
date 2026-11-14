/**
 * Files and attachments API (PLAN 5.8).
 *
 *   POST /files/upload-url            declare a file, get a signed storage address + token
 *   POST /files/complete              verify the stored object, record it (201)
 *   GET  /files/{id}/download-url     short-lived address (audited)
 *   /attachments                      CRUD factory: GET needs entityType and entityId
 *   POST /attachments/{id}/versions   replace a file: adds a version, keeps the old one
 *   GET  /attachments/{id}/versions   every version of one attachment, oldest first
 *
 * Attachment rules enforced by the repository wrapper, so no route can skip them:
 *   - the record type must be registered as attachable (./attachable.ts);
 *   - the caller needs the record type's read permission to see its files and its attach
 *     permission to add, relabel, remove or restore them;
 *   - the record must exist and be visible to the caller;
 *   - a replacement must replace the LATEST version; versions form one straight line.
 *
 * Depends on: express, zod, kernel/http (CRUD factory, OpenAPI, errors), kernel/db,
 * ./files-service.ts, ./attachable.ts. Used by: ./index.ts.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../../kernel/db/prisma.js';
import { createRepository, type Repository } from '../../kernel/db/repository.js';
import { currentUnit, type UnitOfWork } from '../../kernel/db/unit-of-work.js';
import { createCrudRouter } from '../../kernel/http/crud-router.js';
import { ConflictError, NotFoundError, ValidationError } from '../../kernel/http/errors.js';
import { problemSchema, registerRoute } from '../../kernel/http/openapi.js';
import type { PermissionService } from '../../kernel/permissions/permission-service.js';
import type { AttachableRegistry } from './attachable.js';
import type { FileRow, FilesService } from './files-service.js';

export type AttachmentRow = NonNullable<Awaited<ReturnType<Db['fileAttachment']['findFirst']>>>;

const sha256 = z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters');
const entityType = z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
const purpose = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);

const uploadRequest = z.strictObject({
  originalName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(3).max(150),
  sizeBytes: z.number().int().positive(),
  sha256,
  companyId: z.uuid().optional(),
});
const uploadResponse = z
  .object({
    uploadToken: z.string(),
    url: z.string(),
    method: z.literal('PUT'),
    headers: z.record(z.string(), z.string()),
    expiresAt: z.iso.datetime(),
  })
  .meta({ id: 'UploadTarget' });
const completeRequest = z.strictObject({ uploadToken: z.string().min(20).max(4000) });
const fileItem = z
  .object({
    id: z.uuid(),
    originalName: z.string(),
    mimeType: z.string(),
    sizeBytes: z.number().int(),
    sha256: z.string(),
    scanStatus: z.string(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'File' });
const downloadResponse = z
  .object({ url: z.string(), expiresAt: z.iso.datetime() })
  .meta({ id: 'DownloadTarget' });

const attachmentCreate = z.strictObject({
  entityType,
  entityId: z.uuid(),
  fileObjectId: z.uuid(),
  purpose,
  label: z.string().trim().min(1).max(200).optional(),
  companyId: z.uuid().optional(),
});
const attachmentUpdate = z.strictObject({
  purpose: purpose.optional(),
  label: z.string().trim().min(1).max(200).optional(),
});
const attachmentFilter = z.object({ entityType, entityId: z.uuid() });
const versionCreate = z.strictObject({
  fileObjectId: z.uuid(),
  label: z.string().trim().min(1).max(200).optional(),
});
const attachmentItem = z
  .object({
    id: z.uuid(),
    entityType: z.string(),
    entityId: z.uuid(),
    fileObjectId: z.uuid(),
    purpose: z.string(),
    versionNo: z.number().int(),
    supersedesId: z.uuid().nullable(),
    label: z.string().nullable(),
    version: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    deletedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'Attachment' });

const idParams = z.object({ id: z.uuid() });

export function toFileItem(row: FileRow) {
  return {
    id: row.id,
    originalName: row.originalName,
    mimeType: row.mimeType,
    sizeBytes: Number(row.sizeBytes),
    sha256: row.sha256,
    scanStatus: row.scanStatus,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toAttachmentItem(row: AttachmentRow) {
  return {
    id: row.id,
    entityType: row.entityType,
    entityId: row.entityId,
    fileObjectId: row.fileObjectId,
    purpose: row.purpose,
    versionNo: row.versionNo,
    supersedesId: row.supersedesId,
    label: row.label,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

export interface FilesRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  files: FilesService;
  attachables: AttachableRegistry;
}

/** The repository behind /attachments: the attachment rules wrapped around the standard one. */
export function createAttachmentRepository(deps: {
  permissions: PermissionService;
  attachables: AttachableRegistry;
}): Repository<AttachmentRow> & {
  createVersion(
    previous: AttachmentRow,
    fileObjectId: string,
    label?: string,
  ): Promise<AttachmentRow>;
} {
  const { permissions, attachables } = deps;
  const base = createRepository<AttachmentRow>({ model: 'fileAttachment', scope: 'company' });

  const mustSeeFile = async (fileObjectId: string): Promise<void> => {
    const file = await currentUnit().db.fileObject.findFirst({
      where: { id: fileObjectId },
      select: { id: true },
    });
    // A file of another company or tenant is hidden by row-level security: same answer
    // as a file that does not exist.
    if (file === null) {
      throw new ValidationError([
        { path: 'fileObjectId', code: 'unknown_file', message: 'No such file' },
      ]);
    }
  };

  /** Loads a row (live or deleted) and checks the caller may attach to its record. */
  const guardRow = async (id: string, deleted: boolean): Promise<AttachmentRow> => {
    const row = await currentUnit().db.fileAttachment.findFirst({
      where: { id, deletedAt: deleted ? { not: null } : null },
    });
    if (row === null) throw new NotFoundError();
    await permissions.require(attachables.get(row.entityType).attachPermission);
    return row;
  };

  return {
    list: async (options) => {
      const where = options.where ?? {};
      const type = attachables.get(String(where.entityType));
      await permissions.require(type.readPermission);
      // Only the latest version of each attachment: no live row replaces it.
      const current = { ...where, successors: { none: { deletedAt: null } } };
      return base.list({ ...options, where: current });
    },
    get: async (id) => {
      const row = await base.get(id);
      await permissions.require(attachables.get(row.entityType).readPermission);
      return row;
    },
    create: async (data) => {
      const type = attachables.get(String(data.entityType));
      await permissions.require(type.attachPermission);
      await attachables.getExisting(currentUnit().db, type.entityType, String(data.entityId));
      await mustSeeFile(String(data.fileObjectId));
      return base.create({ ...data, versionNo: 1, supersedesId: null });
    },
    createVersion: (previous, fileObjectId, label) =>
      base.create({
        entityType: previous.entityType,
        entityId: previous.entityId,
        fileObjectId,
        purpose: previous.purpose,
        label: label ?? previous.label,
        companyId: previous.companyId,
        versionNo: previous.versionNo + 1,
        supersedesId: previous.id,
      }),
    update: async (id, version, changes) => {
      await guardRow(id, false);
      return base.update(id, version, changes);
    },
    softDelete: async (id, version, reason) => {
      await guardRow(id, false);
      return base.softDelete(id, version, reason);
    },
    restore: async (id, version) => {
      await guardRow(id, true);
      return base.restore(id, version);
    },
  };
}

export function createFilesRouter(deps: FilesRouterDeps): Router {
  const { uow, registry, permissions, files, attachables } = deps;
  const router = Router();
  const repository = createAttachmentRepository({ permissions, attachables });
  const jsonBody = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });
  const json = (description: string, schema: z.ZodType) => ({
    description,
    content: { 'application/json': { schema } },
  });
  const tags = ['Files'];

  router.post('/files/upload-url', async (req, res) => {
    const body = uploadRequest.parse(req.body);
    res.json(await uow.run(() => files.requestUpload(body)));
  });
  router.post('/files/complete', async (req, res) => {
    const { uploadToken } = completeRequest.parse(req.body);
    const row = await uow.run(() => files.completeUpload(uploadToken));
    res.status(201).json(toFileItem(row));
  });
  router.get('/files/:id/download-url', async (req, res) => {
    const { id } = idParams.parse(req.params);
    res.json(await uow.run(() => files.downloadUrl(id)));
  });

  // Replace a file: a new version after the latest one.
  router.post('/attachments/:id/versions', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const body = versionCreate.parse(req.body);
    const row = await uow.run(async (db) => {
      await permissions.require('files.attachment.create');
      const previous = await db.fileAttachment.findFirst({ where: { id } });
      if (previous === null) throw new NotFoundError();
      await permissions.require(attachables.get(previous.entityType).attachPermission);
      const successor = await db.fileAttachment.findFirst({
        where: { supersedesId: id },
        select: { id: true },
      });
      if (successor !== null) {
        throw new ConflictError(
          'not_latest_version',
          'A newer version already exists. Replace the latest version instead.',
          { latestHint: successor.id },
        );
      }
      const file = await db.fileObject.findFirst({
        where: { id: body.fileObjectId },
        select: { id: true },
      });
      if (file === null) {
        throw new ValidationError([
          { path: 'fileObjectId', code: 'unknown_file', message: 'No such file' },
        ]);
      }
      return repository.createVersion(previous, body.fileObjectId, body.label);
    });
    res.status(201).json(toAttachmentItem(row));
  });

  router.get('/attachments/:id/versions', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const rows = await uow.run(async (db) => {
      await permissions.require('files.attachment.read');
      const start = await db.fileAttachment.findFirst({ where: { id } });
      if (start === null) throw new NotFoundError();
      await permissions.require(attachables.get(start.entityType).readPermission);
      // Walk back to the first version, then forward to the latest.
      let first = start;
      for (;;) {
        if (first.supersedesId === null) break;
        const earlier = await db.fileAttachment.findFirst({ where: { id: first.supersedesId } });
        if (earlier === null) break;
        first = earlier;
      }
      const chain = [first];
      for (;;) {
        const last = chain[chain.length - 1];
        if (last === undefined) break;
        const next = await db.fileAttachment.findFirst({ where: { supersedesId: last.id } });
        if (next === null) break;
        chain.push(next);
      }
      return chain;
    });
    res.json({ items: rows.map(toAttachmentItem) });
  });

  router.use(
    createCrudRouter(
      { uow, authorize: permissions.authorize, registry },
      {
        path: '/attachments',
        resource: 'files.attachment',
        tag: 'Attachments',
        repository,
        schemas: {
          create: attachmentCreate,
          update: attachmentUpdate,
          item: attachmentItem,
          filter: attachmentFilter,
        },
        toItem: toAttachmentItem,
        toWhere: (filter) => ({ entityType: filter.entityType, entityId: filter.entityId }),
      },
    ),
  );

  registerRoute(registry, {
    method: 'post',
    path: '/files/upload-url',
    tags,
    summary: 'Declare a file and get a signed storage address',
    request: { body: jsonBody(uploadRequest) },
    responses: { 200: json('Where to send the bytes', uploadResponse) },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/files/complete',
    tags,
    summary: 'Verify the stored object and record it',
    request: { body: jsonBody(completeRequest) },
    responses: {
      201: json('The recorded file', fileItem),
      422: {
        description: 'Not uploaded, or size, checksum or type does not match',
        content: { 'application/problem+json': { schema: problemSchema } },
      },
    },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/files/{id}/download-url',
    tags,
    summary: 'Short-lived download address (audited)',
    request: { params: idParams },
    responses: { 200: json('The address', downloadResponse) },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/attachments/{id}/versions',
    tags: ['Attachments'],
    summary: 'Replace the file of an attachment (adds a version)',
    request: { params: idParams, body: jsonBody(versionCreate) },
    responses: { 201: json('The new version', attachmentItem) },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/attachments/{id}/versions',
    tags: ['Attachments'],
    summary: 'Every version of an attachment, oldest first',
    request: { params: idParams },
    responses: { 200: json('Versions', z.object({ items: z.array(attachmentItem) })) },
  });

  return router;
}
