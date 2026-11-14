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
 * Not here yet: MFA, phone one-time codes, forgot/reset password, re-authentication
 * (part 7b); permissions and company switching (7c); impersonation and API keys (7d).
 *
 * Depends on: kernel/db (unit of work, Prisma), ioredis, ./password-hasher.ts,
 * ./access-token.ts, kernel/context, kernel/http/errors.ts.
 * Used by: kernel/auth/auth-router.ts, kernel/auth/authenticate.ts (revocation key).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Env } from '../config/env.js';
import { currentContext, requireContext } from '../context/request-context.js';
import type { Db, PrismaDb } from '../db/prisma.js';
import type { DbContext, UnitOfWork } from '../db/unit-of-work.js';
import {
  AppError,
  NotFoundError,
  UnauthenticatedError,
  UnprocessableError,
  ValidationError,
} from '../http/errors.js';
import type { AccessTokens } from './access-token.js';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './password-hasher.js';

export type AuthEnv = Pick<
  Env,
  | 'AUTH_REFRESH_TTL_DAYS'
  | 'AUTH_MAX_FAILED_ATTEMPTS'
  | 'AUTH_LOCK_MINUTES'
  | 'AUTH_PASSWORD_MIN_LENGTH'
  | 'AUTH_PASSWORD_HISTORY'
>;

export interface AuthServiceDeps {
  prisma: PrismaDb;
  uow: UnitOfWork;
  redis: Redis;
  tokens: AccessTokens;
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
}

export interface IssuedSession extends AccessGrant {
  refreshToken: string;
  refreshExpiresAt: Date;
}

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
  'success' | 'bad_credentials' | 'locked' | 'disabled' | 'password_change_required';

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
  ): Promise<IssuedSession> {
    const tenantId = await this.resolveTenant(input.tenant);
    if (tenantId === undefined) {
      // Unknown tenant: spend the same time as a real check, then give the same answer.
      await verifyAgainstDummy(input.password);
      throw new InvalidCredentialsError();
    }
    const identifier = input.identifier.trim().toLowerCase();
    const record = (db: Db, userId: string | null, result: LoginResult) =>
      db.loginEvent.create({
        data: {
          tenantId,
          userId,
          identifier: identifier.slice(0, 255),
          method: 'password',
          result,
          ip: client.ip ?? null,
          userAgent: client.userAgent?.slice(0, 512) ?? null,
        },
      });

    // Transaction 1, as "nobody yet": check the credentials and record a failure.
    const verified = await this.deps.uow.runAs(this.preAuthContext(tenantId, client), (db) =>
      this.checkCredentials(db, identifier, input.password, (userId, result) =>
        record(db, userId, result),
      ),
    );
    // It has committed (login history, failure counter, lock), so now it is safe to throw.
    if (verified === undefined) throw new InvalidCredentialsError();

    // Transaction 2, as the user in their company: create the session. Running it under
    // the user's own identity means the audit trail names them as the actor, and the
    // audit row for the session (which carries the company) passes row-level security.
    const { user, access } = verified;
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
        await record(db, user.id, user.mustChangePassword ? 'password_change_required' : 'success');
        return {
          ...this.grant(user, session.id, access),
          refreshToken: refresh.token,
          refreshExpiresAt: refresh.expiresAt,
        };
      },
    );
  }

  /** The user and their access when the password is right; undefined otherwise (recorded). */
  private async checkCredentials(
    db: Db,
    identifier: string,
    password: string,
    record: (userId: string | null, result: LoginResult) => Promise<unknown>,
  ): Promise<{ user: UserRow; access: Access } | undefined> {
    // A person may sign in with their username, email or phone number.
    const user = await db.userAccount.findFirst({
      where: { OR: [{ username: identifier }, { email: identifier }, { phone: identifier }] },
    });
    if (user === null) {
      await verifyAgainstDummy(password);
      await record(null, 'bad_credentials');
      return undefined;
    }
    if (user.status !== 'active') {
      await verifyAgainstDummy(password);
      await record(user.id, 'disabled');
      return undefined;
    }
    // While locked, the password is not even checked: guessing cannot continue, and a
    // correct guess during the lock is not confirmed.
    if (user.lockedUntil !== null && user.lockedUntil.getTime() > Date.now()) {
      await verifyAgainstDummy(password);
      await record(user.id, 'locked');
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
      await record(user.id, 'bad_credentials');
      return undefined;
    }

    await db.userAccount.update({
      where: { id: user.id },
      data: { failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    return { user, access: await this.defaultAccess(db, user.id) };
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
    return {
      ...this.grant(user, row.sessionId, access),
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
   */
  private async revokeSession(
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
    // Kept a little longer than an access token lives, to cover clock differences.
    await this.deps.redis.set(
      sessionRevokedKey(sessionId),
      reason,
      'EX',
      this.deps.tokens.lifetimeSeconds + 60,
    );
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
    const companyId = requireContext().companyIds[0];
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
      const access = (await this.accessIn(db, userId, companyId ?? null)) ?? NO_ACCESS;
      return {
        others,
        grant: this.grant({ ...user, mustChangePassword: false }, sessionId, access),
      };
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
  // The signed-in user: profile, sessions, login history
  // ---------------------------------------------------------------------------------

  async me(): Promise<Omit<AccessGrant, 'accessToken' | 'expiresIn'> & { sessionId: string }> {
    const { userId, sessionId } = currentUser();
    const companyId = requireContext().companyIds[0];
    return this.deps.uow.run(async (db) => {
      const user = await db.userAccount.findFirst({ where: { id: userId } });
      if (user === null) throw new UnauthenticatedError();
      const access = (await this.accessIn(db, userId, companyId ?? null)) ?? NO_ACCESS;
      return {
        user: toSessionUser(user),
        companyId: access.companyId,
        roles: access.roleKeys,
        sessionId,
      };
    });
  }

  async listSessions() {
    const { userId, sessionId } = currentUser();
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

  async loginHistory(limit: number) {
    const { userId } = currentUser();
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

  private grant(user: UserRow, sessionId: string, access: Access): AccessGrant {
    const accessToken = this.deps.tokens.issue({
      userId: user.id,
      tenantId: user.tenantId,
      sessionId,
      companyId: access.companyId ?? undefined,
      roleKeys: access.roleKeys,
      mustChangePassword: user.mustChangePassword,
    });
    return {
      accessToken,
      expiresIn: this.deps.tokens.lifetimeSeconds,
      user: toSessionUser(user),
      companyId: access.companyId,
      roles: access.roleKeys,
    };
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

/** The tenant id in front of a refresh token, when the token is well formed. */
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
