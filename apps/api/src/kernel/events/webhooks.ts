/**
 * Signed webhooks (phase 2 row 2.12; PLAN 3.8 `webhook_subscription`, `webhook_delivery`).
 *
 * Purpose: lets an outside system subscribe to Fibrex events. A subscription names a URL
 * and event types ('*' = all) for one company. When such an event is handed on by the
 * outbox relay, this dispatcher queues one delivery job per matching subscription; the
 * worker POSTs the event as JSON, signed, and writes one insert-only `webhook_delivery`
 * row per attempt.
 *
 * Signing (the receiver checks it; `verifyWebhookSignature` is the reference):
 *   Fibrex-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 *   The timestamp is inside the signed text, so an old delivery cannot be replayed later
 *   with a new time; receivers should refuse a `t` more than 5 minutes old. The secret is
 *   random per subscription, stored only encrypted (secret box, context
 *   "webhook_subscription:<id>"), and shown once when created or rotated.
 *
 * Retries: a non-2xx answer, a timeout or a network error is a failed attempt. BullMQ
 * retries with exponential backoff (default 8 attempts, 30 s doubling: about 1 h in all);
 * each failed row carries `next_retry_at`, the last one none. Redirects are not followed
 * (a 3xx is a failure), so a receiver cannot bounce the request somewhere else.
 *
 * Where requests may go: outside development and tests, only https URLs whose host is not
 * a loopback, private or link-local address, checked when the subscription is saved and
 * again (after DNS) before every attempt, so Fibrex cannot be used to reach its own
 * internal network.
 *
 * Depends on: bullmq, node:crypto, node:dns, kernel/crypto/secret-box.ts, kernel/db,
 * ./relay.ts (EventConsumer). Used by: src/main.ts, ./event-router.ts,
 * test/integration/events.test.ts.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Queue, Worker } from 'bullmq';
import type { SecretBox } from '../crypto/secret-box.js';
import { currentUnit, type UnitOfWork } from '../db/unit-of-work.js';
import { NotFoundError, ValidationError } from '../http/errors.js';
import { bullConnection } from '../jobs/connection.js';
import type { Logger } from '../observability/logger.js';
import type { EventConsumer, OutboxEvent } from './relay.js';

export const WEBHOOK_QUEUE = 'webhook-delivery';
export const WEBHOOK_CONSUMER = 'integration.webhooks';
export const SIGNATURE_HEADER = 'fibrex-signature';

export interface WebhookJob {
  tenantId: string;
  companyId: string;
  subscriptionId: string;
  eventId: string;
  manual: boolean;
}

/* ------------------------------------------------------------------------------------
 * Signing
 * ---------------------------------------------------------------------------------- */

export function signWebhook(secret: string, timestamp: number, body: string): string {
  const mac = createHmac('sha256', secret)
    .update(`${String(timestamp)}.${body}`)
    .digest('hex');
  return `t=${String(timestamp)},v1=${mac}`;
}

/** Reference check for receivers: right secret, untouched body, not older than `toleranceS`. */
export function verifyWebhookSignature(
  secret: string,
  header: string,
  body: string,
  nowS: number = Math.floor(Date.now() / 1000),
  toleranceS = 300,
): boolean {
  const parts = new Map(
    header.split(',').map((p) => {
      const at = p.indexOf('=');
      return [p.slice(0, at).trim(), p.slice(at + 1).trim()] as const;
    }),
  );
  const t = Number(parts.get('t'));
  const given = parts.get('v1') ?? '';
  if (!Number.isInteger(t) || Math.abs(nowS - t) > toleranceS) return false;
  const expected = signWebhook(secret, t, body).split('v1=')[1] ?? '';
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export const newWebhookSecret = (): string => `whsec_${randomBytes(32).toString('base64url')}`;
export const secretContext = (subscriptionId: string): string =>
  `webhook_subscription:${subscriptionId}`;

/* ------------------------------------------------------------------------------------
 * Where a webhook may point
 * ---------------------------------------------------------------------------------- */

/** True for loopback, private, link-local, unspecified and similar non-public addresses. */
export function isInternalAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped?.[1] !== undefined) return isInternalAddress(mapped[1]);
    return (
      lower === '::' ||
      lower === '::1' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('fe8') ||
      lower.startsWith('fe9') ||
      lower.startsWith('fea') ||
      lower.startsWith('feb') ||
      lower.startsWith('ff')
    );
  }
  return false;
}

/** Problem with a subscription URL, or null when it is acceptable. */
export function checkWebhookUrl(raw: string, allowInsecure: boolean): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'Not a valid URL';
  }
  if (url.username !== '' || url.password !== '')
    return 'The URL must not contain a user or password';
  if (url.protocol !== 'https:' && !(allowInsecure && url.protocol === 'http:')) {
    return 'The URL must use https';
  }
  if (allowInsecure) return null;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    return 'The URL must point to a public host';
  }
  if (isIP(host) !== 0 && isInternalAddress(host)) return 'The URL must point to a public host';
  return null;
}

/* ------------------------------------------------------------------------------------
 * Dispatcher
 * ---------------------------------------------------------------------------------- */

export interface WebhookDispatcherOptions {
  uow: UnitOfWork;
  redisUrl: string;
  box: SecretBox;
  logger: Logger;
  /** Allows http and internal hosts (development and tests only). */
  allowInsecure: boolean;
  attempts?: number;
  backoffMs?: number;
  timeoutMs?: number;
  now?: () => Date;
}

export class WebhookDispatcher {
  readonly #o: Required<Omit<WebhookDispatcherOptions, 'now'>> & { now: () => Date };
  readonly #queue: Queue;
  #worker: Worker | undefined;

  constructor(options: WebhookDispatcherOptions) {
    this.#o = {
      attempts: 8,
      backoffMs: 30_000,
      timeoutMs: 10_000,
      now: () => new Date(),
      ...options,
    };
    this.#queue = new Queue(WEBHOOK_QUEUE, {
      connection: bullConnection(options.redisUrl),
      defaultJobOptions: {
        attempts: this.#o.attempts,
        backoff: { type: 'exponential', delay: this.#o.backoffMs },
        removeOnComplete: 1_000,
        removeOnFail: 1_000,
      },
    });
  }

  get allowInsecure(): boolean {
    return this.#o.allowInsecure;
  }

  getQueue(): Queue {
    return this.#queue;
  }

  /** The outbox consumer: one delivery job per active subscription that wants the event. */
  consumer(): EventConsumer {
    return {
      key: WEBHOOK_CONSUMER,
      eventTypes: '*',
      handle: (event) => this.#fanOut(event),
    };
  }

  async #fanOut(event: OutboxEvent): Promise<void> {
    // Subscriptions belong to a company; tenant-level events have no subscribers.
    if (event.companyId === null) return;
    const { db } = currentUnit();
    const subscriptions = await db.webhookSubscription.findMany({
      where: {
        companyId: event.companyId,
        active: true,
        deletedAt: null,
        OR: [{ eventTypeKeys: { has: event.eventType } }, { eventTypeKeys: { has: '*' } }],
      },
      select: { id: true },
    });
    for (const sub of subscriptions) {
      const job: WebhookJob = {
        tenantId: event.tenantId,
        companyId: event.companyId,
        subscriptionId: sub.id,
        eventId: event.id,
        manual: false,
      };
      // Queued inside the consumer's transaction: the job reads only rows that are already
      // committed (event, subscription), and the job id stops a re-run queuing it twice.
      await this.#queue.add('deliver', job, { jobId: `${sub.id}__${event.id}` });
    }
  }

  /** Sends one delivery again now (one attempt, marked manual). Runs in the caller's unit. */
  async retry(deliveryId: string): Promise<void> {
    const { db } = currentUnit();
    const delivery = await db.webhookDelivery.findFirst({ where: { id: deliveryId } });
    if (delivery === null) throw new NotFoundError();
    const sub = await db.webhookSubscription.findFirst({
      where: { id: delivery.subscriptionId, deletedAt: null },
    });
    if (sub === null) throw new NotFoundError();
    if (!sub.active) {
      throw new ValidationError([
        { path: 'subscription', code: 'inactive', message: 'The subscription is switched off' },
      ]);
    }
    const job: WebhookJob = {
      tenantId: delivery.tenantId,
      companyId: delivery.companyId,
      subscriptionId: delivery.subscriptionId,
      eventId: delivery.eventId,
      manual: true,
    };
    await this.#queue.add('deliver', job, {
      jobId: `${delivery.subscriptionId}__${delivery.eventId}__manual__${String(Date.now())}`,
      attempts: 1,
    });
  }

  /**
   * One attempt. Writes its delivery row, then throws when it failed so BullMQ retries.
   * Returns the HTTP status (or null) for tests.
   */
  async deliver(job: WebhookJob, attempt: number, lastAttempt: boolean): Promise<number | null> {
    const { uow, box } = this.#o;
    const context = { tenantId: job.tenantId, companyIds: [job.companyId] };
    const loaded = await uow.runAs(context, async (db) => {
      const sub = await db.webhookSubscription.findFirst({
        where: { id: job.subscriptionId, deletedAt: null },
      });
      const event = await db.outboxEvent.findFirst({ where: { id: job.eventId } });
      return sub === null || event === null ? null : { sub, event };
    });
    // Deleted or switched off since it was queued: nothing to send, nothing to log.
    if (loaded === null || (!loaded.sub.active && !job.manual)) return null;
    const { sub, event } = loaded;

    const body = JSON.stringify({
      id: event.id,
      type: event.eventTypeKey,
      version: event.eventVersion,
      occurredAt: event.occurredAt.toISOString(),
      companyId: event.companyId,
      aggregate: { type: event.aggregateType, id: event.aggregateId },
      data: event.payload,
    });
    const secret = box.open(sub.secretEncrypted, secretContext(sub.id)).toString('utf8');
    const timestamp = Math.floor(this.#o.now().getTime() / 1000);

    let statusCode: number | null = null;
    let error: string | null = null;
    const started = performance.now();
    try {
      await this.#assertPublic(sub.url);
      const response = await fetch(sub.url, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(this.#o.timeoutMs),
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Fibrex-Webhooks/1',
          'fibrex-event-id': event.id,
          'fibrex-event-type': event.eventTypeKey,
          'fibrex-delivery-attempt': String(attempt),
          [SIGNATURE_HEADER]: signWebhook(secret, timestamp, body),
        },
        body,
      });
      statusCode = response.status;
      await response.body?.cancel(); // the answer's content is not needed
      if (statusCode < 200 || statusCode > 299) error = `HTTP ${String(statusCode)}`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const responseMs = Math.round(performance.now() - started);
    const failed = error !== null;
    const nextRetryAt =
      failed && !lastAttempt && !job.manual
        ? new Date(this.#o.now().getTime() + this.#o.backoffMs * 2 ** (attempt - 1))
        : null;

    await uow.runAs(context, (db) =>
      db.webhookDelivery.create({
        data: {
          tenantId: job.tenantId,
          companyId: job.companyId,
          subscriptionId: sub.id,
          eventId: event.id,
          eventTypeKey: event.eventTypeKey,
          attempt,
          status: failed ? 'failed' : 'succeeded',
          statusCode,
          responseMs,
          error: error?.slice(0, 2000) ?? null,
          nextRetryAt,
          manual: job.manual,
        },
      }),
    );
    if (failed) throw new Error(`Webhook delivery failed: ${error}`);
    return statusCode;
  }

  /** Re-checks the host after DNS, so a public name cannot resolve to an internal address. */
  async #assertPublic(raw: string): Promise<void> {
    if (this.#o.allowInsecure) return;
    const problem = checkWebhookUrl(raw, false);
    if (problem !== null) throw new Error(problem);
    const host = new URL(raw).hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host) !== 0 ? [{ address: host }] : await lookup(host, { all: true });
    if (addresses.some((a) => isInternalAddress(a.address))) {
      throw new Error('The URL resolves to an internal address');
    }
  }

  startWorker(): void {
    this.#worker = new Worker<WebhookJob>(
      WEBHOOK_QUEUE,
      async (item) => {
        const attempt = item.attemptsMade + 1;
        await this.deliver(item.data, attempt, attempt >= (item.opts.attempts ?? 1));
      },
      { connection: bullConnection(this.#o.redisUrl), concurrency: 5 },
    );
    this.#worker.on('failed', (item, err) => {
      const data = item?.data as WebhookJob | undefined;
      this.#o.logger.warn(
        { err: err.message, subscriptionId: data?.subscriptionId },
        'webhook attempt failed',
      );
    });
    this.#worker.on('error', (err) => {
      this.#o.logger.error({ err }, 'webhook worker error');
    });
  }

  async close(): Promise<void> {
    await this.#worker?.close();
    await this.#queue.close();
  }
}
