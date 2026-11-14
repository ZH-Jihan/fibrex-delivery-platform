/**
 * Email queue: delivers notification emails in the background.
 *
 * Purpose: sending email can be slow or fail, so it never happens inside a request. The
 * notification service puts a job on this BullMQ queue; the worker sends it through the
 * messaging adapter (SMTP) and records each outcome as a delivery row.
 *
 * Retries: a job that fails is retried up to 5 times with exponential backoff (10 s, 20 s,
 * 40 s ...). Every failed attempt is written as a `failed` delivery row (with the attempt
 * number), and the final success as `sent`, so the history shows what happened.
 *
 * Depends on: bullmq, adapters/messaging, kernel/db, kernel/jobs/connection.ts.
 * Used by: src/main.ts, test/integration/notify.test.ts.
 */
import { Queue, Worker } from 'bullmq';
import type { MessagingAdapter } from '../../adapters/messaging/interface.js';
import type { UnitOfWork } from '../../kernel/db/unit-of-work.js';
import { bullConnection } from '../../kernel/jobs/connection.js';
import type { Logger } from '../../kernel/observability/logger.js';
import type { EmailJob, EmailQueuePort } from './notify-service.js';

export const EMAIL_QUEUE = 'notify-email';
const MAX_ATTEMPTS = 5;

export class EmailQueue implements EmailQueuePort {
  private readonly queue: Queue;
  private worker: Worker | undefined;
  private readonly redisUrl: string;
  private readonly uow: UnitOfWork;
  private readonly messaging: MessagingAdapter;
  private readonly logger: Logger;
  private readonly backoffMs: number;

  constructor(options: {
    redisUrl: string;
    uow: UnitOfWork;
    messaging: MessagingAdapter;
    logger: Logger;
    /** First retry delay; doubles each time. Tests use a short one. */
    backoffMs?: number;
  }) {
    this.redisUrl = options.redisUrl;
    this.uow = options.uow;
    this.messaging = options.messaging;
    this.logger = options.logger;
    this.backoffMs = options.backoffMs ?? 10_000;
    this.queue = new Queue(EMAIL_QUEUE, {
      connection: bullConnection(options.redisUrl),
      defaultJobOptions: {
        attempts: MAX_ATTEMPTS,
        backoff: { type: 'exponential', delay: this.backoffMs },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    });
  }

  getQueue(): Queue {
    return this.queue;
  }

  async enqueue(job: EmailJob): Promise<void> {
    await this.queue.add('send', job);
  }

  /** Starts working jobs off. Call once, in the process that should send email. */
  startWorker(): void {
    this.worker = new Worker<EmailJob>(
      EMAIL_QUEUE,
      async (item) => {
        const job = item.data;
        const attempt = item.attemptsMade + 1;
        const context = { tenantId: job.tenantId, companyIds: [] as string[] };
        try {
          await this.messaging.send({
            channel: 'email',
            to: job.to,
            purpose: 'notification',
            subject: job.subject,
            text: job.text,
          });
        } catch (err) {
          await this.record(context, job, 'failed', attempt, 'the mail server refused the message');
          this.logger.warn({ err, attempt }, 'notification email failed');
          throw err;
        }
        await this.record(context, job, 'sent', attempt);
      },
      { connection: bullConnection(this.redisUrl), concurrency: 5 },
    );
    this.worker.on('error', (err) => {
      this.logger.error({ err }, 'email worker error');
    });
  }

  private async record(
    context: { tenantId: string; companyIds: string[] },
    job: EmailJob,
    status: 'sent' | 'failed',
    attempt: number,
    error?: string,
  ): Promise<void> {
    await this.uow.runAs(context, (db) =>
      db.notificationDelivery.create({
        data: {
          tenantId: job.tenantId,
          notificationId: job.notificationId,
          userId: job.userId,
          channel: 'email',
          status,
          attempt,
          address: job.to,
          ...(error === undefined ? {} : { error }),
        },
      }),
    );
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }
}
