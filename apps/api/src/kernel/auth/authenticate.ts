/**
 * Authentication middleware: turns a bearer access token into the request's principal.
 *
 * Purpose: runs once per API request, before idempotency and every module route. When the
 * request carries a valid access token it fills the request context (who, which tenant,
 * which company, which roles, which session). Everything downstream reads identity from
 * that context only: the unit of work turns it into the row-level security settings.
 *
 * Steps and why:
 *   1. No Authorization header: the request stays anonymous. Public routes (sign-in,
 *      health, docs) work; anything that opens a unit of work answers 401 by itself.
 *   2. A header that is present but wrong (bad signature, expired, malformed) is refused
 *      with 401 here, so a broken token is never silently treated as "anonymous".
 *   3. The session is looked up in the Redis revocation list, so sign-out, remote
 *      sign-out and password change cut off already-issued tokens at once. If Redis
 *      cannot be reached the request is refused (503): letting it through would mean a
 *      revoked session keeps working, and failing closed is the safe side for identity.
 *   4. While the user must change their password, only the routes needed to do that (and
 *      to sign out) are allowed. This is enforced here so no module can forget it.
 *
 * Depends on: ./access-token.ts, ./auth-service.ts (revocation key), kernel/context,
 * kernel/http/errors.ts, ioredis. Used by: src/app.ts through AppDeps.authenticate.
 */
import type { RequestHandler } from 'express';
import type { Redis } from 'ioredis';
import { requireContext } from '../context/request-context.js';
import { AppError, ServiceUnavailableError, UnauthenticatedError } from '../http/errors.js';
import type { AccessTokens } from './access-token.js';
import { sessionRevokedKey } from './auth-service.js';

/** Routes (relative to /api/v1) still usable while a password change is required. */
const ALLOWED_BEFORE_PASSWORD_CHANGE: ReadonlySet<string> = new Set([
  'POST /auth/password/change',
  'POST /auth/logout',
  'POST /auth/refresh',
  'GET /me',
]);

export class PasswordChangeRequiredError extends AppError {
  constructor() {
    super(403, 'password_change_required', 'Forbidden', 'Change your password before continuing');
  }
}

export function authenticate(deps: { tokens: AccessTokens; redis: Redis }): RequestHandler {
  return async (req, _res, next) => {
    const header = req.get('authorization');
    if (header === undefined) {
      next();
      return;
    }
    const match = /^Bearer ([A-Za-z0-9._-]{20,4096})$/.exec(header);
    const claims = match?.[1] === undefined ? undefined : deps.tokens.verify(match[1]);
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
    ctx.principal = { kind: 'user', userId: claims.sub, tenantId: claims.tid };
    ctx.companyIds = claims.cid === undefined ? [] : [claims.cid];
    ctx.roleKeys = claims.roles;
    ctx.sessionId = claims.sid;

    if (
      claims.pwd === true &&
      !ALLOWED_BEFORE_PASSWORD_CHANGE.has(`${req.method} ${req.path.replace(/\/+$/, '')}`)
    ) {
      throw new PasswordChangeRequiredError();
    }
    next();
  };
}
