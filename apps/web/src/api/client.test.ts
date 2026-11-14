// Tests for the API client: problem errors, idempotency keys, one shared refresh on 401.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { urlOf } from '../test/helpers';
import { api, ApiError, setAccessToken } from './client';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('api client', () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    setAccessToken('old');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setAccessToken(null);
  });

  it('turns a problem response into an ApiError with its code', async () => {
    fetchMock.mockResolvedValueOnce(json(409, { code: 'version_conflict', detail: 'Changed' }));
    const err = await api('/parties').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('version_conflict');
  });

  it('adds an idempotency key to writes outside /auth only', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json(200, {})));
    await api('/parties', { method: 'POST', body: {} });
    await api('/auth/logout', { method: 'POST' });
    const first = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    const second = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(first.get('Idempotency-Key')).toBeTruthy();
    expect(second.get('Idempotency-Key')).toBeNull();
  });

  it('refreshes once for two parallel 401s, then retries both', async () => {
    let refreshCalls = 0;
    fetchMock.mockImplementation((input, init) => {
      if (urlOf(input).endsWith('/auth/refresh')) {
        refreshCalls += 1;
        return Promise.resolve(json(200, { accessToken: 'new' }));
      }
      const auth = new Headers(init?.headers).get('Authorization');
      return Promise.resolve(auth === 'Bearer new' ? json(200, { ok: true }) : json(401, {}));
    });
    const results = await Promise.all([api('/me'), api('/me/sessions')]);
    expect(results).toHaveLength(2);
    expect(refreshCalls).toBe(1);
  });
});
