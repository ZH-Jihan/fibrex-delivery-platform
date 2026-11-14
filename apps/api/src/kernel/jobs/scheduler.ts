/**
 * Job scheduler: recurring system jobs on BullMQ.
 *
 * Purpose: one place that owns every recurring background job (audit sealing, partition
 * maintenance, later payroll reminders and so on). Modules hand over a name, an interval
 * and a function; the scheduler stores the schedule in Redis, so it survives restarts and
 * runs once per interval even with several API instances (BullMQ's job schedulers are
 * keyed by name, and only one worker picks each run up).
 *
 * Failure handling: a job that throws is retried by BullMQ (3 attempts, exponential
 * backoff) and kept in the failed list for the job monitor. Jobs must be safe to run twice.
 *
 * Depends on: bullmq, ./connection.ts, kernel/observability/logger.ts.
 * Used by: src/main.ts, ./job-router.ts, test/integration/notify.test.ts.
 */
import { Queue, Worker } from 'bullmq';
import type { Logger } from '../observability/logger.js';
import { bullConnection } from './connection.js';

export interface RecurringJob {
  /** Unique name; also the BullMQ scheduler id. */
  name: string;
  /** Run every this many milliseconds. */
  everyMs: number;
  run: () => Promise<void>;
}

export const SYSTEM_QUEUE = 'system-jobs';

export class JobScheduler {
  private readonly jobs = new Map<string, RecurringJob>();
  private queue: Queue | undefined;
  private worker: Worker | undefined;

  private readonly redisUrl: string;
  private readonly logger: Logger;
  private readonly queueName: string;

  constructor(redisUrl: string, logger: Logger, queueName: string = SYSTEM_QUEUE) {
    this.redisUrl = redisUrl;
    this.logger = logger;
    this.queueName = queueName;
  }

  register(job: RecurringJob): void {
    if (this.jobs.has(job.name)) throw new Error(`Job registered twice: ${job.name}`);
    this.jobs.set(job.name, job);
  }

  /** Writes the schedules to Redis and starts working them off. */
  async start(): Promise<void> {
    const connection = bullConnection(this.redisUrl);
    const queue = new Queue(this.queueName, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: 50,
        removeOnFail: 200,
      },
    });
    this.queue = queue;
    for (const job of this.jobs.values()) {
      await queue.upsertJobScheduler(job.name, { every: job.everyMs }, { name: job.name });
    }
    this.worker = new Worker(
      this.queueName,
      async (item) => {
        const job = this.jobs.get(item.name);
        if (job === undefined) return; // a schedule left by an older version of the code
        await job.run();
      },
      { connection },
    );
    this.worker.on('failed', (item, err) => {
      this.logger.error({ job: item?.name, err }, 'recurring job failed');
    });
    this.worker.on('error', (err) => {
      this.logger.error({ err }, 'job worker error');
    });
  }

  /** The queue, for the job monitor. */
  getQueue(): Queue | undefined {
    return this.queue;
  }

  async stop(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
