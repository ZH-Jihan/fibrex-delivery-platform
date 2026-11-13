import { describe, expect, it } from 'vitest';
import {
  callerKey,
  currentContext,
  requireContext,
  runWithContext,
  type RequestContext,
} from './request-context.js';

const ctx = (over: Partial<RequestContext> = {}): RequestContext => ({
  requestId: 'r1',
  startedAt: 0,
  ip: '10.1.2.3',
  principal: undefined,
  companyIds: [],
  ...over,
});

describe('request context', () => {
  it('is visible inside async work started within the request and nowhere else', async () => {
    expect(currentContext()).toBeUndefined();
    await runWithContext(ctx(), async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(requireContext().requestId).toBe('r1');
    });
    expect(() => requireContext()).toThrow(/outside a request/);
  });

  it('keeps concurrent requests apart', async () => {
    const seen: string[] = [];
    await Promise.all(
      ['a', 'b', 'c'].map((id, i) =>
        runWithContext(ctx({ requestId: id }), async () => {
          await new Promise((r) => setTimeout(r, 5 - i));
          seen.push(`${id}:${requireContext().requestId}`);
        }),
      ),
    );
    expect(seen.sort()).toEqual(['a:a', 'b:b', 'c:c']);
  });

  it('derives the caller key from the principal, falling back to the address', () => {
    expect(callerKey(ctx())).toBe('ip:10.1.2.3');
    expect(callerKey(ctx({ principal: { kind: 'user', userId: 'u1', tenantId: 't1' } }))).toBe(
      'user:t1:u1',
    );
    expect(
      callerKey(ctx({ principal: { kind: 'api_client', apiClientId: 'c1', tenantId: 't1' } })),
    ).toBe('client:t1:c1');
  });
});
