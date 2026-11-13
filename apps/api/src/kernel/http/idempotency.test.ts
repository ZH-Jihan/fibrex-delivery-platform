import { describe, expect, it } from 'vitest';
import { canonicalJson, requestFingerprint } from './idempotency.js';

describe('canonicalJson', () => {
  it('sorts object keys at every level and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,1]},"b":1}',
    );
  });

  it('drops undefined members like JSON.stringify does', () => {
    expect(canonicalJson({ a: undefined, b: 2 })).toBe('{"b":2}');
  });
});

describe('requestFingerprint', () => {
  it('is the same for the same request regardless of key order', () => {
    expect(requestFingerprint('POST', '/api/v1/loans', { amount: '100', purpose: 'x' })).toBe(
      requestFingerprint('POST', '/api/v1/loans', { purpose: 'x', amount: '100' }),
    );
  });

  it('differs when method, path or body differ', () => {
    const a = requestFingerprint('POST', '/api/v1/loans', { amount: '100' });
    expect(requestFingerprint('PUT', '/api/v1/loans', { amount: '100' })).not.toBe(a);
    expect(requestFingerprint('POST', '/api/v1/payments', { amount: '100' })).not.toBe(a);
    expect(requestFingerprint('POST', '/api/v1/loans', { amount: '101' })).not.toBe(a);
  });
});
