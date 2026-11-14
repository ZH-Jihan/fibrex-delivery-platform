/**
 * Party vault: encryption, keyed hashing and masking of sensitive party values.
 *
 * Purpose: QID, passport, visa numbers and IBANs are personal and financial data. They are
 * never stored or logged in plain text:
 *   - `seal` / `open`  AES-256-GCM through SecretBox, for the rare moment a person with the
 *                      "reveal" permission needs the real value (and that is audited);
 *   - `hash`           HMAC-SHA256 with a key derived from DATA_ENCRYPTION_KEY and the
 *                      tenant, for exact lookup and for the database rule that one
 *                      identifier cannot belong to two parties at once. The same value in
 *                      two tenants gives two different hashes;
 *   - `mask`           what lists and screens show (only the last four characters).
 * Identifier types that are only platform rider ids (Falcon, Talabat ...) are not
 * sensitive: their value is also kept in plain text so staff can search and read them.
 *
 * Depends on: kernel/crypto/secret-box.ts. Used by: ./identifier-router.ts,
 * ./bank-account-router.ts.
 */
import { createHmac } from 'node:crypto';
import type { SecretBox } from '../../kernel/crypto/secret-box.js';

/** Identifier types that are plain platform ids (not personal documents). */
export const PLAIN_IDENTIFIER_TYPES: ReadonlySet<string> = new Set([
  'falcon_id',
  'snoonu_id',
  'talabat_id',
  'keeta_id',
]);

export function isSensitiveIdentifierType(type: string): boolean {
  return !PLAIN_IDENTIFIER_TYPES.has(type);
}

/** Spaces and dashes are formatting, letters are case-insensitive: "ab-12 3" = "AB123". */
export function normaliseSecretValue(value: string): string {
  return value.replace(/[\s-]+/g, '').toUpperCase();
}

/** "QA58DOHB00001234567890ABCDEFG" -> "*************************DEFG". */
export function maskValue(normalised: string): string {
  if (normalised.length <= 4) return '*'.repeat(normalised.length);
  return `${'*'.repeat(normalised.length - 4)}${normalised.slice(-4)}`;
}

export type SecretContext = 'party.identifier' | 'party.bank_account';

export class PartyVault {
  private readonly hashKey: Buffer;
  private readonly box: SecretBox;

  constructor(box: SecretBox, dataKeyBase64: string) {
    this.box = box;
    // A separate key for hashing, so the encryption key itself is never used as an HMAC key.
    this.hashKey = createHmac('sha256', Buffer.from(dataKeyBase64, 'base64'))
      .update('fibrex-party-hash-v1')
      .digest();
  }

  /** Keyed hash of an already normalised value. `scope` separates uses (type, bank). */
  hash(tenantId: string, scope: string, normalised: string): string {
    return createHmac('sha256', this.hashKey)
      .update(`${tenantId}|${scope}|${normalised}`)
      .digest('hex');
  }

  seal(normalised: string, context: SecretContext): Buffer<ArrayBuffer> {
    return this.box.seal(Buffer.from(normalised, 'utf8'), context);
  }

  open(sealed: Uint8Array, context: SecretContext): string {
    return this.box.open(sealed, context).toString('utf8');
  }
}
