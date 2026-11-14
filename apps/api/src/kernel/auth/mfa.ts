/**
 * Two-step verification factors: authenticator app (TOTP) and recovery codes.
 *
 * Purpose: everything about a user's second factor that touches the database. The
 * arithmetic is in ./totp.ts; who may call what, and what a failure costs (lockout,
 * login history), is decided by ./auth-service.ts. Every method takes the caller's open
 * transaction, so it runs under that caller's row-level security scope.
 *
 * Rules implemented here (each is commented where it is enforced):
 *   - The TOTP seed is stored encrypted (kernel/crypto/secret-box.ts), bound to its user.
 *   - Setting up has two steps: "setup" stores an unconfirmed factor and shows the seed;
 *     "confirm" proves the app really produces codes for it. Only a confirmed factor
 *     counts, so a half-finished setup can never lock anyone out.
 *   - A code is accepted once: the 30-second period of the last accepted code is stored
 *     and anything not newer is refused, so a code read over a shoulder cannot be replayed.
 *   - Confirming hands out RECOVERY_CODE_COUNT recovery codes, shown once. Each works one
 *     time, in place of a code from the app. Only keyed hashes of them are stored.
 *   - Two-step verification is REQUIRED for a user when any role they hold, in any
 *     company, has `mfa_required` set (decision C10: on by default for Super Admin, Admin
 *     and Owner). It is checked across all companies, not only the current one, so
 *     switching company can never be a way around it.
 *
 * Depends on: kernel/db (Db), kernel/crypto/secret-box.ts, ./totp.ts, kernel/http/errors.ts.
 * Used by: kernel/auth/auth-service.ts.
 */
import { createHmac, randomInt } from 'node:crypto';
import type { SecretBox } from '../crypto/secret-box.js';
import type { Db } from '../db/prisma.js';
import { ConflictError } from '../http/errors.js';
import { base32Encode, generateTotpSecret, matchTotp, otpauthUrl } from './totp.js';

export const RECOVERY_CODE_COUNT = 10;
/** Letters and digits that are hard to confuse when typed from paper (no 0/O, 1/I/L). */
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** 10 characters from 31 symbols: about 49 bits, far beyond guessing within the lockout. */
const RECOVERY_CODE_LENGTH = 10;

export interface MfaState {
  /** The user has a confirmed authenticator app. */
  enabled: boolean;
  /** One of the user's roles demands two-step verification. */
  required: boolean;
}

export interface MfaDeps {
  box: SecretBox;
  /** AUTH_TOKEN_SECRET; a separate key is derived from it for hashing one-time codes. */
  tokenSecret: string;
  /** Name shown in the authenticator app next to the account. */
  issuer: string;
  now?: () => number;
}

interface UserRef {
  id: string;
  tenantId: string;
  username: string;
}

export class MfaFactors {
  private readonly box: SecretBox;
  private readonly codeKey: Buffer;
  private readonly issuer: string;
  private readonly now: () => number;

  constructor(deps: MfaDeps) {
    this.box = deps.box;
    // Derived for this one purpose, so it is never the key that signs access tokens.
    this.codeKey = createHmac('sha256', deps.tokenSecret)
      .update('fibrex:one-time-code:v1')
      .digest();
    this.issuer = deps.issuer;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Keyed hash of a short one-time code (recovery code, phone code). The codes are too
   * short for a plain hash to protect: with the database alone every 6-digit value could
   * be tried in a moment. With the key held outside the database that is not possible.
   * `scope` names what the code is for and whose it is, so equal codes hash differently.
   */
  hashCode(scope: string, code: string): string {
    return createHmac('sha256', this.codeKey).update(`${scope}:${code}`).digest('hex');
  }

  async state(db: Db, userId: string): Promise<MfaState> {
    const factor = await db.mfaFactor.findFirst({
      where: { userId, kind: 'totp', confirmedAt: { not: null } },
      select: { id: true },
    });
    // Nested filters are not covered by the soft-delete filter, so each level states it.
    const demanding = await db.membershipRole.findFirst({
      where: {
        membership: { userId, status: 'active', deletedAt: null },
        role: { mfaRequired: true, deletedAt: null },
      },
      select: { id: true },
    });
    return { enabled: factor !== null, required: demanding !== null };
  }

  /**
   * Step 1 of setting up an authenticator app: make a seed and store it unconfirmed.
   * Returns what the app needs (as text and as the link behind the QR code).
   */
  async beginTotpSetup(db: Db, user: UserRef): Promise<{ secret: string; otpauthUrl: string }> {
    const confirmed = await db.mfaFactor.findFirst({
      where: { userId: user.id, kind: 'totp', confirmedAt: { not: null } },
      select: { id: true },
    });
    // Replacing a working factor must go through "remove" (which demands a fresh
    // re-authentication), otherwise a borrowed session could swap in its own app.
    if (confirmed !== null) {
      throw new ConflictError(
        'mfa_already_enabled',
        'An authenticator app is already set up. Remove it before adding another.',
      );
    }
    // Starting again makes any earlier unfinished attempt worthless.
    await this.retire(db, 'factor', { userId: user.id, kind: 'totp' }, user.id, 'setup_restarted');
    const secret = generateTotpSecret();
    await db.mfaFactor.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        kind: 'totp',
        label: 'Authenticator app',
        secretEncrypted: this.box.seal(secret, sealContext(user.id)),
      },
    });
    return {
      secret: base32Encode(secret),
      otpauthUrl: otpauthUrl({ secret, issuer: this.issuer, account: user.username }),
    };
  }

  /**
   * Step 2: the user types a code from the app. When it is right the factor becomes
   * active and fresh recovery codes are returned (the only time they are readable).
   * Undefined when the code is wrong or no setup is in progress.
   */
  async confirmTotpSetup(db: Db, user: UserRef, code: string): Promise<string[] | undefined> {
    const pending = await db.mfaFactor.findFirst({
      where: { userId: user.id, kind: 'totp', confirmedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (pending === null) return undefined;
    const secret = this.box.open(pending.secretEncrypted, sealContext(user.id));
    const step = matchTotp(secret, code, this.now());
    if (step === undefined) return undefined;
    // Conditional on still being unconfirmed, so two confirmations at the same moment
    // cannot both succeed and issue two sets of recovery codes.
    const claimed = await db.mfaFactor.updateMany({
      where: { id: pending.id, confirmedAt: null },
      data: { confirmedAt: new Date(this.now()), lastUsedStep: BigInt(step) },
    });
    if (claimed.count !== 1) return undefined;

    await this.retire(db, 'recovery', { userId: user.id }, user.id, 'regenerated');
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    await db.mfaRecoveryCode.createMany({
      data: codes.map((c) => ({
        tenantId: user.tenantId,
        userId: user.id,
        codeHash: this.hashCode(recoveryScope(user.id), normaliseRecoveryCode(c)),
      })),
    });
    return codes;
  }

  /**
   * Checks a second-factor code: six digits from the app, or a recovery code. A code
   * that is accepted is used up in the same statement that accepts it.
   */
  async verifyCode(db: Db, userId: string, code: string): Promise<boolean> {
    const trimmed = code.trim();
    if (/^\d{6}$/.test(trimmed)) return this.verifyTotp(db, userId, trimmed);
    return this.useRecoveryCode(db, userId, trimmed);
  }

  private async verifyTotp(db: Db, userId: string, code: string): Promise<boolean> {
    const factor = await db.mfaFactor.findFirst({
      where: { userId, kind: 'totp', confirmedAt: { not: null } },
    });
    if (factor === null) return false;
    const step = matchTotp(
      this.box.open(factor.secretEncrypted, sealContext(userId)),
      code,
      this.now(),
    );
    if (step === undefined) return false;
    // Replay protection. The update only matches while the stored period is older than
    // this code's period, so the same code (or an older one) is refused, and of two
    // requests presenting one code at the same moment exactly one wins.
    const accepted = await db.mfaFactor.updateMany({
      where: {
        id: factor.id,
        OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: BigInt(step) } }],
      },
      data: { lastUsedStep: BigInt(step) },
    });
    return accepted.count === 1;
  }

  private async useRecoveryCode(db: Db, userId: string, code: string): Promise<boolean> {
    const normalised = normaliseRecoveryCode(code);
    if (normalised.length !== RECOVERY_CODE_LENGTH) return false;
    // Recovery codes only mean something while an authenticator app is set up.
    if (!(await this.state(db, userId)).enabled) return false;
    // "Unused" is part of the condition, so one code can never be spent twice.
    const used = await db.mfaRecoveryCode.updateMany({
      where: { userId, codeHash: this.hashCode(recoveryScope(userId), normalised), usedAt: null },
      data: { usedAt: new Date(this.now()) },
    });
    return used.count === 1;
  }

  /** Removes the authenticator app and its recovery codes. False when there was none. */
  async disableTotp(db: Db, userId: string): Promise<boolean> {
    const removed = await this.retire(
      db,
      'factor',
      { userId, kind: 'totp' },
      userId,
      'removed_by_user',
    );
    await this.retire(db, 'recovery', { userId }, userId, 'factor_removed');
    return removed > 0;
  }

  /** Soft-deletes factors or recovery codes (rows are never physically deleted). */
  private async retire(
    db: Db,
    what: 'factor' | 'recovery',
    where: { userId: string; kind?: string },
    deletedBy: string,
    deleteReason: string,
  ): Promise<number> {
    const data = { deletedAt: new Date(this.now()), deletedBy, deleteReason };
    const result =
      what === 'factor'
        ? await db.mfaFactor.updateMany({ where, data })
        : await db.mfaRecoveryCode.updateMany({ where: { userId: where.userId }, data });
    return result.count;
  }
}

/** What a TOTP seed is bound to when encrypted: it only opens for the same user. */
function sealContext(userId: string): string {
  return `mfa_factor:${userId}`;
}

function recoveryScope(userId: string): string {
  return `recovery:${userId}`;
}

/** A recovery code as shown to the user: XXXXX-XXXXX. */
function newRecoveryCode(): string {
  let raw = '';
  for (let i = 0; i < RECOVERY_CODE_LENGTH; i += 1) {
    // randomInt is uniform, so no symbol is more likely than another.
    raw += RECOVERY_ALPHABET.charAt(randomInt(RECOVERY_ALPHABET.length));
  }
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/** Forgives case, spaces and the dash, so a code copied from paper still matches. */
function normaliseRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
