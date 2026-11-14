import { describe, expect, it } from 'vitest';
import { AccessTokens } from './access-token.js';
import { hashPassword, verifyPassword } from './password-hasher.js';

const input = {
  userId: '018f3c1e-0000-7000-8000-000000000001',
  tenantId: '018f3c1e-0000-7000-8000-000000000002',
  sessionId: '018f3c1e-0000-7000-8000-000000000003',
  companyId: '018f3c1e-0000-7000-8000-000000000004',
  roleKeys: ['admin'],
  mustChangePassword: false,
};
const SECRET = 'unit-test-token-secret-0123456789abcdef';

describe('password hasher', () => {
  it('stores an Argon2id PHC string and verifies only the right password', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(hash).not.toContain('correct horse');
    expect(await verifyPassword(hash, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse batterx')).toBe(false);
  });

  it('salts: the same password hashes differently each time', async () => {
    expect(await hashPassword('same-password-123')).not.toBe(
      await hashPassword('same-password-123'),
    );
  });

  it('never matches a malformed or oversized stored value', async () => {
    expect(await verifyPassword('', 'x')).toBe(false);
    expect(await verifyPassword('plain-text-password', 'plain-text-password')).toBe(false);
    expect(
      await verifyPassword(
        '$argon2id$v=19$m=9999999,t=2,p=1$c2FsdHNhbHRzYWx0$' + 'A'.repeat(43),
        'x',
      ),
    ).toBe(false);
  });
});

describe('access tokens', () => {
  it('round-trips the claims', () => {
    const tokens = new AccessTokens(SECRET, 900);
    const claims = tokens.verify(tokens.issue(input));
    expect(claims).toMatchObject({
      sub: input.userId,
      tid: input.tenantId,
      sid: input.sessionId,
      cid: input.companyId,
      roles: ['admin'],
    });
    expect(claims?.pwd).toBeUndefined();
    expect(tokens.verify(tokens.issue({ ...input, mustChangePassword: true }))?.pwd).toBe(true);
  });

  it('rejects an expired token', () => {
    let now = 1_800_000_000_000;
    const tokens = new AccessTokens(SECRET, 900, () => now);
    const token = tokens.issue(input);
    now += 899_000;
    expect(tokens.verify(token)).toBeDefined();
    now += 1_000;
    expect(tokens.verify(token)).toBeUndefined();
  });

  it('rejects a changed payload, another secret, and "alg: none"', () => {
    const tokens = new AccessTokens(SECRET, 900);
    const [header, payload, signature] = tokens.issue(input).split('.') as [string, string, string];
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    const forged = Buffer.from(JSON.stringify({ ...claims, roles: ['super_admin'] })).toString(
      'base64url',
    );
    expect(tokens.verify(`${header}.${forged}.${signature}`)).toBeUndefined();
    expect(
      new AccessTokens(`${SECRET}x`, 900).verify(`${header}.${payload}.${signature}`),
    ).toBeUndefined();
    const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    expect(tokens.verify(`${none}.${payload}.`)).toBeUndefined();
    expect(tokens.verify(`${none}.${payload}.${signature}`)).toBeUndefined();
    expect(tokens.verify('not-a-token')).toBeUndefined();
  });
});
