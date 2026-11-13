/**
 * Redis connection.
 *
 * Purpose: one shared ioredis client for rate limits, idempotency records and (later) the
 * Socket.IO adapter. BullMQ creates its own connections from the same URL.
 *
 * `maxRetriesPerRequest: 1` makes a command fail fast while Redis is down instead of
 * hanging the HTTP request; each caller decides whether to fail open or closed.
 *
 * Depends on: ioredis. Used by: src/main.ts, kernel/http/rate-limit.ts,
 * kernel/http/idempotency.ts, health checks.
 */
import { Redis } from 'ioredis';

export type { Redis } from 'ioredis';

export function createRedis(url: string, name = 'fibrex-api'): Redis {
  return new Redis(url, {
    connectionName: name,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: true,
    lazyConnect: false,
  });
}
