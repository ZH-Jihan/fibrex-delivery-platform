/**
 * API keys for integrations (SPEC 2.11 "API keys ... per integration", PLAN 2.2 api_key).
 *
 * Purpose: make, recognise and look up the keys an integration sends as
 * `Authorization: Bearer fbx_<43 characters>`. Administration (which client holds which
 * scopes, issuing and revoking keys) is in ./api-client-router.ts.
 *
 * Rules and why:
 *   1. A key is 256 random bits behind a fixed "fbx_" marker. The marker lets the
 *      authentication middleware tell a key from a signed access token (which always
 *      starts with "eyJ") without trying both, and lets secret scanners spot a leaked key.
 *   2. Only the SHA-256 of the key is stored, and the key is shown once, when issued. A
 *      plain (unkeyed) hash is enough because the key itself is random and long: there is
 *      nothing to guess from a dictionary, and the hash does not depend on a server secret
 *      that might be rotated (rotating it would silently break every integration).
 *   3. The first 12 characters (`key_prefix`) are stored in the clear so a person can tell
 *      their keys apart in a list. They are not enough to use or rebuild the key.
 *   4. Looking a key up happens before any tenant is known, through the database function
 *      iam.resolve_api_key (see its migration for why that is safe). It answers only for a
 *      key usable right now, so revoking a key or disabling a client bites at once.
 *   5. Each client has its own requests-per-minute limit (`rate_limit_per_minute`),
 *      counted in Redis per client. Like the general limiter it fails open: the limit
 *      protects capacity, while identity checks (rule 4) always fail closed.
 *   6. `last_used_at` is written at most once an hour per key, so a busy integration does
 *      not write (and audit) a row on every request.
 *
 * Depends on: node:crypto, ioredis, kernel/db (Prisma, unit of work), kernel/http/rate-limit.ts.
 * Used by: ./authenticate.ts (resolve, rate limit), ./api-client-router.ts (generate).
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { PrismaDb } from '../db/prisma.js';
import type { UnitOfWork } from '../db/unit-of-work.js';
import { RateLimiter, type RateLimitDecision } from '../http/rate-limit.js';
import type { Logger } from '../observability/logger.js';

export const API_KEY_MARKER = 'fbx_';
const PREFIX_LENGTH = 12;

export interface NewApiKey {
  /** The full key: shown to the person once and never stored. */
  key: string;
  keyPrefix: string;
  keyHash: string;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function generateApiKey(): NewApiKey {
  const key = `${API_KEY_MARKER}${randomBytes(32).toString('base64url')}`;
  return { key, keyPrefix: key.slice(0, PREFIX_LENGTH), keyHash: hashApiKey(key) };
}

export function looksLikeApiKey(token: string): boolean {
  return token.startsWith(API_KEY_MARKER);
}

/** A key that may be used right now, and what it opens. */
export interface ResolvedApiKey {
  tenantId: string;
  companyId: string;
  apiClientId: string;
  apiKeyId: string;
  rateLimitPerMinute: number;
}

export class ApiKeyResolver {
  private readonly deps: { prisma: PrismaDb; uow: UnitOfWork; redis: Redis; logger: Logger };
  private readonly limiter: RateLimiter;
  /** Limits of the clients seen most recently, read by the limiter for each caller key. */
  private readonly limits = new Map<string, number>();

  constructor(deps: { prisma: PrismaDb; uow: UnitOfWork; redis: Redis; logger: Logger }) {
    this.deps = deps;
    this.limiter = new RateLimiter({
      redis: deps.redis,
      keyPrefix: 'rl:client',
      windowSeconds: 60,
      limitFor: (caller) => this.limits.get(caller) ?? 1,
    });
  }

  /** The key's owner, or undefined when the key is unknown or not usable (rule 4). */
  async resolve(key: string): Promise<ResolvedApiKey | undefined> {
    if (!looksLikeApiKey(key) || key.length > 128) return undefined;
    const rows = await this.deps.prisma.$queryRaw<
      {
        tenant_id: string;
        company_id: string;
        api_client_id: string;
        api_key_id: string;
        rate_limit_per_minute: number;
      }[]
    >`SELECT tenant_id::text, company_id::text, api_client_id::text, api_key_id::text,
             rate_limit_per_minute
        FROM iam.resolve_api_key(${hashApiKey(key)})`;
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      tenantId: row.tenant_id,
      companyId: row.company_id,
      apiClientId: row.api_client_id,
      apiKeyId: row.api_key_id,
      rateLimitPerMinute: row.rate_limit_per_minute,
    };
  }

  /** Counts one request against the client's own limit (rule 5). Undefined: Redis is down. */
  async rateLimit(resolved: ResolvedApiKey): Promise<RateLimitDecision | undefined> {
    const caller = `${resolved.tenantId}:${resolved.apiClientId}`;
    // Bounded, so a flood of different clients cannot grow it without limit.
    if (this.limits.size > 10_000) this.limits.clear();
    this.limits.set(caller, resolved.rateLimitPerMinute);
    try {
      return await this.limiter.hit(caller);
    } catch (err) {
      this.deps.logger.warn({ err }, 'client rate limiter unavailable; request allowed');
      return undefined;
    }
  }

  /**
   * Records that the key was used (rule 6). Runs in the client's own context, after
   * authentication filled it. Never fails the request: it is bookkeeping.
   */
  async touch(resolved: ResolvedApiKey): Promise<void> {
    try {
      const first = await this.deps.redis.set(
        `apikey:used:${resolved.apiKeyId}`,
        '1',
        'EX',
        3600,
        'NX',
      );
      if (first !== 'OK') return;
      await this.deps.uow.run((db) =>
        db.apiKey.updateMany({
          where: { id: resolved.apiKeyId },
          data: { lastUsedAt: new Date() },
        }),
      );
    } catch (err) {
      this.deps.logger.warn({ err }, 'could not record API key use');
    }
  }
}
