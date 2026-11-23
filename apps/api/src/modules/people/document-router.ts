/**
 * Documents API (PLAN 5.12): QID, passport, licence ... of people, vehicles and the company.
 *
 *   /documents                   CRUD factory (people.document.*); lists show the mask only
 *   POST /documents/{id}/renew   a renewal: the old document becomes `replaced` and is kept
 *   POST /documents/{id}/files   a scan: a new page, or a new version of a page
 *   POST /documents/{id}/reveal  the full number; needs people.document_number.reveal; audited
 *
 * Rules, and why:
 *   1. Owner. A party must exist in the company (the document takes the party's company);
 *      a company document belongs to that company itself. Vehicle documents are refused
 *      until the fleet module (Phase 5) brings the vehicle table to check them against.
 *   2. Type. A standard type must exist in the company and fit the owner kind; a custom
 *      document ("Add other document") has a typed name instead. A type without a number
 *      takes none; a type with an expiry needs the expiry date.
 *   3. Number. Same vault as party identifiers (no new crypto): normalised, sealed with
 *      AES-GCM under its own context, a keyed hash per type for exact lookup, and a mask.
 *      The plain value is never stored, never listed, never logged.
 *   4. Status is derived, never typed: on every write here, and daily by the expiry job
 *      (row 3.4). Expiring = within the largest alert window of the type, else of the
 *      company's expiry settings (default 14 days).
 *   5. One current document per owner and type. A second one is 409 `document_exists`;
 *      renewing marks the old one `replaced` (kept, with its files) and links the new one
 *      back to it. The database enforces the same rule (exclusion constraint).
 *   6. Files go through the files module (attachments of 'people.document', with versions),
 *      so its permission, visibility and version rules apply unchanged. A single-page type
 *      holds one page; a new scan of it is a new version.
 *   7. Revealing a number is its own permission and writes an audit row in the same
 *      transaction: no reveal without a record.
 *
 * Depends on: express, zod, @fibrex/shared (document schemas, status rule), kernel/db,
 * kernel/http, kernel/audit, modules/party (PartyService, PartyVault and its helpers),
 * modules/files (attachment repository), ./dates.ts, ./document-type-router.ts,
 * ./expiry-service.ts (company alert windows).
 * Used by: ./index.ts.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  deriveDocumentStatus,
  documentCreateSchema,
  documentFileSchema,
  documentRenewSchema,
  documentUpdateSchema,
  DOCUMENT_OWNER_TYPES,
  DOCUMENT_STATUSES,
} from '@fibrex/shared';
import { Router } from 'express';
import { z } from 'zod';
import type { AuditService } from '../../kernel/audit/audit-service.js';
import type { Db } from '../../kernel/db/prisma.js';
import { createRepository, type Repository } from '../../kernel/db/repository.js';
import { currentUnit, type UnitOfWork } from '../../kernel/db/unit-of-work.js';
import { createCrudRouter, parseIfMatch } from '../../kernel/http/crud-router.js';
import {
  ConflictError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
} from '../../kernel/http/errors.js';
import { registerRoute } from '../../kernel/http/openapi.js';
import type { PermissionService } from '../../kernel/permissions/permission-service.js';
import type { AttachableRegistry } from '../files/index.js';
import { createAttachmentRepository } from '../files/index.js';
import {
  maskValue,
  normaliseSecretValue,
  type PartyService,
  type PartyVault,
} from '../party/index.js';
import { fromDate, guardOverlap, isoToday, withDates } from './dates.js';
import type { DocumentTypeRow } from './document-type-router.js';
import { readExpirySettings } from './expiry-service.js';

export type DocumentRow = NonNullable<Awaited<ReturnType<Db['document']['findFirst']>>>;

/** file_attachment.entity_type of a document's scans. */
export const DOCUMENT_ENTITY = 'people.document';

const date = z.iso.date();
const item = z
  .object({
    id: z.uuid(),
    companyId: z.uuid(),
    ownerType: z.enum(DOCUMENT_OWNER_TYPES),
    ownerId: z.uuid(),
    documentTypeId: z.uuid().nullable(),
    customName: z.string().nullable(),
    numberMasked: z.string().nullable(),
    issueDate: date.nullable(),
    expiryDate: date.nullable(),
    status: z.enum(DOCUMENT_STATUSES),
    replacesId: z.uuid().nullable(),
    ocrJobId: z.uuid().nullable(),
    /** Where the row came from: null, or 'snoonu_fdb' (a date only, file still to come). */
    source: z.string().nullable(),
    version: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    deletedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'Document' });
const filter = z.object({
  ownerType: z.enum(DOCUMENT_OWNER_TYPES).optional(),
  ownerId: z.uuid().optional(),
  documentTypeId: z.uuid().optional(),
  status: z.enum(DOCUMENT_STATUSES).optional(),
});
const idParams = z.object({ id: z.uuid() });
const revealResponse = z.object({ value: z.string() }).meta({ id: 'RevealedDocumentNumber' });
const attachmentItem = z
  .object({
    id: z.uuid(),
    entityId: z.uuid(),
    fileObjectId: z.uuid(),
    purpose: z.string(),
    versionNo: z.number().int(),
    supersedesId: z.uuid().nullable(),
    label: z.string().nullable(),
  })
  .meta({ id: 'DocumentFile' });

export function toDocumentItem(row: DocumentRow) {
  return {
    id: row.id,
    companyId: row.companyId,
    ownerType: row.ownerType as (typeof DOCUMENT_OWNER_TYPES)[number],
    ownerId: row.ownerId,
    documentTypeId: row.documentTypeId,
    customName: row.customName,
    numberMasked: row.numberMasked,
    issueDate: fromDate(row.issueDate),
    expiryDate: fromDate(row.expiryDate),
    status: row.status as (typeof DOCUMENT_STATUSES)[number],
    replacesId: row.replacesId,
    ocrJobId: row.ocrJobId,
    source: row.source,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

const DATES = ['issueDate', 'expiryDate'] as const;
const invalid = (path: string, code: string, message: string) =>
  new ValidationError([{ path, code, message }]);

export interface DocumentRepository extends Repository<DocumentRow> {
  /** Rule 5: the renewal of `id` (expected at `version`); returns the new document. */
  renew(id: string, version: number, details: Record<string, unknown>): Promise<DocumentRow>;
  /** Row 3.6: a new document confirmed from an OCR job (the job id is kept on it). */
  createFromOcr(data: Record<string, unknown>, ocrJobId: string): Promise<DocumentRow>;
}

export function createDocumentRepository(deps: {
  parties: PartyService;
  vault: PartyVault;
}): DocumentRepository {
  const { parties, vault } = deps;
  const base = createRepository<DocumentRow>({ model: 'document', scope: 'company' });

  /** Rule 1: the company the owner lives in. */
  async function ownerCompany(ownerType: string, ownerId: string): Promise<string> {
    if (ownerType === 'party') {
      const party = await parties.get(ownerId);
      if (party === null) throw invalid('ownerId', 'unknown_owner', 'No such person');
      return party.companyId;
    }
    if (ownerType === 'company') {
      if (!currentUnit().context.companyIds.includes(ownerId)) {
        throw invalid('ownerId', 'unknown_owner', 'No such company');
      }
      return ownerId;
    }
    throw new UnprocessableError(
      'owner_type_unavailable',
      'Vehicle documents can be added once the vehicle register exists.',
    );
  }

  /** Rule 2: the live type, in the owner's company, for this owner kind. */
  async function typeFor(
    companyId: string,
    ownerType: string,
    typeId: string,
  ): Promise<DocumentTypeRow> {
    const type = await currentUnit().db.documentType.findFirst({
      where: { id: typeId, companyId, deletedAt: null },
    });
    if (type === null) {
      throw invalid('documentTypeId', 'unknown_document_type', 'No such document type');
    }
    if (type.appliesTo !== ownerType) {
      throw invalid(
        'documentTypeId',
        'wrong_owner_type',
        `This document type is for a ${type.appliesTo}, not a ${ownerType}`,
      );
    }
    return type;
  }

  /** Rule 3: the vault columns of a number (or all null when there is none). */
  function numberColumns(raw: unknown, typeKey: string) {
    if (typeof raw !== 'string') {
      return { numberEncrypted: null, numberHash: null, numberMasked: null };
    }
    const normalised = normaliseSecretValue(raw);
    const { tenantId } = currentUnit().context;
    return {
      numberEncrypted: vault.seal(normalised, 'people.document'),
      numberHash: vault.hash(tenantId, `document:${typeKey}`, normalised),
      numberMasked: maskValue(normalised),
    };
  }

  /** Rule 2 checks that depend on the type and the final field values. */
  function checkAgainstType(
    type: DocumentTypeRow | null,
    values: { number: unknown; expiryDate: unknown },
  ): void {
    if (type === null) return;
    if (!type.hasNumber && typeof values.number === 'string') {
      throw invalid('number', 'number_not_used', 'This document type has no number');
    }
    if (type.hasExpiry && (values.expiryDate === null || values.expiryDate === undefined)) {
      throw invalid('expiryDate', 'expiry_required', 'This document type needs an expiry date');
    }
  }

  /** Rule 4: the type's own windows, else the company default (expiry settings, row 3.4). */
  const statusOf = async (companyId: string, expiry: string | null, type: DocumentTypeRow | null) =>
    deriveDocumentStatus({
      expiryDate: expiry,
      today: isoToday(),
      alertWindows:
        type !== null && type.alertWindows.length > 0
          ? type.alertWindows
          : (await readExpirySettings(currentUnit().db, companyId)).windows,
      replaced: false,
    });

  /** Inserts a new document (create and renewal share it). */
  async function insert(
    data: Record<string, unknown>,
    replacesId: string | null,
    ocrJobId: string | null = null,
  ) {
    const ownerType = String(data.ownerType);
    const ownerId = String(data.ownerId);
    const companyId = await ownerCompany(ownerType, ownerId);
    if (typeof data.companyId === 'string' && data.companyId !== companyId) {
      throw invalid('companyId', 'company_mismatch', 'The owner belongs to another company');
    }
    const type =
      typeof data.documentTypeId === 'string'
        ? await typeFor(companyId, ownerType, data.documentTypeId)
        : null;
    const expiryDate = typeof data.expiryDate === 'string' ? data.expiryDate : null;
    checkAgainstType(type, { number: data.number, expiryDate });

    // Rule 5, checked first for a clear answer; the exclusion constraint backs it up.
    const customName = typeof data.customName === 'string' ? data.customName : null;
    const current = await currentUnit().db.document.findFirst({
      where: {
        companyId,
        ownerType,
        ownerId,
        status: { not: 'replaced' },
        deletedAt: null,
        ...(type === null
          ? { documentTypeId: null, customName: { equals: customName ?? '', mode: 'insensitive' } }
          : { documentTypeId: type.id }),
      },
      select: { id: true },
    });
    if (current !== null) {
      throw new ConflictError(
        'document_exists',
        'This owner already has a current document of this type. Renew it instead.',
        { currentId: current.id },
      );
    }

    const status = await statusOf(companyId, expiryDate, type);
    return guardOverlap(() =>
      base.create(
        withDates(
          {
            companyId,
            ownerType,
            ownerId,
            documentTypeId: type?.id ?? null,
            customName,
            issueDate: data.issueDate ?? null,
            expiryDate,
            ...numberColumns(data.number, type?.code ?? 'custom'),
            status,
            replacesId,
            ocrJobId,
            // Only code (the FDB date service) sets this; the API schemas have no such field.
            source: typeof data.source === 'string' ? data.source : null,
          },
          DATES,
        ),
      ),
    );
  }

  const loadType = async (row: DocumentRow) =>
    row.documentTypeId === null
      ? null
      : currentUnit().db.documentType.findFirst({ where: { id: row.documentTypeId } });

  return {
    ...base,
    create: (data) => insert(data, null),
    createFromOcr: (data, ocrJobId) => insert(data, null, ocrJobId),

    update: async (id, version, changes) => {
      const current = await base.get(id);
      const type = await loadType(current);
      if (type !== null && changes.customName !== undefined) {
        throw invalid('customName', 'not_custom', 'Only another (custom) document has a name');
      }
      // The values after this change, to check them as a whole.
      const issueDate =
        changes.issueDate === undefined ? fromDate(current.issueDate) : changes.issueDate;
      const expiryDate =
        changes.expiryDate === undefined ? fromDate(current.expiryDate) : changes.expiryDate;
      if (
        typeof issueDate === 'string' &&
        typeof expiryDate === 'string' &&
        expiryDate < issueDate
      ) {
        throw invalid(
          'expiryDate',
          'dates_out_of_order',
          'The expiry date is before the issue date',
        );
      }
      checkAgainstType(type, { number: changes.number, expiryDate });

      const next: Record<string, unknown> = { ...changes };
      delete next.number;
      if (changes.number !== undefined) {
        Object.assign(next, numberColumns(changes.number, type?.code ?? 'custom'));
      }
      // A replaced document stays replaced; any other gets its status again (rule 4).
      if (current.status !== 'replaced') {
        next.status = await statusOf(
          current.companyId,
          typeof expiryDate === 'string' ? expiryDate : null,
          type,
        );
      }
      return guardOverlap(() => base.update(id, version, withDates(next, DATES)));
    },

    restore: (id, version) => guardOverlap(() => base.restore(id, version)),

    renew: async (id, version, details) => {
      const old = await base.get(id);
      if (old.status === 'replaced') {
        throw new ConflictError('already_renewed', 'This document has already been renewed.');
      }
      // First the old one leaves the "current" slot, then the new one takes it (rule 5).
      await base.update(id, version, { status: 'replaced' });
      return insert(
        {
          ownerType: old.ownerType,
          ownerId: old.ownerId,
          documentTypeId: old.documentTypeId ?? undefined,
          customName: old.customName ?? undefined,
          ...details,
        },
        old.id,
      );
    },
  };
}

export interface DocumentRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  audit: AuditService;
  vault: PartyVault;
  attachables: AttachableRegistry;
  repository: DocumentRepository;
}

export function createDocumentRouter(deps: DocumentRouterDeps): Router {
  const { uow, registry, permissions, audit, vault, attachables, repository } = deps;
  const attachments = createAttachmentRepository({ permissions, attachables });
  const router = Router();

  router.post('/documents/:id/renew', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const version = parseIfMatch(req.header('If-Match'));
    const details = documentRenewSchema.parse(req.body);
    const row = await uow.run(async () => {
      await permissions.require('people.document.update');
      await permissions.require('people.document.create');
      return repository.renew(id, version, details);
    });
    res
      .status(201)
      .set('ETag', `"${String(row.version)}"`)
      .json(toDocumentItem(row));
  });

  router.post('/documents/:id/files', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const body = documentFileSchema.parse(req.body);
    const row = await uow.run(async (db) => {
      await permissions.require('people.document.update');
      const document = await repository.get(id);
      if (body.replacesAttachmentId !== undefined) {
        // A new version of one page of THIS document.
        const previous = await attachments.get(body.replacesAttachmentId);
        if (previous.entityType !== DOCUMENT_ENTITY || previous.entityId !== document.id) {
          throw new NotFoundError('No such file on this document.');
        }
        return attachments.replace(previous.id, body.fileObjectId, body.label);
      }
      // A single-page type holds one page; another scan of it is a new version (rule 6).
      const type =
        document.documentTypeId === null
          ? null
          : await db.documentType.findFirst({ where: { id: document.documentTypeId } });
      if (type !== null && !type.multiPage) {
        const pages = await attachments.list({
          where: { entityType: DOCUMENT_ENTITY, entityId: document.id },
          page: 1,
          pageSize: 1,
        });
        const page = pages.items[0];
        if (page !== undefined) {
          throw new ConflictError(
            'single_page_document',
            'This document has one page. Send replacesAttachmentId to add a new version of it.',
            { attachmentId: page.id },
          );
        }
      }
      return attachments.create({
        entityType: DOCUMENT_ENTITY,
        entityId: document.id,
        fileObjectId: body.fileObjectId,
        purpose: 'document_page',
        label: body.label ?? null,
        companyId: document.companyId,
      });
    });
    res.status(201).json({
      id: row.id,
      entityId: row.entityId,
      fileObjectId: row.fileObjectId,
      purpose: row.purpose,
      versionNo: row.versionNo,
      supersedesId: row.supersedesId,
      label: row.label,
    });
  });

  router.post('/documents/:id/reveal', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const value = await uow.run(async (db) => {
      await permissions.require('people.document_number.reveal');
      const row = await db.document.findFirst({ where: { id } });
      if (row === null) throw new NotFoundError();
      if (row.numberEncrypted === null) {
        throw new UnprocessableError('no_number', 'This document has no number.');
      }
      // Rule 7: the audit row commits with the reveal or not at all.
      await audit.record({
        action: 'reveal',
        moduleKey: 'people',
        entityType: DOCUMENT_ENTITY,
        entityId: row.id,
        companyId: row.companyId,
        meta: { ownerType: row.ownerType, ownerId: row.ownerId },
      });
      return vault.open(row.numberEncrypted, 'people.document');
    });
    res.json({ value });
  });

  router.use(
    createCrudRouter(
      { uow, authorize: permissions.authorize, registry },
      {
        path: '/documents',
        resource: 'people.document',
        tag: 'Documents',
        repository,
        schemas: { create: documentCreateSchema, update: documentUpdateSchema, item, filter },
        toItem: toDocumentItem,
        toWhere: (f) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)),
      },
    ),
  );

  const tags = ['Documents'];
  const ifMatch = z.object({ 'If-Match': z.string() });
  registerRoute(registry, {
    method: 'post',
    path: '/documents/{id}/renew',
    tags,
    summary: 'Renew a document (the old one is kept as replaced)',
    request: {
      params: idParams,
      headers: ifMatch,
      body: { content: { 'application/json': { schema: documentRenewSchema } } },
    },
    responses: {
      201: { description: 'The new document', content: { 'application/json': { schema: item } } },
    },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/documents/{id}/files',
    tags,
    summary: 'Add a scan: a new page, or a new version of a page',
    request: {
      params: idParams,
      body: { content: { 'application/json': { schema: documentFileSchema } } },
    },
    responses: {
      201: {
        description: 'The attachment',
        content: { 'application/json': { schema: attachmentItem } },
      },
    },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/documents/{id}/reveal',
    tags,
    summary: 'Show the full document number (audited)',
    request: { params: idParams },
    responses: {
      200: {
        description: 'The number',
        content: { 'application/json': { schema: revealResponse } },
      },
    },
  });
  return router;
}
