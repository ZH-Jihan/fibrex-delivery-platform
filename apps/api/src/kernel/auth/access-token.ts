/**
 * Access tokens (PLAN 8.6: access JWT, 15 minutes, held in memory by the web app).
 *
 * Purpose: issue and check the short-lived signed token that proves who is calling. It is
 * a standard JWT signed with HMAC-SHA256, built with Node's crypto so there is no
 * third-party token library to keep patched.
 *
 * What the token says (claims):
 *   sub    user id                    tid  tenant id
 *   sid    session id                 cid  company the session is working in (optional)
 *   roles  role keys in that company  pwd  true while the user must change the password
 *   iat / exp  issued at / expires at (seconds)
 *
 * Checks on verify, in order, and why:
 *   1. exactly three parts, and the header must be the one fixed header this service
 *      writes. This refuses "alg: none" and any other algorithm an attacker might name.
 *   2. signature, compared in constant time.
 *   3. only then is the payload parsed and validated (never trust unsigned content).
 *   4. expiry.
 *
 * Roles and company are copied into the token when it is issued, so a change to a user's
 * roles takes effect at the next refresh (at most the token lifetime). Revoking a session
 * takes effect at once through the revocation list (kernel/auth/authenticate.ts).
 *
 * Depends on: node:crypto, zod. Used by: kernel/auth/auth-service.ts, authenticate.ts.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
const ISSUER = 'fibrex';

const claimsSchema = z.object({
  iss: z.literal(ISSUER),
  sub: z.uuid(),
  tid: z.uuid(),
  sid: z.uuid(),
  cid: z.uuid().optional(),
  roles: z.array(z.string().max(64)).max(50),
  pwd: z.literal(true).optional(),
  iat: z.number().int(),
  exp: z.number().int(),
});

export type AccessClaims = z.infer<typeof claimsSchema>;

export interface AccessTokenInput {
  userId: string;
  tenantId: string;
  sessionId: string;
  companyId: string | undefined;
  roleKeys: readonly string[];
  mustChangePassword: boolean;
}

export class AccessTokens {
  private readonly key: Buffer;
  private readonly ttlSeconds: number;
  private readonly now: () => number;

  constructor(secret: string, ttlSeconds: number, now: () => number = Date.now) {
    // A key derived for this one purpose, so the same secret can key other things
    // (one-time code hashes) without the two uses ever sharing a key.
    this.key = createHmac('sha256', secret).update('fibrex:access-token:v1').digest();
    this.ttlSeconds = ttlSeconds;
    this.now = now;
  }

  get lifetimeSeconds(): number {
    return this.ttlSeconds;
  }

  private sign(data: string): Buffer {
    return createHmac('sha256', this.key).update(data).digest();
  }

  issue(input: AccessTokenInput): string {
    const iat = Math.floor(this.now() / 1000);
    const claims: AccessClaims = {
      iss: ISSUER,
      sub: input.userId,
      tid: input.tenantId,
      sid: input.sessionId,
      ...(input.companyId === undefined ? {} : { cid: input.companyId }),
      roles: [...input.roleKeys],
      ...(input.mustChangePassword ? { pwd: true as const } : {}),
      iat,
      exp: iat + this.ttlSeconds,
    };
    const body = `${HEADER}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
    return `${body}.${this.sign(body).toString('base64url')}`;
  }

  /** The claims of a valid, unexpired token; undefined for anything else. */
  verify(token: string): AccessClaims | undefined {
    const parts = token.split('.');
    if (parts.length !== 3) return undefined;
    const [header, payload, signature] = parts as [string, string, string];
    if (header !== HEADER) return undefined;
    const expected = this.sign(`${header}.${payload}`);
    const given = Buffer.from(signature, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
    let json: unknown;
    try {
      json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return undefined;
    }
    const parsed = claimsSchema.safeParse(json);
    if (!parsed.success) return undefined;
    if (parsed.data.exp * 1000 <= this.now()) return undefined;
    return parsed.data;
  }
}
