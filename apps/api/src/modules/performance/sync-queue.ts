/**
 * Sync queue and schedules (phase 4 row 4.3; PLAN 3.11 `sync_source.schedule_cron`).
 *
 * Purpose: every sync run happens in this queue's worker, whatever started it:
 *   - the schedule of each active source (default `0 4 * * *` in Asia/Qatar, both read from
 *     the source row, so a different time is data, not code). BullMQ keeps one job
 *     scheduler per source, keyed `performance-sync:<source id>`; `syncSchedules()` writes
 *     them from the database at start-up and every few minutes, and removes the ones whose
 *     source was deleted or switched off;
 *   - "Run now", "Re-import range" and "Upload a day's Excel" (./sync-router.ts), queued as
 *     the person who clicked.
 * The worker calls `SyncService.run` with the tenant, company and person of the job, so the
 * request path and the scheduled path are the same code and the audit trail names the
 * person who asked (no person: the system schedule).
 *
 * Retries: a run whose source could not be read throws, and BullMQ tries again with an
 * exponential back-off (default 4 tries, 10 then 20 then 40 minutes), because a sheet that
 * is late in the morning is usually there a little later. Each try is its own run in the
 * run log. Admins are alerted when the last try fails (SyncService decides from the attempt
 * numbers given here). An upload is tried once: the same file will not read better later.
 *
 * Depends on: bullmq, kernel/jobs/connection, kernel/db (PrismaDb for the SECURITY DEFINER
 * source list), ./sync-service.ts. Used by: ./sync-router.ts, ./index.ts, src/main.ts, the
 * sync tests.
 */
import { Queue, Worker, type Job } from 'bullmq';
import type { PrismaDb } from '../../kernel/db/prisma.js';
import { bullConnection } from '../../kernel/jobs/connection.js';
import type { Logger } from '../../kernel/observability/logger.js';
import type { SyncAttempt, SyncOutcome, SyncRequest, SyncService } from './sync-service.js';

export const SYNC_QUEUE = 'performance-sync';
const SCHEDULER_PREFIX = 'performance-sync:';

export interface SyncJob {
  tenantId: string;
  companyId: string;
  /** The person who asked; absent for the scheduled run (the system). */
  userId?: string | undefined;
  request: SyncRequest;
}

export interface SyncQueueOptions {
  redisUrl: string;
  service: SyncService;
  /** Reads `performance.scheduled_sync_sources()` (every tenant). */
  prisma: PrismaDb;
  logger: Logger;
  /** Tries per run (not uploads). Default 4. */
  attempts?: number;
  /** First retry delay; doubles on each try. Default 10 minutes. */
  backoffMs?: number;
  /** Queue name (tests use their own). */
  queueName?: string;
}

export class SyncQueue {
  readonly #options: Required<Omit<SyncQueueOptions, 'queueName'>> & { queueName: string };
  readonly #queue: Queue<SyncJob>;
  #worker: Worker<SyncJob, SyncOutcome> | undefined;

  constructor(options: SyncQueueOptions) {
    this.#options = {
      attempts: 4,
      backoffMs: 10 * 60_000,
      queueName: SYNC_QUEUE,
      ...options,
    };
    this.#queue = new Queue<SyncJob>(this.#options.queueName, {
      connection: bullConnection(options.redisUrl),
      defaultJobOptions: { removeOnComplete: 200, removeOnFail: 500 },
    });
  }

  getQueue(): Queue<SyncJob> {
    return this.#queue;
  }

  #retryOptions(trigger: SyncRequest['trigger']) {
    return trigger === 'upload'
      ? { attempts: 1 }
      : {
          attempts: this.#options.attempts,
          backoff: { type: 'exponential' as const, delay: this.#options.backoffMs },
        };
  }

  /** Queues a run; returns the queue job id. */
  async enqueue(job: SyncJob): Promise<string> {
    const added = await this.#queue.add(job.request.trigger, job, {
      ...this.#retryOptions(job.request.trigger),
    });
    return added.id ?? '';
  }

  /** What the worker does with one job (one try). */
  async process(job: SyncJob, attempt: SyncAttempt): Promise<SyncOutcome> {
    return this.#options.service.run(
      {
        tenantId: job.tenantId,
        companyIds: [job.companyId],
        ...(job.userId === undefined ? {} : { userId: job.userId }),
      },
      job.request,
      attempt,
    );
  }

  /** Starts working jobs off. Call once, in the process that should run syncs. */
  startWorker(): void {
    this.#worker = new Worker<SyncJob, SyncOutcome>(
      this.#options.queueName,
      (item: Job<SyncJob, SyncOutcome>) =>
        this.process(item.data, {
          attempt: item.attemptsMade + 1,
          maxAttempts: item.opts.attempts ?? 1,
        }),
      { connection: bullConnection(this.#options.redisUrl), concurrency: 2 },
    );
    this.#worker.on('error', (err) => {
      this.#options.logger.error({ err }, 'performance sync worker error');
    });
    this.#worker.on('failed', (item, err) => {
      this.#options.logger.warn(
        { err, jobId: item?.id, attempt: item?.attemptsMade },
        'performance sync try failed',
      );
    });
  }

  /**
   * Writes one BullMQ job scheduler per active, schedulable source (cron and time zone from
   * the source row) and removes the schedulers of sources that are gone. Safe to run often.
   * Returns how many sources are scheduled.
   */
  async syncSchedules(): Promise<number> {
    const sources = await this.#options.prisma.$queryRaw<
      {
        tenant_id: string;
        company_id: string;
        sync_source_id: string;
        schedule_cron: string;
        time_zone: string;
      }[]
    >`SELECT tenant_id::text AS tenant_id, company_id::text AS company_id,
             sync_source_id::text AS sync_source_id, schedule_cron, time_zone
        FROM performance.scheduled_sync_sources()`;
    const wanted = new Set<string>();
    for (const source of sources) {
      const id = `${SCHEDULER_PREFIX}${source.sync_source_id}`;
      wanted.add(id);
      try {
        await this.#queue.upsertJobScheduler(
          id,
          { pattern: source.schedule_cron, tz: source.time_zone },
          {
            name: 'scheduled',
            data: {
              tenantId: source.tenant_id,
              companyId: source.company_id,
              // No readOn: the run takes today's date in the source's time zone.
              request: { syncSourceId: source.sync_source_id, trigger: 'scheduled' },
            },
            opts: this.#retryOptions('scheduled'),
          },
        );
      } catch (err) {
        // A cron text BullMQ cannot read stops only that source, and is logged.
        this.#options.logger.error(
          { err, syncSourceId: source.sync_source_id, cron: source.schedule_cron },
          'performance sync schedule rejected',
        );
      }
    }
    const existing = await this.#queue.getJobSchedulers(0, -1);
    for (const scheduler of existing) {
      const id = scheduler.id ?? scheduler.key;
      if (id.startsWith(SCHEDULER_PREFIX) && !wanted.has(id)) {
        await this.#queue.removeJobScheduler(id);
      }
    }
    return wanted.size;
  }

  async close(): Promise<void> {
    await this.#worker?.close();
    await this.#queue.close();
  }
}
