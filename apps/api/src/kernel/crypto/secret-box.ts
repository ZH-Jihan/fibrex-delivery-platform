/**
 * Secret box: encrypts small secrets before they are stored in the database.
 *
 * Purpose: some values must be readable again by the server (a TOTP seed, later an SSO
 * client secret), so they cannot be hashed like a password. They are encrypted with
 * AES-256-GCM under DATA_ENCRYPTION_KEY, so a copy of the database alone does not reveal
 * them.
 *
 * Stored layout (one bytea column):
 *   byte 0        format version (1), so the scheme can change without guessing
 *   bytes 1-12    random nonce, new for every encryption
 *   bytes 13-28   authentication tag
 *   bytes 29-     ciphertext
 *
 * The "context" (for example "mfa_factor:<user id>") is authenticated but not stored. A
 * ciphertext copied onto another user's row therefore fails to decrypt, instead of
 * quietly giving that user someone else's secret.
 *
 * Depends on: node:crypto. Used by: kernel/auth/mfa.ts.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + NONCE_BYTES + TAG_BYTES;

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretBoxError';
  }
}

export class SecretBox {
  private readonly key: Buffer;

  /** `keyBase64` is DATA_ENCRYPTION_KEY: exactly 32 random bytes in base64. */
  constructor(keyBase64: string) {
    const key = Buffer.from(keyBase64, 'base64');
    if (key.length !== 32) throw new SecretBoxError('The encryption key must be 32 bytes');
    this.key = key;
  }

  seal(plaintext: Uint8Array, context: string): Buffer<ArrayBuffer> {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([Buffer.from([VERSION]), nonce, cipher.getAuthTag(), ciphertext]);
  }

  /** Throws SecretBoxError when the data was altered, or sealed for another context or key. */
  open(sealed: Uint8Array, context: string): Buffer {
    const data = Buffer.from(sealed);
    if (data.length < HEADER_BYTES || data[0] !== VERSION) {
      throw new SecretBoxError('Unrecognised encrypted value');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(1, 1 + NONCE_BYTES), {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(data.subarray(1 + NONCE_BYTES, HEADER_BYTES));
    try {
      return Buffer.concat([decipher.update(data.subarray(HEADER_BYTES)), decipher.final()]);
    } catch {
      throw new SecretBoxError('The encrypted value could not be opened');
    }
  }
}
