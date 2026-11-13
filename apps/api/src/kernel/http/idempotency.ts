/**
 * Idempotency keys for write requests (SPEC 2.11 "idempotency keys on all write endpoints").
 *
 * Why: a rider on a slow connection taps "submit" twice, or a network drop makes the app
 * retry. Without protection that can post the same payment or loan twice. With an
 * Idempotency-Key header, a repeated request returns the first response instead of doing
 * the work again.
 *
 * Behaviour (following the IETF draft "The Idempotency-Key HTTP Header Field"):
 *   1. POST, PUT, PATCH and DELETE must send `Idempotency-Key` (8-255 visible ASCII
 *      characters); otherwise 400 idempotency_key_required. Routes can be exempted
 *      (login, refresh, logout), which are safe to repeat or protected differently.
 *   2. Keys are scoped to the caller (user, API client, or client address before login),
 *      so two users can never collide or read each other's responses.
 *   3. A fingerprint (SHA-256 of method, path and body) is stored with the key. The same
 *      key with a different request gets 422 idempotency_key_reused.
 *   4. The first request reserves the key in Redis with SET NX (an atomic "claim"). A
 *      second request arriving while the first is still running gets 409
 *      idempotency_request_in_progress. The reservation expires after a lock timeout so a
 *      crashed server cannot block the key forever.
 *   5. When the first request finishes with a status below 500, its status, body and
 *      content type are stored for the TTL (default 24 hours) and replayed to repeats with
 *      `Idempotent-Replayed: true`. A 5xx response releases the key, so the client may
 *      retry a failure that the server caused.
 *
 * Failure policy: if Redis is unreachable, write requests are REFUSED with 503. Accepting
 * them would remove the duplicate protection exactly when it matters for money.
 *
 * Depends on: ioredis, node:crypto, ../context/request-context.ts, ./errors.ts.
 * Used by: src/app.ts (mounted on /api/v1).
 */
import { createHash } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import type { Redis } from 'ioredis';
import { callerKey, currentContext } from '../context/request-context.js';
import type { Logger } from '../observability/logger.js';
import {
  BadRequestError,
  ConflictError,
  ServiceUnavailableError,
  UnprocessableError,
} from './errors.js';

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
export const REPLAYED_HEADER = 'Idempotent-Replayed';
const KEY_FORMAT = /^[\x21-\x7E]{8,255}$/;
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

interface InProgressRecord {
  state: 'in_progress';
  fingerprint: string;
}

interface CompletedRecord {
  state: 'completed';
  fingerprint: string;
  status: number;
  contentType: string | undefined;
  body: string;
}

type IdempotencyRecord = InProgressRecord | CompletedRecord;

export interface IdempotencyOptions {
  redis: Redis;
  logger: Logger;
  ttlSeconds: number;
  lockSeconds: number;
  /** Requests for which no key is required (for example login). */
  exempt?: (req: Request) => boolean;
  keyPrefix?: string;
}

/**
 * Canonical JSON: object keys sorted, so `{"a":1,"b":2}` and `{"b":2,"a":1}` give the same
 * fingerprint. Arrays keep their order because order is meaningful.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  // JSON.stringify returns undefined for functions and symbols, despite its declared type.
  const text = JSON.stringify(value) as string | undefined;
  return text ?? 'null';
}

export function requestFingerprint(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method}\n${path}\n${canonicalJson(body ?? null)}`)
    .digest('hex');
}

export function idempotencyMiddleware(options: IdempotencyOptions): RequestHandler {
  const { redis, logger, ttlSeconds, lockSeconds, exempt } = options;
  const prefix = options.keyPrefix ?? 'idem';

  return (req, res, next) => {
    if (!WRITE_METHODS.has(req.method) || exempt?.(req) === true) {
      next();
      return;
    }
    const key = req.get(IDEMPOTENCY_HEADER);
    if (key === undefined || !KEY_FORMAT.test(key)) {
      next(
        new BadRequestError(
          'idempotency_key_required',
          `Write requests must send an ${IDEMPOTENCY_HEADER} header of 8-255 visible ASCII characters`,
        ),
      );
      return;
    }

    const ctx = currentContext();
    const redisKey = `${prefix}:${ctx ? callerKey(ctx) : 'ip:unknown'}:${key}`;
    const fingerprint = requestFingerprint(req.method, req.originalUrl, req.body);
    const reservation: InProgressRecord = { state: 'in_progress', fingerprint };

    redis
      .set(redisKey, JSON.stringify(reservation), 'EX', lockSeconds, 'NX')
      .then(async (claimed) => {
        if (claimed === 'OK') {
          captureResponse(redisKey, fingerprint);
          next();
          return;
        }
        // Someone used this key before: decide from the stored record.
        const raw = await redis.get(redisKey);
        if (raw === null) {
          // It expired between SET and GET; ask the client to retry rather than guess.
          next(new ConflictError('idempotency_request_in_progress', 'Please retry the request'));
          return;
        }
        const record = JSON.parse(raw) as IdempotencyRecord;
        if (record.fingerprint !== fingerprint) {
          next(
            new UnprocessableError(
              'idempotency_key_reused',
              'This Idempotency-Key was already used for a different request',
            ),
          );
          return;
        }
        if (record.state === 'in_progress') {
          next(
            new ConflictError(
              'idempotency_request_in_progress',
              'A request with this Idempotency-Key is still being processed',
            ),
          );
          return;
        }
        res.setHeader(REPLAYED_HEADER, 'true');
        if (record.contentType !== undefined) res.setHeader('Content-Type', record.contentType);
        res.status(record.status).send(record.body);
      })
      .catch((err: unknown) => {
        logger.error({ err }, 'idempotency store unavailable');
        next(
          new ServiceUnavailableError(
            'idempotency_unavailable',
            'The request could not be processed safely right now. Please retry shortly.',
          ),
        );
      });

    /**
     * Wraps res.send so the final response is stored before it is sent. res.json() and
     * res.send() both end up here; handlers that stream are not supported on write routes.
     */
    function captureResponse(redisKey: string, fp: string): void {
      const originalSend = res.send.bind(res);
      let stored = false;
      res.send = (body?: unknown) => {
        if (!stored) {
          stored = true;
          const status = res.statusCode;
          let op: Promise<unknown>;
          if (status >= 500) {
            // Server-side failure: release the key so the client can retry.
            op = redis.del(redisKey);
          } else {
            const text =
              typeof body === 'string'
                ? body
                : Buffer.isBuffer(body)
                  ? body.toString('utf8')
                  : body === undefined
                    ? ''
                    : JSON.stringify(body);
            const header = res.getHeader('Content-Type');
            const record: CompletedRecord = {
              state: 'completed',
              fingerprint: fp,
              status,
              contentType: typeof header === 'string' ? header : undefined,
              body: text,
            };
            op = redis.set(redisKey, JSON.stringify(record), 'EX', ttlSeconds);
          }
          op.catch((err: unknown) => {
            logger.error({ err }, 'could not store idempotency result');
          });
        }
        return originalSend(body);
      };
    }
  };
}
