/**
 * Authentication service: sign-in, sessions, refresh-token rotation, password change.
 *
 * Purpose: the one place that decides whether a caller is who they claim to be, and that
 * creates, rotates and revokes sessions (SPEC 2.1; phase plan "Auth security").
 *
 * Rules implemented here (each is commented where it is enforced):
 *   - Sign-in failures all look the same from outside (same error, similar timing), so
 *     the API cannot be used to find out which usernames exist.
 *   - AUTH_MAX_FAILED_ATTEMPTS wrong passwords lock the account for AUTH_LOCK_MINUTES.
 *   - Every sign-in attempt is written to iam.login_event, including failures. A failed
 *     attempt therefore COMMITS its transaction and the error is thrown afterwards;
 *     throwing inside would roll the evidence back.
 *   - Refresh tokens are single use. Each refresh swaps the token for a new one in the
 *     same "family". Presenting a token that was already used means it was copied, so
 *     the whole family and its session are revoked (reuse detection).
 *   - Only a SHA-256 hash of a refresh token is stored. The token is 32 random bytes, so
 *     a fast hash is enough; a stolen database cannot be turned back into tokens.
 *   - Changing the password signs out every other session of the user.
 *
 * Two transactions per sign-in and per refresh, and why:
 *   1. The caller has no identity yet, so the tenant comes from the slug in the request
 *      (iam.resolve_tenant) or from the prefix of the refresh token, and the first
 *      transaction runs with that tenant, no user and no company. It only checks
 *      credentials (and records failures) or finds the token's session.
 *   2. Session rows are then written in a second transaction scoped to that session's
 *      user and company. The audit trail stores the company of every changed row and
 *      row-level security refuses audit rows for a company outside the transaction's
 *      scope, so session writes must run in the session's own company. It also makes the
 *      audit trail name the user as the actor.
 *
 * Added in part 7b (each rule is commented where it is enforced):
 *   - Two-step verification. When the user has an authenticator app, the first factor
 *     (password or phone code) does not open a session: it returns a short-lived, single
 *     use "MFA token", and the session opens only after POST /auth/mfa/verify. A user
 *     whose roles demand two-step verification but who has none yet gets a session that
 *     can only set it up (the `mfa` claim; enforced in ./authenticate.ts).
 *   - Wrong second-factor codes, wrong phone codes and wrong re-authentication count
 *     towards the same account lock as wrong passwords. For a user with an authenticator
 *     app the counter is cleared only when BOTH factors have passed; otherwise someone
 *     who knows the password could clear it at will and guess codes without limit.
 *   - Phone sign-in codes and password-reset links: the answer to "send me one" is always
 *     the same whether or not the account exists, and the message goes out after the
 *     response path, so neither the reply nor its timing reveals who has an account.
 *   - Resetting a password signs out every session of the user. It never signs anyone
 *     in, so it is not a way around two-step verification.
 *   - Re-authentication (step-up): proving identity again unlocks sensitive actions for
 *     AUTH_REAUTH_TTL_SECONDS on that one session (assertRecentReauth).
 *
 * Company switching opens a new session (see switchCompany). Permissions are not decided
 * here: kernel/permissions does that. Impersonation is in ./impersonation.ts and API keys
 * in ./api-keys.ts.
 *
 * Depends on: kernel/db (unit of work, Prisma), ioredis, ./password-hasher.ts,
 * ./access-token.ts, ./mfa.ts, adapters/messaging/interface.ts, kernel/context,
 * kernel/http/errors.ts, kernel/observability/logger.ts.
 * Used by: kernel/auth/auth-router.ts, kernel/auth/authenticate.ts (revocation key).
 */
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import type { MessagingAdapter, OutboundMessage } from '../../adapters/messaging/interface.js';
import type { Env } from '../config/env.js';
import { currentContext, requireContext } from '../context/request-context.js';
import type { Db, PrismaDb } from '../db/prisma.js';
import type { DbContext, UnitOfWork } from '../db/unit-of-work.js';
import {
  AppError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  UnprocessableError,
  ValidationError,
} from '../http/errors.js';
import type { Logger } from '../observability/logger.js';
import type { AccessTokens } from './access-token.js';
import type { MfaFactors, MfaState } from './mfa.js';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './password-hasher.js';

export type AuthEnv = Pick<
  Env,
  | 'AUTH_REFRESH_TTL_DAYS'
  | 'AUTH_MAX_FAILED_ATTEMPTS'
  | 'AUTH_LOCK_MINUTES'
  | 'AUTH_PASSWORD_MIN_LENGTH'
  | 'AUTH_PASSWORD_HISTORY'
  | 'AUTH_OTP_TTL_SECONDS'
  | 'AUTH_OTP_RESEND_SECONDS'
  | 'AUTH_RESET_TTL_MINUTES'
  | 'AUTH_REAUTH_TTL_SECONDS'
  | 'AUTH_IMPERSONATION_TTL_SECONDS'
  | 'AUTH_TOTP_ISSUER'
  | 'WEB_BASE_URL'
>;

export interface AuthServiceDeps {
  prisma: PrismaDb;
  uow: UnitOfWork;
  redis: Redis;
  tokens: AccessTokens;
  mfa: MfaFactors;
  /** Delivers sign-in codes and reset links (a stub in development). */
  messaging: MessagingAdapter;
  logger: Logger;
  env: AuthEnv;
}

/** Where the request came from; stored on the session and the login history. */
export interface ClientInfo {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  preferredLanguage: string;
  mustChangePassword: boolean;
}

export interface AccessGrant {
  accessToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  user: SessionUser;
  companyId: string | null;
  roles: string[];
  /** True while the session may only set up two-step verification. */
  mfaEnrolmentRequired: boolean;
}

export interface IssuedSession extends AccessGrant {
  refreshToken: string;
  refreshExpiresAt: Date;
}

/** The first factor passed, but an authenticator code is still owed. No session yet. */
export interface MfaChallenge {
  mfaRequired: true;
  /** Proves the first factor passed; sent back with the code. Single use. */
  mfaToken: string;
  /** Seconds until the MFA token expires. */
  expiresIn: number;
}

export type SignInResult = IssuedSession | MfaChallenge;

/** The MFA token is unknown, expired or already used: sign in again from the start. */
export class MfaChallengeExpiredError extends AppError {
  constructor() {
    super(
      401,
      'mfa_challenge_expired',
      'Unauthenticated',
      'This sign-in step has expired. Sign in again.',
    );
  }
}

/** A sensitive action was attempted without a recent re-authentication. */
export class ReauthRequiredError extends AppError {
  constructor() {
    super(403, 'reauth_required', 'Forbidden', 'Confirm your identity again to continue');
  }
}

/** Redis key that marks a session as recently re-authenticated. */
function reauthKey(sessionId: string): string {
  return `auth:reauth:${sessionId}`;
}

/** Redis key of a sign-in waiting for its second factor. Only a hash of the token is kept. */
function mfaPendingKey(mfaToken: string): string {
  return `auth:mfa:${sha256(mfaToken)}`;
}

/** What is remembered between the first factor and the second. */
const pendingMfaSchema = z.object({
  tenantId: z.uuid(),
  userId: z.uuid(),
  method: z.enum(['password', 'otp']),
  identifier: z.string(),
});
type PendingMfa = z.infer<typeof pendingMfaSchema>;

/** One answer for every sign-in failure, so nothing about the account leaks. */
export class InvalidCredentialsError extends AppError {
  constructor() {
    super(
      401,
      'invalid_credentials',
      'Unauthenticated',
      'The sign-in details are not correct, or the account is locked',
    );
  }
}

/** Redis key that marks a session as revoked for the remaining life of its access tokens. */
export function sessionRevokedKey(sessionId: string): string {
  return `auth:revoked:${sessionId}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

type UserRow = NonNullable<Awaited<ReturnType<Db['userAccount']['findFirst']>>>;
/** The company a session works in and the user's role keys there. */
interface Access {
  companyId: string | null;
  roleKeys: string[];
}
const NO_ACCESS: Access = { companyId: null, roleKeys: [] };

/** Enough of a session to open a transaction in its scope. */
interface SessionRef {
  id: string;
  userId: string;
  companyId: string | null;
}

function toAccess(membership: {
  companyId: string;
  roles: { role: { key: string; deletedAt: Date | null } }[];
}): Access {
  const roleKeys = membership.roles
    .filter((r) => r.role.deletedAt === null)
    .map((r) => r.role.key)
    .sort();
  return { companyId: membership.companyId, roleKeys };
}

type LoginResult =
  | 'success'
  | 'bad_credentials'
  | 'locked'
  | 'disabled'
  | 'mfa_required'
  | 'mfa_failed'
  | 'password_change_required';

/** One sign-in attempt: where it is aimed and how, for the login history. */
interface Attempt {
  tenantId: string;
  /** What the caller typed to identify themselves (username, email or phone). */
  identifier: string;
  method: 'password' | 'otp';
  client: ClientInfo;
}

/** A user whose first factor (or both) has been checked. */
interface Verified {
  user: UserRow;
  access: Access;
  mfa: MfaState;
}

function isLocked(user: { lockedUntil: Date | null }): boolean {
  return user.lockedUntil !== null && user.lockedUntil.getTime() > Date.now();
}

/** What a phone sign-in code is bound to when hashed. */
function otpScope(tenantId: string, phone: string): string {
  return `otp:login:${tenantId}:${phone}`;
}

export class AuthService {
  private readonly deps: AuthServiceDeps;

  constructor(deps: AuthServiceDeps) {
    this.deps = deps;
  }

  // ---------------------------------------------------------------------------------
  // Sign-in
  // ---------------------------------------------------------------------------------

  async login(
    input: { tenant: string; identifier: string; password: string },
    client: ClientInfo,
  ): Promise<SignInResult> {
    const tenantId = await this.resolveTenant(input.tenant);
    if (tenantId === undefined) {
      // Unknown tenant: spend the same time as a real check, then give the same answer.
      await verifyAgainstDummy(input.password);
      throw new InvalidCredentialsError();
    }
    const attempt: Attempt = {
      tenantId,
      identifier: input.identifier.trim().toLowerCase(),
      method: 'password',
      client,
    };

    // Transaction 1, as "nobody yet": check the credentials and record a failure.
    const verified = await this.deps.uow.runAs(this.preAuthContext(tenantId, client), (db) =>
      this.checkCredentials(db, attempt, input.password),
    );
    // It has committed (login history, failure counter, lock), so now it is safe to throw.
    if (verified === undefined) throw new InvalidCredentialsError();
    return this.afterFirstFactor(attempt, verified);
  }

  /** Writes one line of login history (iam.login_event). */
  private recordLogin(db: Db, attempt: Attempt, userId: string | null, result: LoginResult) {
    return db.loginEvent.create({
      data: {
        tenantId: attempt.tenantId,
        userId,
        identifier: attempt.identifier.slice(0, 255),
        method: attempt.method,
        result,
        ip: attempt.client.ip ?? null,
        userAgent: attempt.client.userAgent?.slice(0, 512) ?? null,
      },
    });
  }

  /** The user and their access when the password is right; undefined otherwise (recorded). */
  private async checkCredentials(
    db: Db,
    attempt: Attempt,
    password: string,
  ): Promise<Verified | undefined> {
    const { identifier } = attempt;
    // A person may sign in with their username, email or phone number.
    const user = await db.userAccount.findFirst({
      where: { OR: [{ username: identifier }, { email: identifier }, { phone: identifier }] },
    });
    if (user === null) {
      await verifyAgainstDummy(password);
      await this.recordLogin(db, attempt, null, 'bad_credentials');
      return undefined;
    }
    if (user.status !== 'active') {
      await verifyAgainstDummy(password);
      await this.recordLogin(db, attempt, user.id, 'disabled');
      return undefined;
    }
    // While locked, the password is not even checked: guessing cannot continue, and a
    // correct guess during the lock is not confirmed.
    if (isLocked(user)) {
      await verifyAgainstDummy(password);
      await this.recordLogin(db, attempt, user.id, 'locked');
      return undefined;
    }

    const credential = await db.credential.findFirst({
      where: { userId: user.id, kind: 'password', isCurrent: true },
    });
    const matches =
      credential === null
        ? (await verifyAgainstDummy(password), false)
        : await verifyPassword(credential.hash, password);
    if (!matches) {
      await this.registerFailure(db, user.id);
      await this.recordLogin(db, attempt, user.id, 'bad_credentials');
      return undefined;
    }
    return this.firstFactorPassed(db, attempt, user);
  }

  /**
   * Bookkeeping once the password or phone code was right.
   *
   * Without an authenticator app the sign-in is complete: clear the failure counter.
   * With one, the counter is deliberately left alone until the second factor passes
   * (see completeSignIn). If a correct password cleared it, someone who knows the
   * password could alternate "password" and "guess a code" for ever and never be locked.
   */
  private async firstFactorPassed(db: Db, attempt: Attempt, user: UserRow): Promise<Verified> {
    const mfa = await this.deps.mfa.state(db, user.id);
    if (mfa.enabled) {
      await this.recordLogin(db, attempt, user.id, 'mfa_required');
    } else {
      await this.completeSignIn(db, user.id);
    }
    return { user, access: await this.defaultAccess(db, user.id), mfa };
  }

  /** Every factor has passed: clear the failure counter and note the sign-in time. */
  private async completeSignIn(db: Db, userId: string): Promise<void> {
    await db.userAccount.update({
      where: { id: userId },
      data: { failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
  }

  /**
   * What the caller gets after the first factor: a session, or (when the user has an
   * authenticator app) only a token that lets them present the second factor.
   */
  private async afterFirstFactor(attempt: Attempt, verified: Verified): Promise<SignInResult> {
    if (!verified.mfa.enabled) return this.openSession(attempt, verified);
    // 256 random bits, kept in Redis only as a hash, for AUTH_OTP_TTL_SECONDS. It is not
    // a session: the only thing it can do is accompany a code to /auth/mfa/verify.
    const mfaToken = randomBytes(32).toString('base64url');
    const expiresIn = this.deps.env.AUTH_OTP_TTL_SECONDS;
    const pending: PendingMfa = {
      tenantId: attempt.tenantId,
      userId: verified.user.id,
      method: attempt.method,
      identifier: attempt.identifier,
    };
    await this.deps.redis.set(mfaPendingKey(mfaToken), JSON.stringify(pending), 'EX', expiresIn);
    return { mfaRequired: true, mfaToken, expiresIn };
  }

  /**
   * Creates the session, as the user in their company. Running it under the user's own
   * identity means the audit trail names them as the actor, and the audit row for the
   * session (which carries the company) passes row-level security.
   */
  private openSession(attempt: Attempt, verified: Verified): Promise<IssuedSession> {
    const { tenantId, client } = attempt;
    const { user, access, mfa } = verified;
    return this.deps.uow.runAs(
      this.sessionContext(tenantId, user.id, access.companyId, client),
      async (db) => {
        const session = await db.session.create({
          data: {
            tenantId,
            userId: user.id,
            companyId: access.companyId,
            ip: client.ip ?? null,
            userAgent: client.userAgent?.slice(0, 512) ?? null,
          },
        });
        // A new family: every token later rotated from this one shares the id.
        const refresh = await this.createRefreshToken(db, tenantId, session.id, randomUUID(), null);
        await this.recordLogin(
          db,
          attempt,
          user.id,
          user.mustChangePassword ? 'password_change_required' : 'success',
        );
        return {
          ...this.grant(user, session.id, access, mfa),
          refreshToken: refresh.token,
          refreshExpiresAt: refresh.expiresAt,
        };
      },
    );
  }

  // ---------------------------------------------------------------------------------
  // Second factor at sign-in
  // ---------------------------------------------------------------------------------

  /**
   * Finishes a sign-in that is waiting for its second factor. `code` is six digits from
   * the authenticator app, or a recovery code.
   */
  async verifyMfa(
    input: { mfaToken: string; code: string },
    client: ClientInfo,
  ): Promise<IssuedSession> {
    const key = mfaPendingKey(input.mfaToken);
    const stored = await this.deps.redis.get(key);
    const parsed = stored === null ? undefined : pendingMfaSchema.safeParse(JSON.parse(stored));
    if (parsed?.success !== true) throw new MfaChallengeExpiredError();
    const pending = parsed.data;
    const attempt: Attempt = {
      tenantId: pending.tenantId,
      identifier: pending.identifier,
      method: pending.method,
      client,
    };

    // As "nobody yet", like the password check: a failure must commit before it is thrown.
    const verified = await this.deps.uow.runAs(
      this.preAuthContext(pending.tenantId, client),
      async (db): Promise<Verified | undefined> => {
        const user = await db.userAccount.findFirst({ where: { id: pending.userId } });
        if (user?.status !== 'active') {
          await this.recordLogin(db, attempt, user?.id ?? null, 'disabled');
          return undefined;
        }
        // A locked account accepts no codes either, right or wrong.
        if (isLocked(user)) {
          await this.recordLogin(db, attempt, user.id, 'locked');
          return undefined;
        }
        if (!(await this.deps.mfa.verifyCode(db, user.id, input.code))) {
          // Counted like a wrong password: a few wrong codes lock the account.
          await this.registerFailure(db, user.id);
          await this.recordLogin(db, attempt, user.id, 'mfa_failed');
          return undefined;
        }
        await this.completeSignIn(db, user.id);
        return {
          user,
          access: await this.defaultAccess(db, user.id),
          mfa: await this.deps.mfa.state(db, user.id),
        };
      },
    );
    if (verified === undefined) throw new InvalidCredentialsError();
    // Single use: only the request that removes the token may open the session.
    if ((await this.deps.redis.del(key)) !== 1) throw new MfaChallengeExpiredError();
    return this.openSession(attempt, verified);
  }

  // ---------------------------------------------------------------------------------
  // Phone sign-in codes
  // ---------------------------------------------------------------------------------

  /**
   * Sends a six-digit sign-in code to a phone number. Never says whether the number
   * belongs to an account: every path returns nothing.
   */
  async requestLoginCode(input: { tenant: string; phone: string }, client: ClientInfo) {
    const tenantId = await this.resolveTenant(input.tenant);
    if (tenantId === undefined) return;
    const { phone } = input;
    const { AUTH_OTP_TTL_SECONDS: ttl, AUTH_OTP_RESEND_SECONDS: gap } = this.deps.env;

    const code = await this.deps.uow.runAs(this.preAuthContext(tenantId, client), async (db) => {
      const user = await db.userAccount.findFirst({ where: { phone } });
      // No code for unknown, disabled or locked accounts (a lock must stop this door too).
      if (user?.status !== 'active' || isLocked(user)) return undefined;
      const now = Date.now();
      // One message per AUTH_OTP_RESEND_SECONDS per number, so the endpoint cannot be
      // used to flood someone's phone or run up the SMS bill.
      const recent = await db.otpChallenge.findFirst({
        where: { phone, purpose: 'login', createdAt: { gt: new Date(now - gap * 1000) } },
        select: { id: true },
      });
      if (recent !== null) return undefined;
      // Only the newest code works: earlier unused ones are closed.
      await db.otpChallenge.updateMany({
        where: { phone, purpose: 'login', consumedAt: null },
        data: { consumedAt: new Date(now) },
      });
      // randomInt is uniform over 000000-999999.
      const fresh = String(randomInt(1_000_000)).padStart(6, '0');
      await db.otpChallenge.create({
        data: {
          tenantId,
          userId: user.id,
          phone,
          purpose: 'login',
          codeHash: this.deps.mfa.hashCode(otpScope(tenantId, phone), fresh),
          expiresAt: new Date(now + ttl * 1000),
        },
      });
      return fresh;
    });
    if (code === undefined) return;
    this.deliver({
      channel: 'sms',
      to: phone,
      purpose: 'login_code',
      text:
        `Your ${this.deps.env.AUTH_TOTP_ISSUER} sign-in code is ${code}. ` +
        `It expires in ${String(Math.ceil(ttl / 60))} minutes. Do not share it with anyone.`,
    });
  }

  /** Signs in with a phone number and the code sent to it. */
  async loginWithCode(
    input: { tenant: string; phone: string; code: string },
    client: ClientInfo,
  ): Promise<SignInResult> {
    const tenantId = await this.resolveTenant(input.tenant);
    if (tenantId === undefined) throw new InvalidCredentialsError();
    const attempt: Attempt = { tenantId, identifier: input.phone, method: 'otp', client };
    const verified = await this.deps.uow.runAs(this.preAuthContext(tenantId, client), (db) =>
      this.checkLoginCode(db, attempt, input.code),
    );
    if (verified === undefined) throw new InvalidCredentialsError();
    // The code replaces the password only: an authenticator app is still asked for.
    return this.afterFirstFactor(attempt, verified);
  }

  private async checkLoginCode(
    db: Db,
    attempt: Attempt,
    code: string,
  ): Promise<Verified | undefined> {
    const phone = attempt.identifier;
    const now = new Date();
    const challenge = await db.otpChallenge.findFirst({
      where: { phone, purpose: 'login', consumedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
    });
    const challengeUserId = challenge?.userId ?? null;
    if (challenge === null || challengeUserId === null) {
      await this.recordLogin(db, attempt, null, 'bad_credentials');
      return undefined;
    }
    const user = await db.userAccount.findFirst({ where: { id: challengeUserId } });
    if (user?.status !== 'active') {
      await this.recordLogin(db, attempt, user?.id ?? null, 'disabled');
      return undefined;
    }
    if (isLocked(user)) {
      await this.recordLogin(db, attempt, user.id, 'locked');
      return undefined;
    }
    // Count the try before looking at the code (the database does the increment, so
    // simultaneous tries all count). Past the limit even the right code is refused.
    const { attempts } = await db.otpChallenge.update({
      where: { id: challenge.id },
      data: { attempts: { increment: 1 } },
      select: { attempts: true },
    });
    const expected = Buffer.from(challenge.codeHash);
    const given = Buffer.from(this.deps.mfa.hashCode(otpScope(attempt.tenantId, phone), code));
    const matches =
      attempts <= this.deps.env.AUTH_MAX_FAILED_ATTEMPTS &&
      expected.length === given.length &&
      timingSafeEqual(expected, given);
    if (!matches) {
      // Also counted against the account, so asking for new codes does not buy new tries.
      await this.registerFailure(db, user.id);
      await this.recordLogin(db, attempt, user.id, 'bad_credentials');
      return undefined;
    }
    // Use the code up; "still unused" is part of the condition, so it works exactly once.
    const claimed = await db.otpChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null },
      data: { consumedAt: now },
    });
    if (claimed.count !== 1) {
      await this.recordLogin(db, attempt, user.id, 'bad_credentials');
      return undefined;
    }
    return this.firstFactorPassed(db, attempt, user);
  }

  /**
   * Hands a message to the messaging adapter without waiting for it. The caller's
   * response therefore takes the same time whether or not a message exists, and a
   * provider outage cannot reveal (through an error) that the account exists.
   */
  private deliver(message: OutboundMessage): void {
    void this.deps.messaging.send(message).catch((err: unknown) => {
      this.deps.logger.error(
        { err, channel: message.channel, purpose: message.purpose },
        'a sign-in message could not be sent',
      );
    });
  }

  /**
   * Counts one wrong password. The increment is done by the database (not read-then-
   * write) so two wrong attempts at the same moment both count. On reaching the limit the
   * account is locked and the counter starts again for after the lock.
   */
  private async registerFailure(db: Db, userId: string): Promise<void> {
    const { failedAttempts } = await db.userAccount.update({
      where: { id: userId },
      data: { failedAttempts: { increment: 1 } },
      select: { failedAttempts: true },
    });
    if (failedAttempts >= this.deps.env.AUTH_MAX_FAILED_ATTEMPTS) {
      await db.userAccount.update({
        where: { id: userId },
        data: {
          failedAttempts: 0,
          lockedUntil: new Date(Date.now() + this.deps.env.AUTH_LOCK_MINUTES * 60_000),
        },
      });
    }
  }

  // ---------------------------------------------------------------------------------
  // Refresh and sign-out
  // ---------------------------------------------------------------------------------

  async refresh(refreshToken: string, client: ClientInfo): Promise<IssuedSession> {
    const tenantId = tenantOfToken(refreshToken);
    if (tenantId === undefined) throw new UnauthenticatedError('The session has ended');
    // Step 1 (read only, as "nobody yet"): which session does this token belong to?
    const owner = await this.sessionOfToken(tenantId, refreshToken, client);
    if (owner === undefined) throw new UnauthenticatedError('The session has ended');
    // Step 2, as that session's user in its company: every check and write happens here.
    const issued = await this.deps.uow.runAs(
      this.sessionContext(tenantId, owner.userId, owner.companyId, client),
      (db) => this.rotate(db, tenantId, refreshToken, client),
    );
    // A detected reuse has committed its revocations by now.
    if (issued === undefined) throw new UnauthenticatedError('The session has ended');
    return issued;
  }

  private async rotate(
    db: Db,
    tenantId: string,
    refreshToken: string,
    client: ClientInfo,
  ): Promise<IssuedSession | undefined> {
    const row = await db.refreshToken.findUnique({
      where: { tokenHash: sha256(refreshToken) },
      include: { session: true },
    });
    if (row === null) return undefined;
    // Already used: either an attacker or the real user holds a copy, and we cannot tell
    // which. End the whole session so the copy is worthless.
    if (row.usedAt !== null) {
      await this.revokeSession(db, row.sessionId, null, 'refresh_token_reuse');
      return undefined;
    }
    const now = new Date();
    if (row.revokedAt !== null || row.expiresAt <= now || row.session.revokedAt !== null) {
      return undefined;
    }
    const user = await db.userAccount.findFirst({ where: { id: row.session.userId } });
    if (user?.status !== 'active') {
      await this.revokeSession(db, row.sessionId, null, 'user_inactive');
      return undefined;
    }
    // Claim the token with a conditional update. If two requests present it at the same
    // moment, the database lets exactly one of them match `usedAt IS NULL`; the other
    // sees zero rows and is treated as reuse.
    const claimed = await db.refreshToken.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) {
      await this.revokeSession(db, row.sessionId, null, 'refresh_token_reuse');
      return undefined;
    }

    // Roles are read again, so a role change reaches the user at the next refresh. A
    // session stays in the company it was opened for; if the user is no longer an active
    // member there, the session ends and they sign in again.
    const access = await this.accessIn(db, user.id, row.session.companyId);
    if (access === undefined) {
      await this.revokeSession(db, row.sessionId, null, 'membership_ended');
      return undefined;
    }
    await db.session.update({
      where: { id: row.sessionId },
      data: { lastSeenAt: now, ip: client.ip ?? row.session.ip },
    });
    const next = await this.createRefreshToken(db, tenantId, row.sessionId, row.familyId, row.id);
    // Read again as well: a role that now demands two-step verification restricts the
    // session from this refresh on, until the user has set it up.
    const mfa = await this.deps.mfa.state(db, user.id);
    return {
      ...this.grant(user, row.sessionId, access, mfa),
      refreshToken: next.token,
      refreshExpiresAt: next.expiresAt,
    };
  }

  /** Signs out the session a refresh token belongs to. Unknown tokens are ignored. */
  async logoutByRefreshToken(refreshToken: string, client: ClientInfo): Promise<void> {
    const tenantId = tenantOfToken(refreshToken);
    if (tenantId === undefined) return;
    const owner = await this.sessionOfToken(tenantId, refreshToken, client);
    if (owner === undefined) return;
    await this.revokeInOwnContext(tenantId, owner, owner.userId, 'logout', client);
  }

  /** Signs out the session of the current access token. */
  async logoutCurrent(): Promise<void> {
    const { userId, sessionId } = currentUser();
    await this.deps.uow.run((db) => this.revokeSession(db, sessionId, userId, 'logout'));
  }

  /** The session a refresh token belongs to. Read only; runs before any identity exists. */
  private sessionOfToken(
    tenantId: string,
    refreshToken: string,
    client: ClientInfo,
  ): Promise<SessionRef | undefined> {
    return this.deps.uow.runAs(this.preAuthContext(tenantId, client), async (db) => {
      const row = await db.refreshToken.findUnique({
        where: { tokenHash: sha256(refreshToken) },
        include: { session: true },
      });
      if (row === null) return undefined;
      return { id: row.sessionId, userId: row.session.userId, companyId: row.session.companyId };
    });
  }

  /**
   * Revokes a session in its own transaction, scoped to that session's company. A user
   * can have sessions in several companies, and the audit row of each belongs to its
   * company, so one transaction scoped to the caller's current company cannot end them all.
   */
  private revokeInOwnContext(
    tenantId: string,
    session: Pick<SessionRef, 'id' | 'companyId'>,
    actorId: string,
    reason: string,
    client: ClientInfo = { ip: currentContext()?.ip },
  ): Promise<void> {
    return this.deps.uow.runAs(
      this.sessionContext(tenantId, actorId, session.companyId, client),
      (db) => this.revokeSession(db, session.id, actorId, reason),
    );
  }

  /**
   * Ends a session: marks it and its unused refresh tokens revoked, and lists it in Redis
   * so access tokens already issued for it stop working at once instead of at expiry.
   * Redis is written inside the transaction on purpose: if Redis is down the transaction
   * rolls back and the caller gets an error, rather than a "signed out" that is not true.
   * Public for kernel/auth/impersonation.ts, which ends impersonation sessions this way.
   */
  async revokeSession(
    db: Db,
    sessionId: string,
    revokedBy: string | null,
    reason: string,
  ): Promise<void> {
    const now = new Date();
    await db.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: now, revokedBy, revokeReason: reason },
    });
    await db.refreshToken.updateMany({
      where: { sessionId, revokedAt: null },
      data: { revokedAt: now },
    });
    // Kept a little longer than the longest access token lives (an impersonation token
    // can outlive a normal one), to cover clock differences.
    const longest = Math.max(
      this.deps.tokens.lifetimeSeconds,
      this.deps.env.AUTH_IMPERSONATION_TTL_SECONDS,
    );
    await this.deps.redis.set(sessionRevokedKey(sessionId), reason, 'EX', longest + 60);
  }

  // ---------------------------------------------------------------------------------
  // Password change
  // ---------------------------------------------------------------------------------

  /**
   * Changes the signed-in user's password. Returns a fresh access token for the current
   * session (the old one may carry the "must change password" flag).
   */
  async changePassword(input: {
    currentPassword: string;
    newPassword: string;
  }): Promise<AccessGrant> {
    const { userId, sessionId, tenantId } = currentUser();
    const result = await this.deps.uow.run(async (db) => {
      const user = await db.userAccount.findFirst({ where: { id: userId } });
      if (user === null) throw new UnauthenticatedError();
      const current = await db.credential.findFirst({
        where: { userId, kind: 'password', isCurrent: true },
      });
      if (current === null || !(await verifyPassword(current.hash, input.currentPassword))) {
        // Counted like a failed sign-in, so a stolen access token cannot be used to
        // guess the password without limit. Returned (not thrown) so the count commits.
        await this.registerFailure(db, userId);
        return undefined;
      }
      await this.setPassword(db, tenantId, userId, input.newPassword);
      await db.userAccount.update({
        where: { id: userId },
        data: { mustChangePassword: false, failedAttempts: 0 },
      });
      const others = await db.session.findMany({
        where: { userId, revokedAt: null, id: { not: sessionId } },
        select: { id: true, companyId: true },
      });
      return { others, grant: await this.freshGrant(db, { ...user, mustChangePassword: false }) };
    });
    if (result === undefined) {
      throw new UnprocessableError(
        'current_password_incorrect',
        'The current password is not correct',
      );
    }
    // Anyone else signed in with the old password is signed out. Done after the change
    // has committed, one session at a time, because each may belong to another company
    // (see revokeInOwnContext). If one fails the request fails loudly; the password is
    // already changed, and repeating the sign-out from "my sessions" finishes the job.
    for (const other of result.others) {
      await this.revokeInOwnContext(tenantId, other, userId, 'password_changed');
    }
    return result.grant;
  }

  /**
   * Stores a new password after checking the password policy:
   *   1. minimum length (AUTH_PASSWORD_MIN_LENGTH);
   *   2. not the current password and not one of the AUTH_PASSWORD_HISTORY before it.
   * Old hashes are kept (is_current = false) precisely so rule 2 can be checked.
   */
  private async setPassword(
    db: Db,
    tenantId: string,
    userId: string,
    password: string,
  ): Promise<void> {
    const { AUTH_PASSWORD_MIN_LENGTH: minLength, AUTH_PASSWORD_HISTORY: history } = this.deps.env;
    if (password.length < minLength) {
      throw new ValidationError([
        {
          path: 'newPassword',
          code: 'too_short',
          message: `Use at least ${String(minLength)} characters`,
        },
      ]);
    }
    const previous = await db.credential.findMany({
      where: { userId, kind: 'password' },
      orderBy: { setAt: 'desc' },
      take: history + 1,
    });
    for (const old of previous) {
      if (await verifyPassword(old.hash, password)) {
        throw new UnprocessableError(
          'password_reused',
          'Choose a password you have not used recently',
        );
      }
    }
    const hash = await hashPassword(password);
    // Retire the current hash first: the database allows one current password per user.
    await db.credential.updateMany({
      where: { userId, kind: 'password', isCurrent: true },
      data: { isCurrent: false },
    });
    await db.credential.create({ data: { tenantId, userId, kind: 'password', hash } });
  }

  // ---------------------------------------------------------------------------------
  // Forgotten password
  // ---------------------------------------------------------------------------------

  /**
   * Sends a password-reset link by email (or by SMS when the account has no email).
   * Never says whether the account exists: every path returns nothing.
   */
  async forgotPassword(input: { tenant: string; identifier: string }, client: ClientInfo) {
    const tenantId = await this.resolveTenant(input.tenant);
    if (tenantId === undefined) return;
    const identifier = input.identifier.trim().toLowerCase();

    const issued = await this.deps.uow.runAs(this.preAuthContext(tenantId, client), async (db) => {
      const user = await db.userAccount.findFirst({
        where: { OR: [{ username: identifier }, { email: identifier }, { phone: identifier }] },
      });
      return user === null ? undefined : this.issueResetToken(db, user);
    });
    if (issued !== undefined) this.deliverResetLink(issued);
  }

  /**
   * An administrator sends a user the same reset link (POST /users/{id}/reset-password).
   * The administrator never sees or chooses the password. Unlike the public route this
   * one says when nothing could be sent, because the caller already knows the account.
   * The caller's permission over the target user is checked by the router before this.
   */
  async adminSendPasswordReset(userId: string): Promise<{ channel: 'email' | 'sms' }> {
    currentUser();
    const issued = await this.deps.uow.run(async (db) => {
      const user = await db.userAccount.findFirst({ where: { id: userId } });
      if (user === null) throw new NotFoundError();
      return this.issueResetToken(db, user);
    });
    if (issued === undefined) {
      throw new UnprocessableError(
        'reset_not_sent',
        'No link was sent: the account is disabled, has no email or phone, or was sent one a moment ago',
      );
    }
    this.deliverResetLink(issued);
    return { channel: issued.to.channel };
  }

  /** Creates a reset token for the user, or nothing when one must not or cannot be sent. */
  private async issueResetToken(db: Db, user: UserRow) {
    const { AUTH_RESET_TTL_MINUTES: ttl, AUTH_OTP_RESEND_SECONDS: gap } = this.deps.env;
    // A locked account may still reset (the lock is about guessing, and the link goes
    // only to the owner's own inbox); a disabled one may not.
    if (user.status !== 'active') return undefined;
    const to =
      user.email !== null
        ? ({ channel: 'email', address: user.email } as const)
        : user.phone !== null
          ? ({ channel: 'sms', address: user.phone } as const)
          : undefined;
    // Nowhere to send it.
    if (to === undefined) return undefined;
    const now = Date.now();
    // One link per AUTH_OTP_RESEND_SECONDS, so the endpoint cannot flood an inbox.
    const recent = await db.passwordResetToken.findFirst({
      where: { userId: user.id, createdAt: { gt: new Date(now - gap * 1000) } },
      select: { id: true },
    });
    if (recent !== null) return undefined;
    // Only the newest link works: earlier unused ones are retired (soft-deleted).
    await db.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { deletedAt: new Date(now), deleteReason: 'superseded' },
    });
    // Same shape as a refresh token: "<tenant id>.<256 random bits>", stored as a hash.
    const token = `${user.tenantId}.${randomBytes(32).toString('base64url')}`;
    await db.passwordResetToken.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        tokenHash: sha256(token),
        expiresAt: new Date(now + ttl * 60_000),
      },
    });
    return { to, token };
  }

  private deliverResetLink(issued: {
    to: { channel: 'email' | 'sms'; address: string };
    token: string;
  }): void {
    // The token rides in the URL fragment (after #), which browsers never send to a
    // server, so it cannot end up in web-server or proxy logs.
    const link = new URL('/reset-password', this.deps.env.WEB_BASE_URL);
    link.hash = `token=${issued.token}`;
    const product = this.deps.env.AUTH_TOTP_ISSUER;
    const ttl = this.deps.env.AUTH_RESET_TTL_MINUTES;
    this.deliver({
      channel: issued.to.channel,
      to: issued.to.address,
      purpose: 'password_reset',
      subject: `Reset your ${product} password`,
      text:
        `Use this link to choose a new ${product} password. It works once and expires in ` +
        `${String(ttl)} minutes: ${link.toString()} If you did not ask for it, ignore this message.`,
    });
  }

  /** Sets a new password using the token from a reset link, and signs the user out everywhere. */
  async resetPassword(input: { token: string; newPassword: string }, client: ClientInfo) {
    const invalid = () =>
      new UnprocessableError(
        'reset_token_invalid',
        'This reset link is not valid or has expired. Ask for a new one.',
      );
    const tenantId = tenantOfToken(input.token);
    if (tenantId === undefined) throw invalid();
    const tokenHash = sha256(input.token);

    // Step 1 (read only, as "nobody yet"): whose token is this?
    const owner = await this.deps.uow.runAs(this.preAuthContext(tenantId, client), (db) =>
      db.passwordResetToken.findUnique({ where: { tokenHash }, select: { userId: true } }),
    );
    if (owner === null) throw invalid();
    const { userId } = owner;

    // Step 2, as that user, so the audit trail names them as the one who changed it.
    const sessions = await this.deps.uow.runAs(
      this.sessionContext(tenantId, userId, null, client),
      async (db) => {
        const user = await db.userAccount.findFirst({ where: { id: userId } });
        if (user?.status !== 'active') return undefined;
        // Use the token up. Unused and unexpired are part of the condition, so of two
        // requests with the same link exactly one gets through.
        const now = new Date();
        const claimed = await db.passwordResetToken.updateMany({
          where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
          data: { usedAt: now },
        });
        if (claimed.count !== 1) return undefined;
        // If the new password breaks the policy this throws, the transaction rolls back
        // and the link is still usable for a better password.
        await this.setPassword(db, tenantId, userId, input.newPassword);
        await db.userAccount.update({
          where: { id: userId },
          data: { mustChangePassword: false, failedAttempts: 0, lockedUntil: null },
        });
        return db.session.findMany({
          where: { userId, revokedAt: null },
          select: { id: true, companyId: true },
        });
      },
    );
    if (sessions === undefined) throw invalid();
    // Whoever knew the old password is signed out. One session at a time, each in its
    // own company (see revokeInOwnContext).
    for (const session of sessions) {
      await this.revokeInOwnContext(tenantId, session, userId, 'password_reset', client);
    }
  }

  // ---------------------------------------------------------------------------------
  // Authenticator app: set up, confirm, remove
  // ---------------------------------------------------------------------------------

  /** Step 1: returns the seed (text, and the link behind the QR code) to load into the app. */
  async setupTotp(): Promise<{ secret: string; otpauthUrl: string }> {
    const { userId } = currentUser();
    return this.deps.uow.run(async (db) => {
      const user = await db.userAccount.findFirst({ where: { id: userId } });
      if (user === null) throw new UnauthenticatedError();
      return this.deps.mfa.beginTotpSetup(db, user);
    });
  }

  /**
   * Step 2: a code from the app switches two-step verification on. Returns the recovery
   * codes (shown this once) and a fresh access token without the "set it up" restriction.
   */
  async confirmTotp(code: string): Promise<AccessGrant & { recoveryCodes: string[] }> {
    const { userId } = currentUser();
    const result = await this.deps.uow.run(async (db) => {
      const user = await db.userAccount.findFirst({ where: { id: userId } });
      if (user === null) throw new UnauthenticatedError();
      const recoveryCodes = await this.deps.mfa.confirmTotpSetup(db, user, code);
      if (recoveryCodes === undefined) {
        // Returned (not thrown) so the count commits; see changePassword.
        await this.registerFailure(db, userId);
        return undefined;
      }
      return { ...(await this.freshGrant(db, user)), recoveryCodes };
    });
    if (result === undefined) {
      throw new UnprocessableError('mfa_code_incorrect', 'That code is not correct. Try again.');
    }
    return result;
  }

  /**
   * Removes the authenticator app. A sensitive action: it needs a recent
   * re-authentication. If the user's roles demand two-step verification, the returned
   * access token is restricted again until a new app is set up.
   */
  async disableTotp(): Promise<AccessGrant> {
    const { userId } = currentUser();
    await this.assertRecentReauth();
    return this.deps.uow.run(async (db) => {
      const user = await db.userAccount.findFirst({ where: { id: userId } });
      if (user === null) throw new UnauthenticatedError();
      if (!(await this.deps.mfa.disableTotp(db, userId))) {
        throw new NotFoundError('No authenticator app is set up');
      }
      return this.freshGrant(db, user);
    });
  }

  // ---------------------------------------------------------------------------------
  // Re-authentication (step-up for sensitive actions)
  // ---------------------------------------------------------------------------------

  /**
   * Proves again that the person at the keyboard is the account owner. A user with an
   * authenticator app must give a code from it (or a recovery code); a user without one
   * gives their password. Success is remembered for this session only, for
   * AUTH_REAUTH_TTL_SECONDS.
   */
  async reauthenticate(input: {
    password?: string | undefined;
    code?: string | undefined;
  }): Promise<{ validUntil: string }> {
    const { userId, sessionId } = currentUser();
    const ok = await this.deps.uow.run(async (db) => {
      const user = await db.userAccount.findFirst({ where: { id: userId } });
      if (user === null) throw new UnauthenticatedError();
      // A locked account cannot step up either, whatever is presented.
      if (isLocked(user)) return false;
      const mfa = await this.deps.mfa.state(db, userId);
      let passed: boolean;
      if (mfa.enabled) {
        if (input.code === undefined)
          throw missing('code', 'Enter a code from your authenticator app');
        passed = await this.deps.mfa.verifyCode(db, userId, input.code);
      } else {
        if (input.password === undefined) throw missing('password', 'Enter your password');
        const current = await db.credential.findFirst({
          where: { userId, kind: 'password', isCurrent: true },
        });
        passed = current !== null && (await verifyPassword(current.hash, input.password));
      }
      // Counted like a failed sign-in, so a stolen access token cannot guess without limit.
      if (!passed) await this.registerFailure(db, userId);
      return passed;
    });
    if (!ok) {
      throw new UnprocessableError(
        'reauth_failed',
        'That is not correct, or the account is locked',
      );
    }
    const ttl = this.deps.env.AUTH_REAUTH_TTL_SECONDS;
    await this.deps.redis.set(reauthKey(sessionId), '1', 'EX', ttl);
    return { validUntil: new Date(Date.now() + ttl * 1000).toISOString() };
  }

  /**
   * Guard for sensitive actions: passes only when this session re-authenticated within
   * AUTH_REAUTH_TTL_SECONDS. If Redis cannot be reached this throws, which is the safe side.
   */
  async assertRecentReauth(): Promise<void> {
    const { sessionId } = currentUser();
    if ((await this.deps.redis.exists(reauthKey(sessionId))) !== 1) throw new ReauthRequiredError();
  }

  // ---------------------------------------------------------------------------------
  // The signed-in user: profile, sessions, login history
  // ---------------------------------------------------------------------------------

  async me(): Promise<
    Omit<AccessGrant, 'accessToken' | 'expiresIn'> & { sessionId: string; mfaEnabled: boolean }
  > {
    const { userId, sessionId } = currentUser();
    const companyId = requireContext().companyIds[0];
    return this.deps.uow.run(async (db) => {
      const user = await db.userAccount.findFirst({ where: { id: userId } });
      if (user === null) throw new UnauthenticatedError();
      const access = (await this.accessIn(db, userId, companyId ?? null)) ?? NO_ACCESS;
      const mfa = await this.deps.mfa.state(db, userId);
      return {
        user: toSessionUser(user),
        companyId: access.companyId,
        roles: access.roleKeys,
        sessionId,
        mfaEnabled: mfa.enabled,
        mfaEnrolmentRequired: mfa.required && !mfa.enabled,
      };
    });
  }

  // ---------------------------------------------------------------------------------
  // Companies: which ones the user may work in, and moving between them
  // ---------------------------------------------------------------------------------

  /** The companies the signed-in user is an active member of, the default one first. */
  async listCompanies() {
    const { userId } = currentUser();
    const current = requireContext().companyIds[0] ?? null;
    return this.deps.uow.run(async (db) => {
      const memberships = await db.companyMembership.findMany({
        where: { userId, status: 'active', company: { status: 'active', deletedAt: null } },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
        include: { company: { select: { legalName: true, tradeName: true } } },
      });
      return memberships.map((m) => ({
        id: m.companyId,
        name: m.company.tradeName ?? m.company.legalName,
        isDefault: m.isDefault,
        current: m.companyId === current,
      }));
    });
  }

  /**
   * Moves the signed-in user to another of their companies.
   *
   * A session belongs to one company for its whole life: the database refuses to change
   * `company_id` on any row (tenancy columns are immutable), and that is what keeps every
   * audit row of a session in one company. So switching does not edit the session; it
   *   1. checks, in the target company's scope, that the user is an active member of it
   *      and that the company is active (403 otherwise, with nothing created);
   *   2. opens a new session there with a new refresh-token family and the role keys the
   *      user holds in that company;
   *   3. ends the old session, so its access and refresh tokens stop working.
   * The new session has not re-authenticated: sensitive actions ask again after a switch.
   */
  async switchCompany(companyId: string, client: ClientInfo): Promise<IssuedSession> {
    const { userId, tenantId, sessionId } = currentUser();
    const previous = requireContext().companyIds[0] ?? null;
    const issued = await this.deps.uow.runAs(
      this.sessionContext(tenantId, userId, companyId, client),
      async (db) => {
        const user = await db.userAccount.findFirst({ where: { id: userId } });
        if (user?.status !== 'active') throw new UnauthenticatedError();
        const access = await this.accessIn(db, userId, companyId);
        const company = await db.company.findFirst({
          where: { id: companyId, status: 'active' },
          select: { id: true },
        });
        // One answer whether the company does not exist, is inactive or is not theirs.
        if (access === undefined || company === null) {
          throw new ForbiddenError('You do not have access to that company');
        }
        const session = await db.session.create({
          data: {
            tenantId,
            userId,
            companyId,
            ip: client.ip ?? null,
            userAgent: client.userAgent?.slice(0, 512) ?? null,
          },
        });
        const refresh = await this.createRefreshToken(db, tenantId, session.id, randomUUID(), null);
        return {
          ...this.grant(user, session.id, access, await this.deps.mfa.state(db, userId)),
          refreshToken: refresh.token,
          refreshExpiresAt: refresh.expiresAt,
        };
      },
    );
    await this.revokeInOwnContext(
      tenantId,
      { id: sessionId, companyId: previous },
      userId,
      'switched_company',
      client,
    );
    return issued;
  }

  /**
   * Ends every session of a user (administrator action: lock, forced sign-out, access
   * changed, account deleted). Each session is ended in its own company's scope; see
   * revokeInOwnContext. The caller's permission over the user is checked before this.
   * Sessions in which this user is impersonating someone else end too: a locked or
   * signed-out administrator must not keep acting through another person's account.
   */
  async revokeAllSessionsOf(userId: string, reason: string): Promise<number> {
    const actor = currentUser();
    const sessions = await this.deps.uow.run((db) =>
      db.session.findMany({
        where: { revokedAt: null, OR: [{ userId }, { impersonation: { actorUserId: userId } }] },
        select: { id: true, companyId: true },
      }),
    );
    for (const session of sessions) {
      await this.revokeInOwnContext(actor.tenantId, session, actor.userId, reason);
    }
    return sessions.length;
  }

  /** Active sessions of the signed-in user, or of `ofUserId` for an administrator. */
  async listSessions(ofUserId?: string) {
    const { userId: self, sessionId } = currentUser();
    const userId = ofUserId ?? self;
    return this.deps.uow.run(async (db) => {
      const rows = await db.session.findMany({
        where: { userId, revokedAt: null },
        orderBy: { lastSeenAt: 'desc' },
      });
      return rows.map((s) => ({
        id: s.id,
        current: s.id === sessionId,
        companyId: s.companyId,
        device: s.device,
        userAgent: s.userAgent,
        ip: s.ip,
        createdAt: s.createdAt.toISOString(),
        lastSeenAt: s.lastSeenAt.toISOString(),
      }));
    });
  }

  /** Remote sign-out of one of the caller's own sessions. */
  async revokeOwnSession(targetSessionId: string): Promise<void> {
    const { userId, tenantId } = currentUser();
    // Filtering by the caller's user id is the ownership check: another user's session
    // id behaves exactly like one that does not exist.
    const session = await this.deps.uow.run((db) =>
      db.session.findFirst({
        where: { id: targetSessionId, userId, revokedAt: null },
        select: { id: true, companyId: true },
      }),
    );
    if (session === null) throw new NotFoundError('No such active session');
    await this.revokeInOwnContext(tenantId, session, userId, 'revoked_by_user');
  }

  /** Sign-in history of the signed-in user, or of `ofUserId` for an administrator. */
  async loginHistory(limit: number, ofUserId?: string) {
    const userId = ofUserId ?? currentUser().userId;
    return this.deps.uow.run(async (db) => {
      const rows = await db.loginEvent.findMany({
        where: { userId },
        orderBy: { at: 'desc' },
        take: limit,
      });
      return rows.map((e) => ({
        at: e.at.toISOString(),
        method: e.method,
        result: e.result,
        ip: e.ip,
        userAgent: e.userAgent,
      }));
    });
  }

  // ---------------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------------

  /** Tenant id for a slug, through the one function allowed to read tenants unauthenticated. */
  private async resolveTenant(slug: string): Promise<string | undefined> {
    const rows = await this.deps.prisma.$queryRaw<{ id: string | null }[]>`
      SELECT iam.resolve_tenant(${slug})::text AS id`;
    return rows[0]?.id ?? undefined;
  }

  /** Database context for a caller who has named a tenant but is not signed in yet. */
  private preAuthContext(tenantId: string, client: ClientInfo): DbContext {
    const requestId = currentContext()?.requestId;
    return {
      tenantId,
      companyIds: [],
      ...(requestId === undefined ? {} : { requestId }),
      ...(client.ip === undefined ? {} : { ip: client.ip }),
    };
  }

  /**
   * Database context for work done on behalf of a known user in a session's company:
   * creating, rotating or revoking that session.
   */
  private sessionContext(
    tenantId: string,
    userId: string,
    companyId: string | null,
    client: ClientInfo,
  ): DbContext {
    return {
      ...this.preAuthContext(tenantId, client),
      companyIds: companyId === null ? [] : [companyId],
      userId,
    };
  }

  private activeMemberships(db: Db, userId: string) {
    return db.companyMembership.findMany({
      where: { userId, status: 'active' },
      // The default company first, then the oldest membership.
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      // Nested rows are not covered by the soft-delete filter, so it is stated here.
      include: { roles: { where: { deletedAt: null }, include: { role: true } } },
    });
  }

  /**
   * Where a new session starts: the user's default company (else their oldest active
   * membership) and their role keys there. A user with no membership gets no company and
   * no roles: they can sign in but reach nothing company-scoped.
   */
  private async defaultAccess(db: Db, userId: string): Promise<Access> {
    const [first] = await this.activeMemberships(db, userId);
    return first === undefined ? NO_ACCESS : toAccess(first);
  }

  /**
   * The user's current role keys in one given company (an existing session's company).
   * Undefined when they are no longer an active member of it. A session without a
   * company stays without one.
   */
  private async accessIn(
    db: Db,
    userId: string,
    companyId: string | null,
  ): Promise<Access | undefined> {
    if (companyId === null) return NO_ACCESS;
    const membership = (await this.activeMemberships(db, userId)).find(
      (m) => m.companyId === companyId,
    );
    return membership === undefined ? undefined : toAccess(membership);
  }

  private async createRefreshToken(
    db: Db,
    tenantId: string,
    sessionId: string,
    familyId: string,
    rotatedFromId: string | null,
  ): Promise<{ token: string; expiresAt: Date }> {
    // "<tenant id>.<256 random bits>": the prefix tells the refresh endpoint which tenant
    // to look in (row-level security needs one before any row can be read). It is not a
    // secret; the random part is.
    const token = `${tenantId}.${randomBytes(32).toString('base64url')}`;
    const expiresAt = new Date(Date.now() + this.deps.env.AUTH_REFRESH_TTL_DAYS * 86_400_000);
    await db.refreshToken.create({
      data: { tenantId, sessionId, familyId, tokenHash: sha256(token), rotatedFromId, expiresAt },
    });
    return { token, expiresAt };
  }

  private grant(user: UserRow, sessionId: string, access: Access, mfa: MfaState): AccessGrant {
    // Demanded by a role but not set up yet: the token is marked, and authenticate.ts
    // then lets it reach only the set-up routes.
    const mfaEnrolmentRequired = mfa.required && !mfa.enabled;
    const accessToken = this.deps.tokens.issue({
      userId: user.id,
      tenantId: user.tenantId,
      sessionId,
      companyId: access.companyId ?? undefined,
      roleKeys: access.roleKeys,
      mustChangePassword: user.mustChangePassword,
      mfaEnrolmentRequired,
    });
    return {
      accessToken,
      expiresIn: this.deps.tokens.lifetimeSeconds,
      user: toSessionUser(user),
      companyId: access.companyId,
      roles: access.roleKeys,
      mfaEnrolmentRequired,
    };
  }

  /**
   * A new access token for the current session, after something it states has changed
   * (password changed, authenticator app added or removed).
   */
  private async freshGrant(db: Db, user: UserRow): Promise<AccessGrant> {
    const { sessionId } = currentUser();
    const companyId = requireContext().companyIds[0] ?? null;
    const access = (await this.accessIn(db, user.id, companyId)) ?? NO_ACCESS;
    return this.grant(user, sessionId, access, await this.deps.mfa.state(db, user.id));
  }
}

function toSessionUser(user: UserRow): SessionUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    preferredLanguage: user.preferredLanguage,
    mustChangePassword: user.mustChangePassword,
  };
}

function missing(path: string, message: string): ValidationError {
  return new ValidationError([{ path, code: 'required', message }]);
}

/** The tenant id in front of a refresh or reset token, when the token is well formed. */
function tenantOfToken(token: string): string | undefined {
  const dot = token.indexOf('.');
  if (dot !== 36 || token.length > 128) return undefined;
  const tenantId = token.slice(0, dot);
  return UUID.test(tenantId) ? tenantId : undefined;
}

/** The signed-in user of the current request; 401 for anonymous callers and API clients. */
function currentUser(): { userId: string; tenantId: string; sessionId: string } {
  const ctx = requireContext();
  const principal = ctx.principal;
  if (principal?.kind !== 'user' || ctx.sessionId === undefined) throw new UnauthenticatedError();
  return { userId: principal.userId, tenantId: principal.tenantId, sessionId: ctx.sessionId };
}
