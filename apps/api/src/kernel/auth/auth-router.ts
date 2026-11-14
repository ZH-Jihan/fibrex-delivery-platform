/**
 * Authentication endpoints (docs/PLAN.md section 5.3), part 7a.
 *
 *   POST   /auth/login             username, email or phone + password
 *   POST   /auth/refresh           swap the refresh cookie for a new one + new access token
 *   POST   /auth/logout            end the session
 *   POST   /auth/password/change   signed-in user changes their own password
 *   GET    /me                     who am I, in which company, with which roles
 *   GET    /me/sessions            my active sessions
 *   DELETE /me/sessions/{id}       sign one of them out remotely
 *   GET    /me/login-history       my recent sign-in attempts
 *
 * How the two tokens travel (PLAN 8.6):
 *   - The access token is returned in the JSON body. The web app keeps it in memory only.
 *   - The refresh token is set as an httpOnly, SameSite=Strict cookie limited to the
 *     /auth path, so page scripts can never read it and it is sent only to these routes.
 *   - CSRF: a second, readable cookie holds a random value. Refresh and logout (the two
 *     routes that act on the cookie alone) require the same value in the X-CSRF-Token
 *     header. Another site can make the browser send cookies but cannot read them, so it
 *     cannot fill the header ("double submit").
 *
 * Sign-in has its own stricter rate limit per client address, on top of the general one.
 *
 * Depends on: express, zod, ./auth-service.ts, kernel/http (errors, openapi, rate-limit),
 * kernel/context. Used by: src/main.ts.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { Router, type Request, type Response } from 'express';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import type { Env } from '../config/env.js';
import { requireContext } from '../context/request-context.js';
import { AppError } from '../http/errors.js';
import { problemSchema, registerRoute } from '../http/openapi.js';
import { RateLimiter, rateLimitMiddleware } from '../http/rate-limit.js';
import type { Logger } from '../observability/logger.js';
import type { AuthService, ClientInfo, IssuedSession } from './auth-service.js';

export const REFRESH_COOKIE = 'fibrex_refresh';
export const CSRF_COOKIE = 'fibrex_csrf';
export const CSRF_HEADER = 'X-CSRF-Token';

export interface AuthRouterDeps {
  auth: AuthService;
  registry: OpenAPIRegistry;
  redis: Redis;
  logger: Logger;
  env: Pick<Env, 'NODE_ENV' | 'AUTH_RATE_LIMIT' | 'RATE_LIMIT_WINDOW_SECONDS'>;
  /** Public path of the auth routes, for the refresh cookie (for example /api/v1/auth). */
  cookiePath: string;
}

const loginBody = z.object({
  tenant: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, { message: 'Not a valid organisation code' }),
  identifier: z.string().trim().min(3).max(255),
  password: z.string().min(1).max(128),
});
const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(128),
  // The exact minimum is configuration (AUTH_PASSWORD_MIN_LENGTH), checked by the service.
  newPassword: z.string().min(8).max(128),
});
const sessionParams = z.object({ id: z.uuid() });
const historyQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

const sessionUser = z
  .object({
    id: z.uuid(),
    username: z.string(),
    displayName: z.string(),
    preferredLanguage: z.string(),
    mustChangePassword: z.boolean(),
  })
  .meta({ id: 'SessionUser' });
const identity = {
  user: sessionUser,
  companyId: z.uuid().nullable(),
  roles: z.array(z.string()),
};
const accessGrant = z
  .object({ accessToken: z.string(), expiresIn: z.number().int(), ...identity })
  .meta({ id: 'AccessGrant' });
const signedIn = accessGrant.extend({ csrfToken: z.string() }).meta({ id: 'SignedIn' });
const me = z.object({ ...identity, sessionId: z.uuid() }).meta({ id: 'Me' });
const sessionItem = z
  .object({
    id: z.uuid(),
    current: z.boolean(),
    companyId: z.uuid().nullable(),
    device: z.string().nullable(),
    userAgent: z.string().nullable(),
    ip: z.string().nullable(),
    createdAt: z.iso.datetime(),
    lastSeenAt: z.iso.datetime(),
  })
  .meta({ id: 'SessionItem' });
const loginEvent = z
  .object({
    at: z.iso.datetime(),
    method: z.string(),
    result: z.string(),
    ip: z.string().nullable(),
    userAgent: z.string().nullable(),
  })
  .meta({ id: 'LoginEvent' });

/** Reads one cookie from the Cookie header (no cookie library is needed for two names). */
export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      return value === '' ? undefined : value;
    }
  }
  return undefined;
}

function clientInfo(req: Request): ClientInfo {
  return { ip: requireContext().ip, userAgent: req.get('user-agent') };
}

export function createAuthRouter(deps: AuthRouterDeps): Router {
  const { auth, registry, env } = deps;
  const router = Router();
  const secure = env.NODE_ENV === 'production';

  const setCookies = (res: Response, issued: IssuedSession): string => {
    const csrfToken = randomBytes(32).toString('base64url');
    const common = { secure, sameSite: 'strict' as const, expires: issued.refreshExpiresAt };
    res.cookie(REFRESH_COOKIE, issued.refreshToken, {
      ...common,
      httpOnly: true,
      path: deps.cookiePath,
    });
    // Readable by the web app on any page, so it can copy the value into the header.
    res.cookie(CSRF_COOKIE, csrfToken, { ...common, httpOnly: false, path: '/' });
    return csrfToken;
  };
  const clearCookies = (res: Response) => {
    res.clearCookie(REFRESH_COOKIE, {
      secure,
      sameSite: 'strict',
      httpOnly: true,
      path: deps.cookiePath,
    });
    res.clearCookie(CSRF_COOKIE, { secure, sameSite: 'strict', path: '/' });
  };
  /** Double-submit check: the header must repeat the CSRF cookie exactly. */
  const assertCsrf = (req: Request) => {
    const cookie = Buffer.from(readCookie(req, CSRF_COOKIE) ?? '');
    const header = Buffer.from(req.get(CSRF_HEADER) ?? '');
    if (
      cookie.length === 0 ||
      cookie.length !== header.length ||
      !timingSafeEqual(cookie, header)
    ) {
      throw new AppError(403, 'csrf_failed', 'Forbidden', 'The request could not be verified');
    }
  };
  // The response body: everything except the refresh token, which travels only as a cookie.
  const body = (issued: IssuedSession, csrfToken: string) => ({
    accessToken: issued.accessToken,
    expiresIn: issued.expiresIn,
    user: issued.user,
    companyId: issued.companyId,
    roles: issued.roles,
    csrfToken,
  });

  // Stricter limit for guessing-prone routes, counted per client address.
  const loginLimiter = rateLimitMiddleware(
    new RateLimiter({
      redis: deps.redis,
      keyPrefix: 'rl:auth',
      windowSeconds: env.RATE_LIMIT_WINDOW_SECONDS,
      limitFor: () => env.AUTH_RATE_LIMIT,
    }),
    deps.logger,
  );

  router.post('/auth/login', loginLimiter, async (req, res) => {
    const input = loginBody.parse(req.body);
    const issued = await auth.login(input, clientInfo(req));
    res.json(body(issued, setCookies(res, issued)));
  });

  router.post('/auth/refresh', async (req, res) => {
    assertCsrf(req);
    const token = readCookie(req, REFRESH_COOKIE);
    try {
      if (token === undefined)
        throw new AppError(401, 'unauthenticated', 'Unauthenticated', 'The session has ended');
      const issued = await auth.refresh(token, clientInfo(req));
      res.json(body(issued, setCookies(res, issued)));
    } catch (err) {
      // A refused refresh leaves nothing usable in the browser.
      if (err instanceof AppError && err.status === 401) clearCookies(res);
      throw err;
    }
  });

  router.post('/auth/logout', async (req, res) => {
    const token = readCookie(req, REFRESH_COOKIE);
    if (token !== undefined) {
      assertCsrf(req);
      await auth.logoutByRefreshToken(token, clientInfo(req));
    } else if (requireContext().sessionId !== undefined) {
      // No cookie (a non-browser client): end the session of the access token instead.
      await auth.logoutCurrent();
    }
    clearCookies(res);
    res.status(204).end();
  });

  router.post('/auth/password/change', async (req, res) => {
    res.json(await auth.changePassword(changePasswordBody.parse(req.body)));
  });

  router.get('/me', async (_req, res) => {
    res.json(await auth.me());
  });
  router.get('/me/sessions', async (_req, res) => {
    res.json({ items: await auth.listSessions() });
  });
  router.delete('/me/sessions/:id', async (req, res) => {
    await auth.revokeOwnSession(sessionParams.parse(req.params).id);
    res.status(204).end();
  });
  router.get('/me/login-history', async (req, res) => {
    res.json({ items: await auth.loginHistory(historyQuery.parse(req.query).limit) });
  });

  registerDocs(registry);
  return router;
}

function registerDocs(registry: OpenAPIRegistry): void {
  const json = (description: string, schema: z.ZodType) => ({
    description,
    content: { 'application/json': { schema } },
  });
  const problem = (description: string) => ({
    description,
    content: { 'application/problem+json': { schema: problemSchema } },
  });
  const tags = ['Auth'];
  const csrf = z.object({ [CSRF_HEADER]: z.string() });

  registerRoute(registry, {
    method: 'post',
    path: '/auth/login',
    tags,
    summary: 'Sign in with username, email or phone and a password',
    request: { body: { content: { 'application/json': { schema: loginBody } } } },
    responses: {
      200: json('Signed in; the refresh and CSRF cookies are set', signedIn),
      401: problem('Wrong details, or the account is locked or disabled'),
    },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/auth/refresh',
    tags,
    summary: 'Rotate the refresh cookie and get a new access token',
    request: { headers: csrf },
    responses: {
      200: json('New access token; new cookies are set', signedIn),
      401: problem('The session has ended (expired, signed out, or the token was reused)'),
      403: problem('CSRF check failed'),
    },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/auth/logout',
    tags,
    summary: 'Sign out of this session',
    request: { headers: csrf },
    responses: { 204: { description: 'Signed out' }, 403: problem('CSRF check failed') },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/auth/password/change',
    tags,
    summary: 'Change my password; other sessions are signed out',
    request: { body: { content: { 'application/json': { schema: changePasswordBody } } } },
    responses: {
      200: json('Password changed; a fresh access token', accessGrant),
      401: problem('Not signed in'),
      422: problem('Current password wrong, or the new password was used recently'),
    },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/me',
    tags,
    summary: 'The signed-in user, company and roles',
    responses: { 200: json('Identity', me), 401: problem('Not signed in') },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/me/sessions',
    tags,
    summary: 'My active sessions',
    responses: {
      200: json('Sessions', z.object({ items: z.array(sessionItem) })),
      401: problem('Not signed in'),
    },
  });
  registerRoute(registry, {
    method: 'delete',
    path: '/me/sessions/{id}',
    tags,
    summary: 'Sign out one of my sessions',
    request: { params: sessionParams },
    responses: {
      204: { description: 'Signed out' },
      401: problem('Not signed in'),
      404: problem('No such active session'),
    },
  });
  registerRoute(registry, {
    method: 'get',
    path: '/me/login-history',
    tags,
    summary: 'My recent sign-in attempts, newest first',
    request: { query: historyQuery },
    responses: {
      200: json('Sign-in attempts', z.object({ items: z.array(loginEvent) })),
      401: problem('Not signed in'),
    },
  });
}
