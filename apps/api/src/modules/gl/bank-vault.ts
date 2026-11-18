/**
 * Bank vault: encryption, keyed hashing and masking of the company's own bank account numbers.
 *
 * Purpose: an IBAN is financial data. It is never stored or logged in plain text:
 *   - `seal` / `open`  AES-256-GCM through the kernel SecretBox. The context names the
 *                      company, so a ciphertext copied to another company's row fails to
 *                      open. `open` has no HTTP route yet; payroll (phase 7) uses it to
 *                      write payment files;
 *   - `hash`           HMAC-SHA256 under a key derived from DATA_ENCRYPTION_KEY and the
 *                      tenant, used only to refuse the same account being added twice;
 *   - the mask (see `maskIban` in @fibrex/shared) is what lists and screens show.
 * The audit trigger redacts every column whose name contains "encrypted" or "hash", so the
 * number never reaches the audit log either.
 *
 * Depends on: kernel/crypto/secret-box.ts. Used by: ./bank-router.ts, src/main.ts.
 */
import { createHmac } from 'node:crypto';
import type { SecretBox } from '../../kernel/crypto/secret-box.js';

export class BankVault {
  private readonly hashKey: Buffer;
  private readonly box: SecretBox;

  constructor(box: SecretBox, dataKeyBase64: string) {
    this.box = box;
    // A separate key for hashing, so the encryption key itself is never used as an HMAC key.
    this.hashKey = createHmac('sha256', Buffer.from(dataKeyBase64, 'base64'))
      .update('fibrex-gl-bank-hash-v1')
      .digest();
  }

  /** Keyed hash of an already normalised IBAN (upper case, no spaces). */
  hash(tenantId: string, normalised: string): string {
    return createHmac('sha256', this.hashKey).update(`${tenantId}|${normalised}`).digest('hex');
  }

  seal(normalised: string, companyId: string): Buffer<ArrayBuffer> {
    return this.box.seal(Buffer.from(normalised, 'utf8'), `gl.company_bank_account:${companyId}`);
  }

  open(sealed: Uint8Array, companyId: string): string {
    return this.box.open(sealed, `gl.company_bank_account:${companyId}`).toString('utf8');
  }
}
