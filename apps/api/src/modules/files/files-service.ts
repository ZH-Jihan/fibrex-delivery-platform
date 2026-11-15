/**
 * Files service: upload, completion, download and raw-input recording.
 *
 * Purpose: the rules of SPEC 5.8, in one place:
 *   1. Upload in two steps. `requestUpload` checks the declared type, size and SHA-256 and
 *      returns a signed storage address plus a signed token. The browser sends the bytes
 *      straight to storage. `completeUpload` then measures the stored object itself and
 *      accepts it only if size, SHA-256 and file signature match the promise. Nothing the
 *      browser says is trusted. Completing twice returns the same file (idempotent).
 *   2. A file is never overwritten: file_object rows are insert-only.
 *   3. Download needs `files.file.download` AND either being the uploader or being allowed
 *      to read a record the file is attached to. Every download is audited. Addresses live
 *      a few minutes.
 *   4. Raw inputs (sheet snapshots, bank files, webhook bodies) are recorded and kept.
 *
 * Depends on: kernel/db, kernel/audit, kernel/permissions, adapters/storage, ./attachable.ts.
 * Used by: ./files-router.ts, ./attachment-router.ts, src/main.ts (raw inputs by importers).
 */
import { randomUUID } from 'node:crypto';
import type { StorageAdapter } from '../../adapters/storage/interface.js';
import type { AuditService } from '../../kernel/audit/audit-service.js';
import type { Db } from '../../kernel/db/prisma.js';
import { currentUnit } from '../../kernel/db/unit-of-work.js';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
  type FieldIssue,
} from '../../kernel/http/errors.js';
import type { PermissionService } from '../../kernel/permissions/permission-service.js';
import type { AttachableRegistry } from './attachable.js';
import { ALLOWED_MIME_TYPES, matchesSignature } from './file-types.js';
import { issueUploadToken, readUploadToken } from './upload-token.js';

export type FileRow = NonNullable<Awaited<ReturnType<Db['fileObject']['findFirst']>>>;

export interface FilesServiceDeps {
  storage: StorageAdapter;
  permissions: PermissionService;
  audit: AuditService;
  attachables: AttachableRegistry;
  tokenSecret: string;
  maxBytes: number;
  uploadTtlSeconds: number;
  downloadTtlSeconds: number;
}

export interface UploadRequestInput {
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  companyId?: string | undefined;
}

export const RAW_INPUT_KINDS = [
  'sheet_snapshot',
  'excel_upload',
  'bank_file',
  'client_statement',
  'webhook',
  'workbook_import',
  'legacy_dump',
] as const;

export class FilesService {
  private readonly deps: FilesServiceDeps;

  constructor(deps: FilesServiceDeps) {
    this.deps = deps;
  }

  /** The company a new file belongs to: the one named, or the only one the caller has. */
  private companyFor(requested: string | undefined): string {
    const { context } = currentUnit();
    const companyId =
      requested ?? (context.companyIds.length === 1 ? context.companyIds[0] : undefined);
    if (companyId === undefined) {
      throw new BadRequestError('company_required', 'State which company this file belongs to.');
    }
    if (!context.companyIds.includes(companyId)) {
      throw new ForbiddenError('You do not have access to this company');
    }
    return companyId;
  }

  /**
   * True when the file exists and the caller may see it (row-level security applies). Other
   * code asks this before storing a file id, for example in a custom record's file field.
   */
  async exists(id: string): Promise<boolean> {
    const { db } = currentUnit();
    return (await db.fileObject.findFirst({ where: { id }, select: { id: true } })) !== null;
  }

  /** Step 1. Runs inside the unit of work the router opens. */
  async requestUpload(input: UploadRequestInput): Promise<{
    uploadToken: string;
    url: string;
    method: 'PUT';
    headers: Record<string, string>;
    expiresAt: string;
  }> {
    await this.deps.permissions.require('files.file.upload');
    const { context } = currentUnit();
    const issues: FieldIssue[] = [];
    if (!ALLOWED_MIME_TYPES.has(input.mimeType)) {
      issues.push({
        path: 'mimeType',
        code: 'type_not_allowed',
        message: `${input.mimeType} files are not accepted`,
      });
    }
    if (input.sizeBytes > this.deps.maxBytes) {
      issues.push({
        path: 'sizeBytes',
        code: 'too_large',
        message: `The largest file is ${String(this.deps.maxBytes)} bytes`,
      });
    }
    if (issues.length > 0) throw new ValidationError(issues);

    const companyId = this.companyFor(input.companyId);
    // The key is built here, never from user input: no way to reach another tenant's path.
    const month = new Date().toISOString().slice(0, 7);
    const key = `${context.tenantId}/${companyId}/${month}/${randomUUID()}`;
    const exp = Math.floor(Date.now() / 1000) + this.deps.uploadTtlSeconds;
    const signed = await this.deps.storage.presignUpload({
      key,
      contentType: input.mimeType,
      sizeBytes: input.sizeBytes,
      expiresSeconds: this.deps.uploadTtlSeconds,
    });
    const uploadToken = issueUploadToken(this.deps.tokenSecret, {
      tenantId: context.tenantId,
      companyId,
      userId: context.userId ?? null,
      key,
      name: input.originalName,
      mime: input.mimeType,
      size: input.sizeBytes,
      sha256: input.sha256.toLowerCase(),
      exp,
    });
    return { uploadToken, ...signed, expiresAt: new Date(exp * 1000).toISOString() };
  }

  /** Step 2: verify what was stored, then record it. */
  async completeUpload(uploadToken: string): Promise<FileRow> {
    await this.deps.permissions.require('files.file.upload');
    const { db, context } = currentUnit();
    const claims = readUploadToken(
      this.deps.tokenSecret,
      uploadToken,
      Math.floor(Date.now() / 1000),
    );
    const invalidToken = new BadRequestError(
      'invalid_upload_token',
      'The upload token is invalid or has expired.',
    );
    if (claims === null) throw invalidToken;
    // The token must belong to this person, in this tenant, for a company they still have.
    if (
      claims.tenantId !== context.tenantId ||
      claims.userId !== (context.userId ?? null) ||
      !context.companyIds.includes(claims.companyId)
    ) {
      throw invalidToken;
    }
    // Completing twice is harmless: the same object gives the same file.
    const existing = await db.fileObject.findFirst({
      where: { bucket: this.deps.storage.bucket, objectKey: claims.key },
    });
    if (existing !== null) return existing;

    const stored = await this.deps.storage.inspect(claims.key);
    if (stored === null) {
      throw new UnprocessableError(
        'upload_missing',
        'The file has not been uploaded to the storage address yet.',
      );
    }
    // Everything below compares the measured object with what was promised.
    if (stored.sizeBytes !== claims.size) {
      throw new UnprocessableError(
        'size_mismatch',
        'The uploaded file is not the size that was declared.',
      );
    }
    if (stored.sha256 !== claims.sha256) {
      throw new UnprocessableError(
        'checksum_mismatch',
        'The uploaded file does not match its checksum.',
      );
    }
    if (!matchesSignature(claims.mime, stored.head)) {
      throw new UnprocessableError(
        'type_mismatch',
        'The file content does not match its declared type.',
      );
    }
    return db.fileObject.create({
      data: {
        tenantId: claims.tenantId,
        companyId: claims.companyId,
        bucket: this.deps.storage.bucket,
        objectKey: claims.key,
        sha256: stored.sha256,
        sizeBytes: BigInt(stored.sizeBytes),
        mimeType: claims.mime,
        originalName: claims.name,
      },
    });
  }

  /** A short-lived download address. 404 for a file the caller may not see. */
  async downloadUrl(id: string): Promise<{ url: string; expiresAt: string }> {
    await this.deps.permissions.require('files.file.download');
    const { db, context } = currentUnit();
    const file = await db.fileObject.findFirst({ where: { id } });
    if (file === null) throw new NotFoundError();

    // Rule 3: the uploader, or someone who may read a record the file is attached to.
    let allowed = file.createdBy !== null && file.createdBy === context.userId;
    if (!allowed) {
      const attachments = await db.fileAttachment.findMany({
        where: { fileObjectId: id },
        select: { entityType: true },
        distinct: ['entityType'],
      });
      for (const { entityType } of attachments) {
        const type = this.deps.attachables.all().find((t) => t.entityType === entityType);
        if (type === undefined) continue;
        try {
          await this.deps.permissions.require(type.readPermission);
          allowed = true;
          break;
        } catch (err) {
          if (!(err instanceof ForbiddenError)) throw err;
        }
      }
    }
    if (!allowed) throw new NotFoundError();

    const url = await this.deps.storage.presignDownload({
      key: file.objectKey,
      filename: file.originalName,
      contentType: file.mimeType,
      expiresSeconds: this.deps.downloadTtlSeconds,
    });
    await this.deps.audit.record({
      action: 'download',
      moduleKey: 'files',
      entityType: 'files.file_object',
      entityId: file.id,
      companyId: file.companyId,
      meta: { originalName: file.originalName, sizeBytes: Number(file.sizeBytes) },
    });
    return {
      url,
      expiresAt: new Date(Date.now() + this.deps.downloadTtlSeconds * 1000).toISOString(),
    };
  }

  /**
   * Keeps one raw input for ever (SPEC 2.12). Called by importers and webhook handlers,
   * inside their own unit of work. `meta` must not hold secrets.
   */
  async recordRawInput(input: {
    kind: (typeof RAW_INPUT_KINDS)[number];
    source: string;
    sha256: string;
    companyId?: string | undefined;
    fileObjectId?: string | undefined;
    meta?: Record<string, string | number | boolean | null> | undefined;
  }): Promise<{ id: string }> {
    const { db, context } = currentUnit();
    return db.rawInput.create({
      data: {
        tenantId: context.tenantId,
        companyId: this.companyFor(input.companyId),
        kind: input.kind,
        source: input.source,
        sha256: input.sha256.toLowerCase(),
        fileObjectId: input.fileObjectId ?? null,
        meta: input.meta ?? {},
      },
      select: { id: true },
    });
  }
}
