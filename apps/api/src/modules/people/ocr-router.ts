/**
 * Document OCR API (SPEC 5.12, PLAN 3.10 `ocr_job`): upload, pre-fill, confirm.
 *
 *   POST /ocr/jobs               read an uploaded scan; stores an ocr_job; creates NO document
 *   GET  /ocr/jobs/{id}          the reading again (for the confirm panel)
 *   POST /ocr/jobs/{id}/confirm  the person's checked values: creates the document, attaches
 *                                the scan to it and marks the job confirmed, in one transaction
 *
 * Rules, and why:
 *   1. Nothing from OCR is saved as a document without a person's confirmation. The confirm
 *      body is an ordinary document body: the person may change every field, and the normal
 *      document rules (owner, type, number vault, one current document) all apply.
 *   2. The number read is never stored in plain text: the job keeps it sealed with the party
 *      vault plus a keyed hash, and `result` holds only its mask. The plain number is sent
 *      back only to the person who uploaded the scan (they hold the paper), and only until
 *      the job is confirmed; after that the document's audited reveal is the only way.
 *   3. Flags (shared `deriveOcrFlags`): low confidence, name mismatch against the person the
 *      scan is for, expired, unreadable, cropped, and duplicate (a live document in the
 *      company already has this number: same keyed hash, so no plain number is compared).
 *   4. A failing adapter does not lose the upload: the job is stored as `failed` with the
 *      error, and the person can still confirm values typed by hand.
 *   5. Every adapter call writes an adapter health row (status, latency) in the shared layer.
 *   6. A job is confirmed once: the status check, the version check on update and the unique
 *      index on document.ocr_job_id all refuse a second document.
 *
 * Depends on: express, zod, @fibrex/shared (OCR and document schemas, flag rules),
 * adapters/ocr (interface), adapters/storage (interface), kernel/adapters/adapter-health,
 * kernel/db, kernel/http, modules/party (PartyService, PartyVault and helpers), modules/files
 * (attachment repository), ./document-router.ts.
 * Used by: ./index.ts.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  documentCreateSchema,
  documentNumberSchema,
  deriveOcrFlags,
  ocrJobCreateSchema,
  OCR_FLAGS,
  OCR_JOB_STATUSES,
  type OcrFieldName,
  type OcrFieldReading,
} from '@fibrex/shared';
import { Router } from 'express';
import { z } from 'zod';
import type { OcrAdapter, OcrReading } from '../../adapters/ocr/interface.js';
import type { StorageAdapter } from '../../adapters/storage/interface.js';
import { recordAdapterHealth } from '../../kernel/adapters/adapter-health.js';
import type { Db } from '../../kernel/db/prisma.js';
import { createRepository } from '../../kernel/db/repository.js';
import { currentUnit, type UnitOfWork } from '../../kernel/db/unit-of-work.js';
import { ConflictError, ValidationError } from '../../kernel/http/errors.js';
import { registerRoute } from '../../kernel/http/openapi.js';
import type { PermissionService } from '../../kernel/permissions/permission-service.js';
import { createAttachmentRepository, type AttachableRegistry } from '../files/index.js';
import {
  maskValue,
  normaliseSecretValue,
  type PartyService,
  type PartyVault,
} from '../party/index.js';
import { DOCUMENT_ENTITY, toDocumentItem, type DocumentRepository } from './document-router.js';

export type OcrJobRow = NonNullable<Awaited<ReturnType<Db['ocrJob']['findFirst']>>>;

/** Scans OCR can read: images and PDF (the files module has already checked the bytes). */
const SCAN_TYPES: ReadonlySet<string> = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

const invalid = (path: string, code: string, message: string) =>
  new ValidationError([{ path, code, message }]);

const isoDate = z.iso.date();
const field = z.object({ value: z.string().nullable(), confidence: z.number() });
const jobItem = z
  .object({
    id: z.uuid(),
    companyId: z.uuid(),
    status: z.enum(OCR_JOB_STATUSES),
    provider: z.string(),
    fileObjectId: z.uuid(),
    ownerId: z.uuid().nullable(),
    documentTypeId: z.uuid().nullable(),
    fields: z.object({
      documentTypeId: field,
      number: field.extend({ masked: z.string().nullable() }),
      holderName: field,
      issueDate: field,
      expiryDate: field,
    }),
    flags: z.array(z.enum(OCR_FLAGS)),
    error: z.string().nullable(),
    documentId: z.uuid().nullable(),
    version: z.number().int(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'OcrJob' });
const idParams = z.object({ id: z.uuid() });

/** One stored field of `result`. */
interface StoredField {
  field: OcrFieldName;
  value: string | null;
  confidence: number;
}

const clamp = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));

export interface OcrRouterDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  parties: PartyService;
  vault: PartyVault;
  attachables: AttachableRegistry;
  documents: DocumentRepository;
  storage: StorageAdapter;
  ocr: OcrAdapter;
  now?: () => Date;
}

/** What the bulk upload (row 3.7) reuses: the same read and the same confirm, no copy. */
export interface OcrEngine {
  router: Router;
  /** Reads one uploaded scan and stores the job. Call inside a unit of work. */
  createJob(db: Db, body: z.infer<typeof ocrJobCreateSchema>): Promise<OcrJobRow>;
  /** Saves the checked values as a document (scan attached) and marks the job confirmed. */
  confirmJob(
    id: string,
    body: z.infer<typeof documentCreateSchema>,
  ): Promise<Awaited<ReturnType<DocumentRepository['createFromOcr']>>>;
  toJobItem(row: OcrJobRow): Promise<z.infer<typeof jobItem>>;
}

export function createOcrRouter(deps: OcrRouterDeps): Router {
  return createOcrEngine(deps).router;
}

export function createOcrEngine(deps: OcrRouterDeps): OcrEngine {
  const { uow, registry, permissions, parties, vault, documents, storage, ocr } = deps;
  const now = deps.now ?? (() => new Date());
  const jobs = createRepository<OcrJobRow>({ model: 'ocrJob', scope: 'company' });
  const attachments = createAttachmentRepository({
    permissions,
    attachables: deps.attachables,
  });
  const router = Router();

  /** The API view of a job. Rule 2 decides whether the plain number is included. */
  async function toJobItem(row: OcrJobRow) {
    const { db, context } = currentUnit();
    const stored = (row.result as unknown as StoredField[] | null) ?? [];
    const byName = (name: OcrFieldName) => {
      const f = stored.find((s) => s.field === name);
      return { value: f?.value ?? null, confidence: f?.confidence ?? 0 };
    };
    const showNumber =
      row.numberEncrypted !== null &&
      row.status === 'completed' &&
      row.createdBy !== null &&
      row.createdBy === (context.userId ?? null);
    const document =
      row.status === 'confirmed'
        ? await db.document.findFirst({ where: { ocrJobId: row.id }, select: { id: true } })
        : null;
    return {
      id: row.id,
      companyId: row.companyId,
      status: row.status as (typeof OCR_JOB_STATUSES)[number],
      provider: row.provider,
      fileObjectId: row.fileObjectId,
      ownerId: row.ownerPartyId,
      documentTypeId: row.documentTypeId,
      fields: {
        documentTypeId: byName('documentType'),
        number: {
          value:
            showNumber && row.numberEncrypted !== null
              ? vault.open(row.numberEncrypted, 'people.document')
              : null,
          masked: byName('number').value,
          confidence: byName('number').confidence,
        },
        holderName: byName('holderName'),
        issueDate: byName('issueDate'),
        expiryDate: byName('expiryDate'),
      },
      flags: (row.flags as unknown as (typeof OCR_FLAGS)[number][] | null) ?? [],
      error: row.error,
      documentId: document?.id ?? null,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** Reads the scan; never throws for an adapter failure (rule 4). */
  async function readScan(input: Parameters<OcrAdapter['read']>[0]) {
    const started = performance.now();
    try {
      const reading = await ocr.read(input);
      await recordAdapterHealth('ocr', ocr.provider, {
        status: 'ok',
        latencyMs: performance.now() - started,
      });
      return { reading, error: null };
    } catch (err) {
      const error = err instanceof Error ? err.message : 'OCR failed';
      await recordAdapterHealth('ocr', ocr.provider, {
        status: 'down',
        latencyMs: performance.now() - started,
        error,
      });
      return { reading: null, error };
    }
  }

  router.post('/ocr/jobs', async (req, res) => {
    const body = ocrJobCreateSchema.parse(req.body);
    const out = await uow.run(async (db) => {
      await permissions.require('people.ocr_job.create');
      return toJobItem(await createJob(db, body));
    });
    res.status(201).json(out);
  });

  /** POST /ocr/jobs: steps 1 to 4. */
  async function createJob(db: Db, body: z.infer<typeof ocrJobCreateSchema>): Promise<OcrJobRow> {
    const { context } = currentUnit();
    const today = now().toISOString().slice(0, 10);

    // Step 1: the file, visible to the caller (row-level security), and a scan type.
    const file = await db.fileObject.findFirst({ where: { id: body.fileObjectId } });
    if (file === null) throw invalid('fileObjectId', 'unknown_file', 'No such file');
    if (!SCAN_TYPES.has(file.mimeType)) {
      throw invalid('fileObjectId', 'not_a_scan', 'Upload a photo (JPEG, PNG, WebP) or a PDF.');
    }
    // Step 2: the hints must live in the file's company.
    const owner = body.ownerId === undefined ? null : await parties.get(body.ownerId);
    if (body.ownerId !== undefined && owner === null) {
      throw invalid('ownerId', 'unknown_owner', 'No such person');
    }
    if (owner !== null && owner.companyId !== file.companyId) {
      throw invalid('ownerId', 'company_mismatch', 'The person belongs to another company');
    }
    const hintType =
      body.documentTypeId === undefined
        ? null
        : await db.documentType.findFirst({
            where: { id: body.documentTypeId, companyId: file.companyId, deletedAt: null },
          });
    if (body.documentTypeId !== undefined && hintType === null) {
      throw invalid('documentTypeId', 'unknown_document_type', 'No such document type');
    }
    const bytes = await storage.read(file.objectKey);
    if (bytes === null)
      throw invalid('fileObjectId', 'file_missing', 'The file is not in storage.');

    // Step 3: the adapter reads (rule 4: a failure is stored, not thrown).
    const { reading, error } = await readScan({
      bytes,
      mimeType: file.mimeType,
      fileName: file.originalName,
      documentTypeHint: hintType?.code ?? null,
      holderNameHint: owner?.displayName ?? null,
      today,
    });
    const base = {
      companyId: file.companyId,
      fileObjectId: file.id,
      provider: ocr.provider,
      ownerPartyId: owner?.id ?? null,
      documentTypeId: hintType?.id ?? null,
    };
    if (reading === null) {
      return jobs.create({ ...base, status: 'failed', flags: ['unreadable'], error });
    }

    // Step 4: turn the reading into stored fields (rule 2 for the number).
    const fields = await normalise(db, file.companyId, reading);
    const sealed =
      fields.number === null
        ? null
        : {
            numberEncrypted: vault.seal(fields.number, 'people.document'),
            numberHash:
              fields.type === null
                ? null
                : vault.hash(context.tenantId, `document:${fields.type.code}`, fields.number),
          };
    // Rule 3: a duplicate is a live document of the same type with the same keyed hash.
    const duplicate =
      sealed?.numberHash != null &&
      (await db.document.findFirst({
        where: { companyId: file.companyId, numberHash: sealed.numberHash, deletedAt: null },
        select: { id: true },
      })) !== null;
    const readings: Partial<Record<OcrFieldName, OcrFieldReading>> = {
      documentType: { value: fields.type?.id ?? null, confidence: fields.confidence.documentType },
      number: { value: fields.number, confidence: fields.confidence.number },
      holderName: { value: fields.holderName, confidence: fields.confidence.holderName },
      issueDate: { value: fields.issueDate, confidence: fields.confidence.issueDate },
      expiryDate: { value: fields.expiryDate, confidence: fields.confidence.expiryDate },
    };
    const flags = deriveOcrFlags({
      fields: readings,
      quality: reading.quality,
      expectedNames: owner === null ? [] : [owner.displayName],
      today,
      duplicate,
    });
    const result: StoredField[] = (Object.keys(readings) as OcrFieldName[]).map((name) => ({
      field: name,
      // Only the mask of the number is kept in `result` (rule 2).
      value:
        name === 'number'
          ? fields.number === null
            ? null
            : maskValue(fields.number)
          : (readings[name]?.value ?? null),
      confidence: readings[name]?.confidence ?? 0,
    }));
    return jobs.create({
      ...base,
      status: 'completed',
      result,
      flags,
      numberEncrypted: sealed?.numberEncrypted ?? null,
      numberHash: sealed?.numberHash ?? null,
    });
  }

  router.get('/ocr/jobs/:id', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const out = await uow.run(async () => {
      await permissions.require('people.ocr_job.read');
      return toJobItem(await jobs.get(id));
    });
    res.json(out);
  });

  /** Confirm steps (rules 1 and 6); the caller has checked permissions, inside a unit. */
  async function confirmJob(id: string, body: z.infer<typeof documentCreateSchema>) {
    const job = await jobs.get(id);
    if (job.status === 'confirmed') {
      throw new ConflictError('already_confirmed', 'This scan has already been saved.');
    }
    if (job.status === 'pending') {
      throw new ConflictError('not_ready', 'The scan is still being read.');
    }
    // Rule 1: the person's values go through the normal document rules.
    const document = await documents.createFromOcr(body, job.id);
    if (document.companyId !== job.companyId) {
      throw invalid('ownerId', 'company_mismatch', 'The scan belongs to another company');
    }
    // The scan becomes the document's first page (files module rules apply).
    await attachments.create({
      entityType: DOCUMENT_ENTITY,
      entityId: document.id,
      fileObjectId: job.fileObjectId,
      purpose: 'document_page',
      label: null,
      companyId: document.companyId,
    });
    // Rule 6: the version check refuses a second, concurrent confirm.
    await jobs.update(job.id, job.version, { status: 'confirmed' });
    return document;
  }

  router.post('/ocr/jobs/:id/confirm', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const body = documentCreateSchema.parse(req.body);
    const row = await uow.run(async () => {
      await permissions.require('people.ocr_job.read');
      await permissions.require('people.document.create');
      return confirmJob(id, body);
    });
    res
      .status(201)
      .set('ETag', `"${String(row.version)}"`)
      .json(toDocumentItem(row));
  });

  const tags = ['Documents'];
  registerRoute(registry, {
    method: 'post',
    path: '/ocr/jobs',
    tags,
    summary: 'Read an uploaded scan with OCR (pre-fill only; saves no document)',
    request: { body: { content: { 'application/json': { schema: ocrJobCreateSchema } } } },
    responses: {
      201: { description: 'The reading', content: { 'application/json': { schema: jobItem } } },
    },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/ocr/jobs/{id}',
    tags,
    summary: 'An OCR reading',
    request: { params: idParams },
    responses: {
      200: { description: 'The reading', content: { 'application/json': { schema: jobItem } } },
    },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/ocr/jobs/{id}/confirm',
    tags,
    summary: 'Save the checked values as a document, with the scan attached',
    request: {
      params: idParams,
      body: { content: { 'application/json': { schema: documentCreateSchema } } },
    },
    responses: {
      201: { description: 'The new document' },
    },
  });
  return { router, createJob, confirmJob, toJobItem };
}

/**
 * The reading in stored form: the type code becomes the company's type, the number is
 * normalised and dropped when it is not a valid number, dates that are not "YYYY-MM-DD" are
 * dropped. A dropped value keeps confidence 0, so it is not counted as read.
 */
async function normalise(db: Db, companyId: string, reading: OcrReading) {
  const type =
    reading.documentType.value === null
      ? null
      : await db.documentType.findFirst({
          where: { companyId, code: reading.documentType.value, deletedAt: null },
          select: { id: true, code: true },
        });
  const rawNumber = reading.number.value;
  const number =
    rawNumber !== null && documentNumberSchema.safeParse(rawNumber).success
      ? normaliseSecretValue(rawNumber)
      : null;
  const date = (v: string | null) => (v !== null && isoDate.safeParse(v).success ? v : null);
  const issueDate = date(reading.issueDate.value);
  const expiryDate = date(reading.expiryDate.value);
  const trimmed = reading.holderName.value?.trim().slice(0, 300) ?? '';
  const holderName = trimmed === '' ? null : trimmed;
  const keep = (value: unknown, confidence: number) => (value === null ? 0 : clamp(confidence));
  return {
    type,
    number,
    holderName,
    issueDate,
    expiryDate,
    confidence: {
      documentType: keep(type, reading.documentType.confidence),
      number: keep(number, reading.number.confidence),
      holderName: keep(holderName, reading.holderName.confidence),
      issueDate: keep(issueDate, reading.issueDate.confidence),
      expiryDate: keep(expiryDate, reading.expiryDate.confidence),
    },
  };
}
