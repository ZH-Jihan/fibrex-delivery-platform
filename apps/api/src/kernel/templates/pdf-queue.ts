/**
 * PDF queue: makes a PDF document from a template in the background.
 *
 * Purpose: drawing a PDF takes a browser and a second or two, so it never happens inside a
 * request. A module calls `enqueue` with the template key, language, company and merge data;
 * the worker produces the PDF and records it. `produce` does the work and is also what the
 * tests call directly.
 *
 * Steps in `produce`, and why they are split into two short transactions:
 *   1. Transaction 1 (read only): pick the published version (TemplateService.resolve) and
 *      render its HTML. Only `pdf` templates are accepted.
 *   2. Outside any transaction: the PDF adapter draws the PDF. A slow browser must not hold a
 *      database connection open.
 *   3. Store the bytes in object storage under a key built here (tenant/company/month/uuid).
 *   4. Transaction 2: insert the `file_object` (size and SHA-256 measured from our own bytes)
 *      and then the insert-only `generated_document`, which names the template version, the
 *      hash and a copy of the merge data. The file goes first because generated_document
 *      cannot be updated afterwards to add the file.
 * If step 4 fails the stored object is left unreferenced (harmless; a later clean-up job can
 * remove such objects); no half-written document row ever exists.
 *
 * Retries: BullMQ retries a failed job 3 times with backoff; a template with no published
 * version fails at once (retrying cannot help) and is not retried.
 *
 * Depends on: bullmq, adapters/pdf, adapters/storage, kernel/db, ./template-service,
 * ./template-render. Used by: src/main.ts, the modules that print documents (later phases).
 */
import { createHash, randomUUID } from 'node:crypto';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import type { PdfRenderer } from '../../adapters/pdf/interface.js';
import type { StorageAdapter } from '../../adapters/storage/interface.js';
import type { UnitOfWork } from '../db/unit-of-work.js';
import { bullConnection } from '../jobs/connection.js';
import type { Logger } from '../observability/logger.js';
import { hashMergeData, renderVersion } from './template-render.js';
import { TemplateService } from './template-service.js';

export const PDF_QUEUE = 'template-pdf';

export interface PdfJob {
  tenantId: string;
  companyId: string;
  /** Who asked, if a person did; recorded as `generated_by`. */
  userId?: string | undefined;
  templateKey: string;
  language: string;
  data: Record<string, unknown>;
  /** The record this document is about, so it can be found again from that record. */
  entityType?: string | undefined;
  entityId?: string | undefined;
  /** The day the document is for (ISO date); defaults to today. */
  onDate?: string | undefined;
}

export interface PdfResult {
  generatedDocumentId: string;
  fileObjectId: string;
}

export class PdfQueue {
  private readonly queue: Queue;
  private worker: Worker<PdfJob, PdfResult> | undefined;
  private readonly templates = new TemplateService();
  private readonly options: {
    redisUrl: string;
    uow: UnitOfWork;
    storage: StorageAdapter;
    renderer: PdfRenderer;
    logger: Logger;
  };

  constructor(options: {
    redisUrl: string;
    uow: UnitOfWork;
    storage: StorageAdapter;
    renderer: PdfRenderer;
    logger: Logger;
    /** First retry delay; doubles each time. Tests use a short one. */
    backoffMs?: number;
  }) {
    this.options = options;
    this.queue = new Queue(PDF_QUEUE, {
      connection: bullConnection(options.redisUrl),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: options.backoffMs ?? 5_000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    });
  }

  getQueue(): Queue {
    return this.queue;
  }

  async enqueue(job: PdfJob): Promise<string | undefined> {
    const added = await this.queue.add('render', job);
    return added.id;
  }

  /** Starts working jobs off. Call once, in the process that should draw PDFs. */
  startWorker(): void {
    this.worker = new Worker<PdfJob, PdfResult>(PDF_QUEUE, (item) => this.produce(item.data), {
      connection: bullConnection(this.options.redisUrl),
      // A browser page is heavy; a few at a time is plenty.
      concurrency: 2,
    });
    this.worker.on('error', (err) => {
      this.options.logger.error({ err }, 'pdf worker error');
    });
    this.worker.on('failed', (item, err) => {
      this.options.logger.warn({ err, jobId: item?.id }, 'pdf job failed');
    });
  }

  /** Makes one PDF and records it. Throws; nothing is recorded unless everything worked. */
  async produce(job: PdfJob): Promise<PdfResult> {
    const { uow, storage, renderer } = this.options;
    const context = {
      tenantId: job.tenantId,
      companyIds: [job.companyId],
      ...(job.userId === undefined ? {} : { userId: job.userId }),
    };

    // Step 1: which version, and its HTML.
    const prepared = await uow.runAs(context, async () => {
      let resolved;
      try {
        resolved = await this.templates.resolve(job.templateKey, {
          language: job.language,
          companyId: job.companyId,
          ...(job.onDate === undefined ? {} : { onDate: new Date(job.onDate) }),
        });
      } catch (err) {
        // Nothing published (or no such template): a retry will not change that.
        throw new UnrecoverableError(err instanceof Error ? err.message : 'No template');
      }
      const { template, version } = resolved;
      if (template.kind !== 'pdf') {
        throw new UnrecoverableError(`Template "${template.key}" is not a PDF template.`);
      }
      let rendered;
      try {
        rendered = renderVersion(
          {
            kind: template.kind,
            subject: version.subject,
            body: version.body,
            css: version.css,
            paper: version.paper,
          },
          job.data,
        );
      } catch (err) {
        throw new UnrecoverableError(err instanceof Error ? err.message : 'Render failed');
      }
      return {
        versionId: version.id,
        paper: version.paper,
        html: rendered.html,
        key: template.key,
      };
    });

    // Step 2: draw the PDF with no transaction open.
    const pdf = await renderer.render(prepared.html, prepared.paper);

    // Step 3: store the bytes.
    const month = new Date().toISOString().slice(0, 7);
    const objectKey = `${job.tenantId}/${job.companyId}/${month}/${randomUUID()}`;
    await storage.store(objectKey, pdf, 'application/pdf');

    // Step 4: the file row, then the document row.
    return uow.runAs(context, async (db) => {
      const file = await db.fileObject.create({
        data: {
          tenantId: job.tenantId,
          companyId: job.companyId,
          bucket: storage.bucket,
          objectKey,
          sha256: createHash('sha256').update(pdf).digest('hex'),
          sizeBytes: BigInt(pdf.length),
          mimeType: 'application/pdf',
          originalName: `${prepared.key}-${objectKey.slice(-8)}.pdf`,
        },
      });
      const document = await db.generatedDocument.create({
        data: {
          tenantId: job.tenantId,
          companyId: job.companyId,
          templateVersionId: prepared.versionId,
          entityType: job.entityType ?? null,
          entityId: job.entityId ?? null,
          fileObjectId: file.id,
          dataHash: hashMergeData(job.data),
          mergeData: job.data as object,
          generatedBy: job.userId ?? null,
        },
      });
      return { generatedDocumentId: document.id, fileObjectId: file.id };
    });
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
    await this.options.renderer.close();
  }
}
