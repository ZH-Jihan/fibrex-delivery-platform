/**
 * Outbox relay and consumer registry (phase 2 row 2.12; PLAN 2.6 "Outbox").
 *
 * Purpose: hands every committed outbox event (./outbox.ts) to the consumers that want it
 * (notification rules, webhooks, later automations and search), each in the background,
 * each exactly once in effect.
 *
 * How, step by step, and why:
 *   1. `publishPending()` asks `integration.outbox_pending()` for events no relay has handed
 *      on. That function is SECURITY DEFINER because the relay serves every tenant and must
 *      find them before it can open a unit of work per tenant; it returns ids only.
 *   2. Per event, inside a unit of work for the event's tenant and company, the relay first
 *      CLAIMS the event by inserting its own `event_consumption` row (consumer
 *      "outbox.relay"). With two API instances, the second insert waits for the first and
 *      then finds the row, so only one instance hands the event on.
 *   3. Still inside that transaction it queues one BullMQ job per interested consumer, with
 *      a job id made of consumer and event. If the transaction then fails, the claim rolls
 *      back and a later run queues again; BullMQ ignores a job id it still holds, and step 4
 *      makes a second run harmless anyway.
 *   4. The worker (`consume`) opens a unit of work, inserts the consumer's own
 *      `event_consumption` row (ON CONFLICT DO NOTHING) and, only if that row is new, runs
 *      the consumer in the SAME transaction. Work and "done" mark commit together, so a
 *      crash or a retry can never run a consumer twice for one event. A consumer that throws
 *      rolls back its mark too, and BullMQ retries it with backoff.
 *   5. Runs happen on a recurring job (every few seconds) and on a nudge after every commit
 *      that wrote an event, so events normally go out at once and are never stranded.
 *
 * Depends on: bullmq, kernel/db (Prisma, UnitOfWork), kernel/jobs/connection.ts.
 * Used by: src/main.ts, ./webhooks.ts (consumer), modules/notify consumer (wired in
 * main.ts), test/integration/events.test.ts.
 */
import { Queue, Worker } from 'bullmq';
import type { PrismaDb } from '../db/prisma.js';
import type { DbContext, UnitOfWork } from '../db/unit-of-work.js';
import { currentUnit } from '../db/unit-of-work.js';
import { bullConnection } from '../jobs/connection.js';
import type { Logger } from '../observability/logger.js';

export const OUTBOX_QUEUE = 'outbox-events';
/** The relay's own consumer key: its consumption row means "handed on" (published). */
export const RELAY_CONSUMER = 'outbox.relay';

/** An outbox event as consumers receive it. */
export interface OutboxEvent {
  id: string;
  tenantId: string;
  companyId: string | null;
  eventType: string;
  eventVersion: number;
  aggregateType: string;
  aggregateId: string | null;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

/**
 * A consumer. `handle` runs inside a unit of work for the event's tenant (and company,
 * when the event has one), together with the consumer's "processed" mark.
 */
export interface EventConsumer {
  /** Stable key, for example "notify.rules"; stored in event_consumption. */
  key: string;
  /** Event types it wants, or "*" for all. */
  eventTypes: readonly string[] | '*';
  handle(event: OutboxEvent): Promise<void>;
}

interface RelayJob {
  eventId: string;
  occurredAt: string;
  tenantId: string;
  companyId: string | null;
  consumerKey: string;
}

const KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

const contextOf = (tenantId: string, companyId: string | null): DbContext => ({
  tenantId,
  companyIds: companyId === null ? [] : [companyId],
});

/** Inserts the consumption mark; false when the consumer already handled the event. */
async function claim(consumerKey: string, eventId: string): Promise<boolean> {
  const { db, context } = currentUnit();
  const inserted = await db.$executeRaw`
    INSERT INTO integration.event_consumption (tenant_id, consumer_key, event_id)
    VALUES (${context.tenantId}::uuid, ${consumerKey}, ${eventId}::uuid)
    ON CONFLICT (consumer_key, event_id) DO NOTHING`;
  return inserted === 1;
}

export class OutboxRelay {
  readonly #consumers = new Map<string, EventConsumer>();
  readonly #prisma: PrismaDb;
  readonly #uow: UnitOfWork;
  readonly #logger: Logger;
  readonly #redisUrl: string;
  readonly #queue: Queue;
  #worker: Worker | undefined;
  #running = false;
  #again = false;

  constructor(options: {
    prisma: PrismaDb;
    uow: UnitOfWork;
    redisUrl: string;
    logger: Logger;
    /** Tries per consumer job (default 5) and the first retry delay (doubles each time). */
    attempts?: number;
    backoffMs?: number;
  }) {
    this.#prisma = options.prisma;
    this.#uow = options.uow;
    this.#logger = options.logger;
    this.#redisUrl = options.redisUrl;
    this.#queue = new Queue(OUTBOX_QUEUE, {
      connection: bullConnection(options.redisUrl),
      defaultJobOptions: {
        attempts: options.attempts ?? 5,
        backoff: { type: 'exponential', delay: options.backoffMs ?? 5_000 },
        removeOnComplete: 1_000,
        removeOnFail: 1_000,
      },
    });
  }

  register(consumer: EventConsumer): void {
    if (!KEY.test(consumer.key) || consumer.key === RELAY_CONSUMER) {
      throw new Error(`Invalid event consumer key: ${consumer.key}`);
    }
    if (this.#consumers.has(consumer.key)) {
      throw new Error(`Event consumer registered twice: ${consumer.key}`);
    }
    this.#consumers.set(consumer.key, consumer);
  }

  getQueue(): Queue {
    return this.#queue;
  }

  /** Steps 1-3 of the header. Returns how many events were handed on. */
  async publishPending(limit = 200): Promise<number> {
    const pending = await this.#prisma.$queryRaw<
      { id: string; tenant_id: string; company_id: string | null }[]
    >`
      SELECT id::text AS id, tenant_id::text AS tenant_id, company_id::text AS company_id
        FROM integration.outbox_pending(${limit}::integer)`;
    let handed = 0;
    for (const ref of pending) {
      try {
        const done = await this.#uow.runAs(contextOf(ref.tenant_id, ref.company_id), () =>
          this.#handOn(ref.id),
        );
        if (done) handed += 1;
      } catch (err) {
        // One event's failure (Redis down, a bad row) must not hold up the others; it stays
        // pending and the next run tries again.
        this.#logger.error({ err, eventId: ref.id }, 'outbox relay could not hand on an event');
      }
    }
    return handed;
  }

  async #handOn(eventId: string): Promise<boolean> {
    if (!(await claim(RELAY_CONSUMER, eventId))) return false; // another instance did it
    const { db } = currentUnit();
    const event = await db.outboxEvent.findFirstOrThrow({ where: { id: eventId } });
    for (const consumer of this.#consumers.values()) {
      if (consumer.eventTypes !== '*' && !consumer.eventTypes.includes(event.eventTypeKey)) {
        continue;
      }
      const job: RelayJob = {
        eventId,
        occurredAt: event.occurredAt.toISOString(),
        tenantId: event.tenantId,
        companyId: event.companyId,
        consumerKey: consumer.key,
      };
      await this.#queue.add(consumer.key, job, { jobId: `${consumer.key}__${eventId}` });
    }
    return true;
  }

  /**
   * Step 5: a run right after a commit. Runs never overlap in this process; a nudge that
   * arrives during a run causes one more run when it ends.
   */
  nudge(): void {
    if (this.#running) {
      this.#again = true;
      return;
    }
    this.#running = true;
    void (async () => {
      try {
        do {
          this.#again = false;
          await this.publishPending();
        } while (this.#rerunRequested());
      } catch (err) {
        this.#logger.error({ err }, 'outbox relay run failed');
      } finally {
        this.#running = false;
      }
    })();
  }

  /** Read through a method: a nudge may set it while `publishPending` awaits. */
  #rerunRequested(): boolean {
    return this.#again;
  }

  /** Step 4: runs one consumer for one event. False when it had already run. */
  async consume(job: RelayJob): Promise<boolean> {
    const consumer = this.#consumers.get(job.consumerKey);
    if (consumer === undefined) {
      // Queued by an older version of the code; nothing to do.
      this.#logger.warn({ consumer: job.consumerKey }, 'outbox job for an unknown consumer');
      return false;
    }
    return this.#uow.runAs(contextOf(job.tenantId, job.companyId), async (db) => {
      if (!(await claim(consumer.key, job.eventId))) return false;
      const row = await db.outboxEvent.findFirstOrThrow({
        where: { id: job.eventId, occurredAt: new Date(job.occurredAt) },
      });
      await consumer.handle({
        id: row.id,
        tenantId: row.tenantId,
        companyId: row.companyId,
        eventType: row.eventTypeKey,
        eventVersion: row.eventVersion,
        aggregateType: row.aggregateType,
        aggregateId: row.aggregateId,
        payload: row.payload as Record<string, unknown>,
        occurredAt: row.occurredAt,
      });
      return true;
    });
  }

  /** Starts working consumer jobs off. Call once, in the process that should run them. */
  startWorker(): void {
    this.#worker = new Worker<RelayJob>(
      OUTBOX_QUEUE,
      async (item) => {
        await this.consume(item.data);
      },
      { connection: bullConnection(this.#redisUrl), concurrency: 5 },
    );
    this.#worker.on('failed', (item, err) => {
      const data = item?.data as RelayJob | undefined;
      this.#logger.error(
        { err, consumer: data?.consumerKey, eventId: data?.eventId },
        'event consumer failed',
      );
    });
    this.#worker.on('error', (err) => {
      this.#logger.error({ err }, 'outbox worker error');
    });
  }

  async close(): Promise<void> {
    await this.#worker?.close();
    await this.#queue.close();
  }
}
