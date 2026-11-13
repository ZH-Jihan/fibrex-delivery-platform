/**
 * Rate limiting (SPEC 2.11 "rate limits", SPEC 6.3).
 *
 * Purpose: cap how many requests one caller may make per time window, shared across all
 * API instances through Redis.
 *
 * Algorithm: fixed window counter. The key is `<prefix>:<caller>:<window number>`; one
 * Lua script increments it and sets its expiry atomically, so concurrent requests on
 * different servers cannot both see a stale count. A fixed window can let up to twice the
 * limit through around a window boundary; that is acceptable for abuse protection and
 * keeps the cost at one Redis round trip per request. Login and OTP endpoints add their
 * own stricter limiter (commit 7).
 *
 * Failure policy: if Redis is unreachable the request is ALLOWED and a warning is logged.
 * Rate limiting protects capacity; refusing every request because the limiter is down
 * would turn a Redis outage into a full API outage.
 *
 * Response headers (IETF draft "RateLimit header fields"): RateLimit-Limit,
 * RateLimit-Remaining, RateLimit-Reset (seconds), and Retry-After on 429.
 *
 * Depends on: ioredis, ../context/request-context.ts, ./errors.ts.
 * Used by: src/app.ts (and later per-route stricter limits).
 */
import type { RequestHandler } from 'express';
import type { Redis } from 'ioredis';
import { callerKey, currentContext } from '../context/request-context.js';
import type { Logger } from '../observability/logger.js';
import { TooManyRequestsError } from './errors.js';

// KEYS[1] = counter key, ARGV[1] = window length in ms.
// Returns { count after increment, milliseconds until the window ends }.
const INCREMENT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return { count, ttl }
`;

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the current window resets (at least 1). */
  resetSeconds: number;
}

export interface RateLimiterOptions {
  redis: Redis;
  keyPrefix: string;
  windowSeconds: number;
  /** Limit for a caller; lets authenticated callers get a higher limit. */
  limitFor: (caller: string) => number;
  now?: () => number;
}

export class RateLimiter {
  private readonly options: RateLimiterOptions;

  constructor(options: RateLimiterOptions) {
    this.options = options;
  }

  /** Counts one request for `caller` and decides whether it may proceed. */
  async hit(caller: string): Promise<RateLimitDecision> {
    const { redis, keyPrefix, windowSeconds, limitFor } = this.options;
    const now = this.options.now?.() ?? Date.now();
    const windowMs = windowSeconds * 1000;
    const window = Math.floor(now / windowMs);
    const key = `${keyPrefix}:${caller}:${String(window)}`;
    const [count, ttl] = (await redis.eval(INCREMENT_SCRIPT, 1, key, String(windowMs))) as [
      number,
      number,
    ];
    const limit = limitFor(caller);
    const msLeft = ttl > 0 ? ttl : windowMs - (now % windowMs);
    return {
      allowed: count <= limit,
      limit,
      remaining: Math.max(0, limit - count),
      resetSeconds: Math.max(1, Math.ceil(msLeft / 1000)),
    };
  }
}

export function rateLimitMiddleware(limiter: RateLimiter, logger: Logger): RequestHandler {
  return (_req, res, next) => {
    const ctx = currentContext();
    const caller = ctx ? callerKey(ctx) : 'ip:unknown';
    limiter
      .hit(caller)
      .then((d) => {
        res.setHeader('RateLimit-Limit', String(d.limit));
        res.setHeader('RateLimit-Remaining', String(d.remaining));
        res.setHeader('RateLimit-Reset', String(d.resetSeconds));
        if (d.allowed) {
          next();
        } else {
          next(new TooManyRequestsError(d.resetSeconds));
        }
      })
      .catch((err: unknown) => {
        // Fail open: see the header comment.
        logger.warn({ err }, 'rate limiter unavailable; request allowed');
        next();
      });
  };
}
