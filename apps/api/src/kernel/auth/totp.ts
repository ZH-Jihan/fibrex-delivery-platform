/**
 * Time-based one-time passwords (TOTP, RFC 6238) for authenticator apps.
 *
 * Purpose: the arithmetic behind the six-digit codes, with no database or state. Uses the
 * settings every authenticator app supports: HMAC-SHA1, 6 digits, a new code every 30
 * seconds. Built on Node's crypto so there is no third-party library to keep patched.
 *
 * How a code is made (RFC 4226 section 5.3):
 *   1. step = whole 30-second periods since 1970.
 *   2. HMAC-SHA1(secret, step as 8 bytes, big-endian).
 *   3. "Dynamic truncation": the low 4 bits of the last byte pick 4 bytes of the HMAC;
 *      their low 31 bits, modulo 1,000,000, are the code.
 *
 * Clock drift: a code from one period before or after "now" is accepted, because phones
 * and servers are rarely on the same second. The caller receives the period that
 * matched and must refuse a period it has already accepted (replay protection lives in
 * kernel/auth/mfa.ts, because it needs the database).
 *
 * Depends on: node:crypto. Used by: kernel/auth/mfa.ts.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Periods accepted on each side of the current one. */
const DRIFT_STEPS = 1;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** A new 160-bit secret, the size RFC 4226 recommends. */
export function generateTotpSecret(): Buffer {
  return randomBytes(20);
}

/** RFC 4648 base32 without padding: the form authenticator apps expect. */
export function base32Encode(data: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
    // Keep only the bits not yet written, so `value` never grows past a few bits.
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32.charAt((value << (5 - bits)) & 31);
  return out;
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

/** The code for one period. */
export function totpCode(secret: Uint8Array, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', secret).update(counter).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/**
 * The period a code belongs to, when it is valid now (allowing for drift); undefined
 * otherwise. Every candidate is compared in constant time and the loop never stops
 * early, so the time taken says nothing about which period nearly matched.
 */
export function matchTotp(secret: Uint8Array, code: string, nowMs: number): number | undefined {
  if (!/^\d{6}$/.test(code)) return undefined;
  const given = Buffer.from(code);
  const current = totpStep(nowMs);
  let matched: number | undefined;
  for (let step = current - DRIFT_STEPS; step <= current + DRIFT_STEPS; step += 1) {
    if (timingSafeEqual(given, Buffer.from(totpCode(secret, step)))) matched = step;
  }
  return matched;
}

/** The otpauth:// link an authenticator app reads from the QR code. */
export function otpauthUrl(input: { secret: Uint8Array; issuer: string; account: string }): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
  const params = new URLSearchParams({
    secret: base32Encode(input.secret),
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
