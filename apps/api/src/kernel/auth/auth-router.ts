/**
 * Authentication endpoints (docs/PLAN.md section 5.3), part 7a.
 *
 *   POST   /auth/login             username, email or phone + password
 *   POST   /auth/refresh           swap the refresh cookie for a new one + new access token
 *   POST   /auth/logout            end the session
 *   POST   /auth/password/change   signed-in user changes their own password
 *   GET    /me                     who am I, in which company, with which roles
 *
 * Part 7b:
 *   POST   /auth/mfa/verify        second factor at sign-in (app code or recovery code)
 *   POST   /auth/otp/request       send a sign-in code to a phone number
 *   POST   /auth/otp/verify        sign in with that code
 *   POST   /auth/password/forgot   send a reset link
 *   POST   /auth/password/reset    choose a new password with the link's token
 *   POST   /auth/mfa/totp/setup    start setting up an authenticator app
 *   POST   /auth/mfa/totp/confirm  finish it; returns the recovery codes once
 *   DELETE /auth/mfa/totp          remove it (needs a recent re-authentication)
 *   POST   /auth/reauth            prove identity again before a sensitive action
 *
 * When the user has an authenticator app, /auth/login and /auth/otp/verify answer
 * `{ mfaRequired: true, mfaToken }` and set no cookies; the session starts at
 * /auth/mfa/verify. "Send me a code/link" routes always answer 204, whoever asks.
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
import type { AuthService, ClientInfo, IssuedSession, SignInResult } from './auth-service.js';

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

const tenantSlug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, { message: 'Not a valid organisation code' });
const loginBody = z.object({
  tenant: tenantSlug,
  identifier: z.string().trim().min(3).max(255),
  password: z.string().min(1).max(128),
});
// International form, the same rule the database enforces on stored numbers.
const phone = z
  .string()
  .trim()
  .regex(/^\+[1-9][0-9]{6,14}$/, {
    message: 'Use the international form, for example +97455500000',
  });
// Six digits from the app, or a recovery code (XXXXX-XXXXX; case, spaces and dash are forgiven).
const secondFactorCode = z.string().trim().min(6).max(24);
const totpCode = z
  .string()
  .trim()
  .regex(/^\d{6}$/, { message: 'Enter the 6-digit code' });
const mfaVerifyBody = z.object({
  mfaToken: z.string().min(20).max(128),
  code: secondFactorCode,
});
const otpRequestBody = z.object({ tenant: tenantSlug, phone });
const otpVerifyBody = z.object({ tenant: tenantSlug, phone, code: totpCode });
const forgotBody = z.object({ tenant: tenantSlug, identifier: z.string().trim().min(3).max(255) });
const resetBody = z.object({
  token: z.string().min(40).max(128),
  // The exact minimum is configuration (AUTH_PASSWORD_MIN_LENGTH), checked by the service.
  newPassword: z.string().min(8).max(128),
});
const totpConfirmBody = z.object({ code: totpCode });
const reauthBody = z
  .object({
    password: z.string().min(1).max(128).optional(),
    code: secondFactorCode.optional(),
  })
  .refine((b) => b.password !== undefined || b.code !== undefined, {
    message: 'Give your password, or a code from your authenticator app',
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
  mfaEnrolmentRequired: z.boolean(),
};
const accessGrant = z
  .object({ accessToken: z.string(), expiresIn: z.number().int(), ...identity })
  .meta({ id: 'AccessGrant' });
const signedIn = accessGrant.extend({ csrfToken: z.string() }).meta({ id: 'SignedIn' });
const mfaChallenge = z
  .object({ mfaRequired: z.literal(true), mfaToken: z.string(), expiresIn: z.number().int() })
  .meta({ id: 'MfaChallenge' });
const signInResult = z.union([signedIn, mfaChallenge]);
const totpSetup = z
  .object({ secret: z.string(), otpauthUrl: z.string() })
  .meta({ id: 'TotpSetup' });
const totpConfirmed = accessGrant
  .extend({ recoveryCodes: z.array(z.string()) })
  .meta({ id: 'TotpConfirmed' });
const reauthResult = z.object({ validUntil: z.iso.datetime() }).meta({ id: 'Reauthenticated' });
const me = z
  .object({ ...identity, sessionId: z.uuid(), mfaEnabled: z.boolean() })
  .meta({ id: 'Me' });
const switchCompanyBody = z.object({ companyId: z.uuid() });
const companyChoice = z
  .object({ id: z.uuid(), name: z.string(), isDefault: z.boolean(), current: z.boolean() })
  .meta({ id: 'CompanyChoice' });
export const sessionItem = z
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
export const loginEvent = z
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
    mfaEnrolmentRequired: issued.mfaEnrolmentRequired,
    csrfToken,
  });
  /**
   * Answers a first-factor sign-in. A session gets its cookies; a user who still owes a
   * second factor gets only the MFA token, and no cookie at all.
   */
  const sendSignIn = (res: Response, result: SignInResult) => {
    if ('mfaRequired' in result) {
      res.json(result);
      return;
    }
    res.json(body(result, setCookies(res, result)));
  };

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
    sendSignIn(res, await auth.login(input, clientInfo(req)));
  });

  router.post('/auth/mfa/verify', loginLimiter, async (req, res) => {
    const issued = await auth.verifyMfa(mfaVerifyBody.parse(req.body), clientInfo(req));
    res.json(body(issued, setCookies(res, issued)));
  });

  router.post('/auth/otp/request', loginLimiter, async (req, res) => {
    await auth.requestLoginCode(otpRequestBody.parse(req.body), clientInfo(req));
    res.status(204).end();
  });
  router.post('/auth/otp/verify', loginLimiter, async (req, res) => {
    sendSignIn(res, await auth.loginWithCode(otpVerifyBody.parse(req.body), clientInfo(req)));
  });

  router.post('/auth/password/forgot', loginLimiter, async (req, res) => {
    await auth.forgotPassword(forgotBody.parse(req.body), clientInfo(req));
    res.status(204).end();
  });
  router.post('/auth/password/reset', loginLimiter, async (req, res) => {
    await auth.resetPassword(resetBody.parse(req.body), clientInfo(req));
    res.status(204).end();
  });

  router.post('/auth/mfa/totp/setup', async (_req, res) => {
    res.json(await auth.setupTotp());
  });
  router.post('/auth/mfa/totp/confirm', async (req, res) => {
    res.json(await auth.confirmTotp(totpConfirmBody.parse(req.body).code));
  });
  router.delete('/auth/mfa/totp', async (_req, res) => {
    res.json(await auth.disableTotp());
  });

  router.post('/auth/reauth', async (req, res) => {
    res.json(await auth.reauthenticate(reauthBody.parse(req.body)));
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
  router.get('/me/companies', async (_req, res) => {
    res.json({ items: await auth.listCompanies() });
  });
  // Authenticated by the access token (not by a cookie), so no CSRF check is needed. The
  // old refresh cookie is replaced by the new session's.
  router.post('/me/switch-company', async (req, res) => {
    const { companyId } = switchCompanyBody.parse(req.body);
    const issued = await auth.switchCompany(companyId, clientInfo(req));
    res.json(body(issued, setCookies(res, issued)));
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
      200: json(
        'Signed in (cookies are set), or a second factor is required (no cookies)',
        signInResult,
      ),
      401: problem('Wrong details, or the account is locked or disabled'),
    },
  });
  const bodyOf = (schema: z.ZodType) => ({
    body: { content: { 'application/json': { schema } } },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/auth/mfa/verify',
    tags,
    summary: 'Finish sign-in with an authenticator code or a recovery code',
    request: bodyOf(mfaVerifyBody),
    responses: {
      200: json('Signed in; the refresh and CSRF cookies are set', signedIn),
      401: problem('Wrong code, locked account, or the sign-in step expired'),
    },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/auth/otp/request',
    tags,
    summary: 'Send a sign-in code to a phone number',
    request: bodyOf(otpRequestBody),
    responses: {
      204: { description: 'Accepted (the same answer whether or not the number is known)' },
    },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/auth/otp/verify',
    tags,
    summary: 'Sign in with a phone number and the code sent to it',
    request: bodyOf(otpVerifyBody),
    responses: {
      200: json('Signed in, or a second factor is required', signInResult),
      401: problem('Wrong or expired code, or the account is locked or disabled'),
    },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/auth/password/forgot',
    tags,
    summary: 'Send a password-reset link',
    request: bodyOf(forgotBody),
    responses: {
      204: { description: 'Accepted (the same answer whether or not the account exists)' },
    },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/auth/password/reset',
    tags,
    summary: 'Choose a new password with a reset token; every session is signed out',
    request: bodyOf(resetBody),
    responses: {
      204: { description: 'Password changed' },
      400: problem('The new password is too short'),
      422: problem('The token is invalid, used or expired, or the password was used recently'),
    },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/auth/mfa/totp/setup',
    tags,
    summary: 'Start setting up an authenticator app',
    responses: {
      200: json('The seed, as text and as an otpauth link for a QR code', totpSetup),
      401: problem('Not signed in'),
      409: problem('An authenticator app is already set up'),
    },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/auth/mfa/totp/confirm',
    tags,
    summary: 'Finish setting up the authenticator app',
    request: bodyOf(totpConfirmBody),
    responses: {
      200: json('Enabled; recovery codes (shown once) and a fresh access token', totpConfirmed),
      401: problem('Not signed in'),
      422: problem('Wrong code, or no setup in progress'),
    },
  });
  registerRoute(registry, {
    method: 'delete',
    path: '/auth/mfa/totp',
    tags,
    summary: 'Remove my authenticator app',
    responses: {
      200: json('Removed; a fresh access token', accessGrant),
      401: problem('Not signed in'),
      403: problem('Re-authentication is required first'),
      404: problem('No authenticator app is set up'),
    },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/auth/reauth',
    tags,
    summary: 'Confirm my identity again before a sensitive action',
    request: bodyOf(reauthBody),
    responses: {
      200: json('Confirmed for this session until the given time', reauthResult),
      401: problem('Not signed in'),
      422: problem('Wrong password or code, or the account is locked'),
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
  registerRoute(registry, {
    method: 'get',
    path: '/me/companies',
    tags,
    summary: 'The companies I can work in',
    responses: {
      200: json('Companies', z.object({ items: z.array(companyChoice) })),
      401: problem('Not signed in'),
    },
  });
  registerRoute(registry, {
    method: 'post',
    path: '/me/switch-company',
    tags,
    summary: 'Work in another of my companies (starts a new session and ends this one)',
    request: bodyOf(switchCompanyBody),
    responses: {
      200: json('Signed in to the other company (cookies are replaced)', signedIn),
      401: problem('Not signed in'),
      403: problem('Not a company you have access to'),
    },
  });
}
