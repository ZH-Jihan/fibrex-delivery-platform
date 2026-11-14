import { describe, expect, it } from 'vitest';
import { SecretBox, SecretBoxError } from '../crypto/secret-box.js';
import { base32Encode, matchTotp, otpauthUrl, totpCode, totpStep } from './totp.js';

// RFC 6238 appendix B test secret (SHA-1): the ASCII text below.
const SECRET = Buffer.from('12345678901234567890');

describe('totp', () => {
  it('matches the RFC 6238 test vectors (last six digits)', () => {
    const vectors: [number, string][] = [
      [59, '287082'],
      [1111111109, '081804'],
      [1111111111, '050471'],
      [1234567890, '005924'],
      [2000000000, '279037'],
    ];
    for (const [seconds, code] of vectors) {
      expect(totpCode(SECRET, totpStep(seconds * 1000))).toBe(code);
    }
  });

  it('accepts the current period and one either side, and reports which matched', () => {
    const now = 1_700_000_000_000;
    const step = totpStep(now);
    expect(matchTotp(SECRET, totpCode(SECRET, step), now)).toBe(step);
    expect(matchTotp(SECRET, totpCode(SECRET, step - 1), now)).toBe(step - 1);
    expect(matchTotp(SECRET, totpCode(SECRET, step + 1), now)).toBe(step + 1);
    expect(matchTotp(SECRET, totpCode(SECRET, step + 2), now)).toBeUndefined();
    expect(matchTotp(SECRET, totpCode(SECRET, step - 2), now)).toBeUndefined();
  });

  it('refuses anything that is not six digits', () => {
    const now = 1_700_000_000_000;
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 456']) {
      expect(matchTotp(SECRET, bad, now)).toBeUndefined();
    }
  });

  it('encodes base32 as authenticator apps expect', () => {
    expect(base32Encode(SECRET)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Encode(Buffer.from('f'))).toBe('MY');
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
  });

  it('builds the otpauth link with issuer and account', () => {
    const url = otpauthUrl({ secret: SECRET, issuer: 'Fibrex Test', account: 'alice' });
    expect(url).toMatch(/^otpauth:\/\/totp\/Fibrex%20Test:alice\?/);
    expect(url).toContain('secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(url).toContain('digits=6');
    expect(url).toContain('period=30');
  });
});

describe('secret box', () => {
  const box = new SecretBox(Buffer.alloc(32, 7).toString('base64'));

  it('round-trips, and never stores the plaintext', () => {
    const sealed = box.seal(SECRET, 'mfa_factor:u1');
    expect(sealed.includes(SECRET)).toBe(false);
    expect(box.open(sealed, 'mfa_factor:u1').equals(SECRET)).toBe(true);
  });

  it('uses a fresh nonce: the same secret seals differently each time', () => {
    expect(box.seal(SECRET, 'c').equals(box.seal(SECRET, 'c'))).toBe(false);
  });

  it('refuses another context, another key, and altered data', () => {
    const sealed = box.seal(SECRET, 'mfa_factor:u1');
    expect(() => box.open(sealed, 'mfa_factor:u2')).toThrow(SecretBoxError);
    const other = new SecretBox(Buffer.alloc(32, 8).toString('base64'));
    expect(() => other.open(sealed, 'mfa_factor:u1')).toThrow(SecretBoxError);
    const altered = Buffer.from(sealed);
    altered[altered.length - 1] = (altered[altered.length - 1] ?? 0) ^ 1;
    expect(() => box.open(altered, 'mfa_factor:u1')).toThrow(SecretBoxError);
    expect(() => box.open(Buffer.alloc(5), 'mfa_factor:u1')).toThrow(SecretBoxError);
  });

  it('refuses a key that is not 32 bytes', () => {
    expect(() => new SecretBox(Buffer.alloc(16).toString('base64'))).toThrow(SecretBoxError);
  });
});
