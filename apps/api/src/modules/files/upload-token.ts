/**
 * Signed upload tokens.
 *
 * Purpose: file_object rows are immutable, so an upload in progress cannot be a row.
 * Instead POST /files/upload-url hands out a token that carries what was promised (name,
 * type, size, SHA-256, object key, who, when it expires), signed with HMAC-SHA256.
 * POST /files/complete accepts only a valid token, then checks the stored object against
 * those promises. Nobody can complete an upload for a key the server did not issue.
 *
 * Depends on: node:crypto. Used by: ./files-service.ts.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface UploadClaims {
  tenantId: string;
  companyId: string;
  userId: string | null;
  key: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  /** Expiry, seconds since the epoch. */
  exp: number;
}

function sign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(`fibrex-upload:${body}`).digest('base64url');
}

export function issueUploadToken(secret: string, claims: UploadClaims): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${body}.${sign(secret, body)}`;
}

/** Returns the claims, or null for a forged, damaged or expired token. */
export function readUploadToken(
  secret: string,
  token: string,
  nowSeconds: number,
): UploadClaims | null {
  const [body, signature, extra] = token.split('.');
  if (body === undefined || signature === undefined || extra !== undefined) return null;
  const expected = Buffer.from(sign(secret, body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as UploadClaims;
    return claims.exp > nowSeconds ? claims : null;
  } catch {
    return null;
  }
}
