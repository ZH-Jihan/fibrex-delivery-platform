/**
 * Import queue: commits an import in the background.
 *
 * Purpose: creating thousands of records takes longer than a request should, so the commit
 * button only marks the job `queued` and puts its id here; the worker then calls
 * `ImportService.runCommit` as the person who clicked. The service does the real work (one
 * transaction, all or nothing) and records success or failure on the job, so this file only
 * moves the job id from the request to the worker.
 *
 * One attempt only: a failed commit has already been recorded on the job with the reason,
 * and the person decides what to do (fix the file, preview again). An automatic retry would
 * find the job `failed` and do nothing anyway.
 *
 * Depends on: bullmq, ./import-service, kernel/jobs/connection. Used by: ./import-router,
 * src/main.ts.
 */
import { Queue, Worker } from 'bullmq';
import { bullConnection } from '../jobs/connection.js';
import type { Logger } from '../observability/logger.js';
import type { ImportService } from './import-service.js';

export const IMPORT_QUEUE = 'import-commit';

export interface ImportCommitJob {
  tenantId: string;
  companyId: string;
  userId?: string | undefined;
  jobId: string;
}

export class ImportQueue {
  private readonly queue: Queue;
  private worker: Worker<ImportCommitJob> | undefined;

  private readonly options: { redisUrl: string; service: ImportService; logger: Logger };

  constructor(options: { redisUrl: string; service: ImportService; logger: Logger }) {
    this.options = options;
    this.queue = new Queue(IMPORT_QUEUE, {
      connection: bullConnection(options.redisUrl),
      defaultJobOptions: { attempts: 1, removeOnComplete: 100, removeOnFail: 500 },
    });
  }

  getQueue(): Queue {
    return this.queue;
  }

  async enqueue(job: ImportCommitJob): Promise<void> {
    // The job id is the import's id, so queueing the same import twice is one queue entry.
    await this.queue.add('commit', job, { jobId: `import-${job.jobId}` });
  }

  /** Runs the commit now (what the worker does; also called directly by tests). */
  async process(job: ImportCommitJob) {
    return this.options.service.runCommit(
      {
        tenantId: job.tenantId,
        companyIds: [job.companyId],
        ...(job.userId === undefined ? {} : { userId: job.userId }),
      },
      job.jobId,
    );
  }

  /** Starts working jobs off. Call once, in the process that should run imports. */
  startWorker(): void {
    this.worker = new Worker<ImportCommitJob>(IMPORT_QUEUE, (item) => this.process(item.data), {
      connection: bullConnection(this.options.redisUrl),
      concurrency: 2,
    });
    this.worker.on('error', (err) => {
      this.options.logger.error({ err }, 'import worker error');
    });
    this.worker.on('failed', (item, err) => {
      this.options.logger.warn({ err, jobId: item?.id }, 'import job failed');
    });
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }
}
