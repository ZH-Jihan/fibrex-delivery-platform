/**
 * Authentication middleware: turns a bearer credential into the request's principal.
 *
 * Purpose: runs once per API request, before idempotency and every module route. When the
 * request carries a valid access token or API key it fills the request context (who,
 * which tenant, which company, which roles, which session). Everything downstream reads
 * identity from that context only: the unit of work turns it into the row-level security
 * settings.
 *
 * Steps and why:
 *   1. No Authorization header: the request stays anonymous. Public routes (sign-in,
 *      health, docs) work; anything that opens a unit of work answers 401 by itself.
 *   2. A header that is present but wrong (bad signature, expired, malformed, unknown or
 *      revoked key) is refused with 401 here, so a broken credential is never silently
 *      treated as "anonymous".
 *   3. An API key ("fbx_...", see ./api-keys.ts) makes the caller an API client of one
 *      company. Its own per-minute limit is counted (429 when over). The audit trail
 *      records it through the role label `api_client:<id>`, because an API client is not
 *      a user and `app.user_id` must only ever hold a user id.
 *   4. For an access token, the session is looked up in the Redis revocation list, so
 *      sign-out, remote sign-out and password change cut off already-issued tokens at
 *      once. If Redis cannot be reached the request is refused (503): letting it through
 *      would mean a revoked session keeps working, and failing closed is the safe side.
 *   5. While the user must change their password, only the routes needed to do that (and
 *      to sign out) are allowed. This is enforced here so no module can forget it.
 *   6. The same for a user whose roles demand two-step verification and who has not set
 *      it up yet: only the set-up routes work until they have.
 *   7. An impersonation token (claim `imp`) acts as the target user, with the real user
 *      kept as `impersonatorId` so every audit row carries both identities. It cannot
 *      reach anything that would act on the account itself rather than as it: no /auth
 *      route (so no password, authenticator or re-authentication, and therefore none of
 *      the sensitive actions that require re-authentication), no company switch, no
 *      second impersonation and no API client administration.
 *
 * Depends on: ./access-token.ts, ./api-keys.ts, ./auth-service.ts (revocation key),
 * kernel/context, kernel/http/errors.ts, ioredis. Used by: src/app.ts through
 * AppDeps.authenticate.
 */
import type { Request, RequestHandler } from 'express';
import type { Redis } from 'ioredis';
import { requireContext } from '../context/request-context.js';
import {
  AppError,
  ServiceUnavailableError,
  TooManyRequestsError,
  UnauthenticatedError,
} from '../http/errors.js';
import type { AccessTokens } from './access-token.js';
import { looksLikeApiKey, type ApiKeyResolver } from './api-keys.js';
import { sessionRevokedKey } from './auth-service.js';

/** Routes (relative to /api/v1) still usable while a password change is required. */
const ALLOWED_BEFORE_PASSWORD_CHANGE: ReadonlySet<string> = new Set([
  'POST /auth/password/change',
  'POST /auth/logout',
  'POST /auth/refresh',
  'GET /me',
]);

/**
 * Routes still usable while two-step verification must be set up first. Changing the
 * password stays allowed, so a user who owes both steps does the password first (it is
 * the only route in both lists) and the authenticator app second.
 */
const ALLOWED_BEFORE_MFA_ENROLMENT: ReadonlySet<string> = new Set([
  'POST /auth/mfa/totp/setup',
  'POST /auth/mfa/totp/confirm',
  'POST /auth/password/change',
  'POST /auth/logout',
  'POST /auth/refresh',
  'GET /me',
]);

/** Step 7: what an impersonation token may not reach. */
function refusedWhileImpersonating(method: string, path: string): boolean {
  return (
    path.startsWith('/auth/') ||
    path === '/me/switch-company' ||
    (method === 'POST' && path === '/impersonations') ||
    path === '/api-clients' ||
    path.startsWith('/api-clients/')
  );
}

export class PasswordChangeRequiredError extends AppError {
  constructor() {
    super(403, 'password_change_required', 'Forbidden', 'Change your password before continuing');
  }
}

export class MfaEnrolmentRequiredError extends AppError {
  constructor() {
    super(
      403,
      'mfa_enrolment_required',
      'Forbidden',
      'Set up two-step verification before continuing',
    );
  }
}

export class ImpersonationRestrictedError extends AppError {
  constructor() {
    super(
      403,
      'impersonation_restricted',
      'Forbidden',
      'This is not available while acting as another user',
    );
  }
}

export interface AuthenticateDeps {
  tokens: AccessTokens;
  redis: Redis;
  /** Optional so tests of the token path can leave keys out; keys are then refused. */
  apiKeys?: ApiKeyResolver;
}

const routeOf = (req: Request) => ({ method: req.method, path: req.path.replace(/\/+$/, '') });

async function authenticateApiKey(deps: AuthenticateDeps, key: string): Promise<void> {
  let resolved;
  try {
    resolved = await deps.apiKeys?.resolve(key);
  } catch {
    throw new ServiceUnavailableError(
      'key_check_unavailable',
      'The API key cannot be checked right now. Try again shortly.',
    );
  }
  if (resolved === undefined) throw new UnauthenticatedError('The API key is not valid');

  const ctx = requireContext();
  ctx.principal = {
    kind: 'api_client',
    apiClientId: resolved.apiClientId,
    tenantId: resolved.tenantId,
  };
  ctx.companyIds = [resolved.companyId];
  ctx.roleKeys = [`api_client:${resolved.apiClientId}`];

  const decision = await deps.apiKeys?.rateLimit(resolved);
  if (decision !== undefined && !decision.allowed) {
    throw new TooManyRequestsError(decision.resetSeconds);
  }
  await deps.apiKeys?.touch(resolved);
}

export function authenticate(deps: AuthenticateDeps): RequestHandler {
  return async (req, _res, next) => {
    const header = req.get('authorization');
    if (header === undefined) {
      next();
      return;
    }
    const match = /^Bearer ([A-Za-z0-9._-]{20,4096})$/.exec(header);
    const credential = match?.[1];
    if (credential !== undefined && looksLikeApiKey(credential)) {
      await authenticateApiKey(deps, credential);
      next();
      return;
    }
    const claims = credential === undefined ? undefined : deps.tokens.verify(credential);
    if (claims === undefined) throw new UnauthenticatedError('The access token is not valid');

    let revoked: number;
    try {
      revoked = await deps.redis.exists(sessionRevokedKey(claims.sid));
    } catch {
      throw new ServiceUnavailableError(
        'session_check_unavailable',
        'Sign-in status cannot be checked right now. Try again shortly.',
      );
    }
    if (revoked !== 0) throw new UnauthenticatedError('The session has ended');

    const ctx = requireContext();
    ctx.principal = {
      kind: 'user',
      userId: claims.sub,
      tenantId: claims.tid,
      ...(claims.imp === undefined ? {} : { impersonatorId: claims.imp }),
    };
    ctx.companyIds = claims.cid === undefined ? [] : [claims.cid];
    ctx.roleKeys = claims.roles;
    ctx.sessionId = claims.sid;

    const { method, path } = routeOf(req);
    const route = `${method} ${path}`;
    if (claims.imp !== undefined && refusedWhileImpersonating(method, path)) {
      throw new ImpersonationRestrictedError();
    }
    if (claims.pwd === true && !ALLOWED_BEFORE_PASSWORD_CHANGE.has(route)) {
      throw new PasswordChangeRequiredError();
    }
    if (claims.mfa === true && !ALLOWED_BEFORE_MFA_ENROLMENT.has(route)) {
      throw new MfaEnrolmentRequiredError();
    }
    next();
  };
}
