/**
 * Redis connection settings for BullMQ.
 *
 * Purpose: BullMQ workers need `maxRetriesPerRequest: null` (they block on Redis waiting
 * for jobs), unlike the HTTP-facing client in ../redis/client.ts that must fail fast. So
 * queues get their own connection settings, built from the same REDIS_URL.
 *
 * Depends on: nothing. Used by: ./scheduler.ts, modules/notify/email-queue.ts.
 */
import type { ConnectionOptions } from 'bullmq';

export function bullConnection(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  const db = url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0;
  return {
    host: url.hostname,
    port: url.port === '' ? 6379 : Number(url.port),
    ...(url.username === '' ? {} : { username: decodeURIComponent(url.username) }),
    ...(url.password === '' ? {} : { password: decodeURIComponent(url.password) }),
    db: Number.isInteger(db) ? db : 0,
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}
