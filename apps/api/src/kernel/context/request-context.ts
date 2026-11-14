/**
 * Request context.
 *
 * Purpose: carry per-request facts (request id, client address, and after authentication
 * the tenant, companies and user) through every async call without passing them by hand.
 * Logging, audit, the database layer (which turns tenant/company/user into SET LOCAL for
 * row-level security) and idempotency all read it from here.
 *
 * Implemented with AsyncLocalStorage, so each request sees only its own context even when
 * many requests interleave on the event loop.
 *
 * Depends on: node:async_hooks. Used by: kernel/http/*, kernel/observability/logger.ts,
 * and later kernel/db and kernel/audit.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** Who is calling. Filled by authentication (Phase 1, commit 7). */
export type Principal =
  | { kind: 'user'; userId: string; tenantId: string; impersonatorId?: string }
  | { kind: 'api_client'; apiClientId: string; tenantId: string };

export interface RequestContext {
  readonly requestId: string;
  readonly startedAt: number;
  readonly ip: string | undefined;
  principal: Principal | undefined;
  /** Companies the request may touch; usually one, several for consolidated views. */
  companyIds: readonly string[];
  /** Keys of the caller's roles, recorded on audit rows. Filled by authentication. */
  roleKeys?: readonly string[];
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Runs `fn` with `ctx` as the current context. */
export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** The current context, or undefined outside a request (jobs, start-up). */
export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

/** The current context; throws when called outside a request, which is a programming error. */
export function requireContext(): RequestContext {
  const ctx = storage.getStore();
  if (ctx === undefined) throw new Error('No request context: called outside a request');
  return ctx;
}

/**
 * A stable key for "who is calling", used to scope rate limits and idempotency keys:
 * the user or API client when authenticated, otherwise the client address.
 */
export function callerKey(ctx: RequestContext): string {
  const p = ctx.principal;
  if (p?.kind === 'user') return `user:${p.tenantId}:${p.userId}`;
  if (p?.kind === 'api_client') return `client:${p.tenantId}:${p.apiClientId}`;
  return `ip:${ctx.ip ?? 'unknown'}`;
}
