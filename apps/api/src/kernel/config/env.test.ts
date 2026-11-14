import { describe, expect, it } from 'vitest';
import { ConfigError, loadEnv } from './env.js';

const base = {
  DATABASE_URL: 'postgresql://fibrex_app:secret-value@localhost:5433/fibrex',
  REDIS_URL: 'redis://:secret@localhost:6379/0',
  AUTH_TOKEN_SECRET: 'unit-test-token-secret-0123456789abcdef',
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
};

describe('loadEnv', () => {
  it('applies defaults', () => {
    const env = loadEnv(base);
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.CORS_ORIGINS).toEqual([]);
    expect(env.IDEMPOTENCY_TTL_SECONDS).toBe(86_400);
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
    expect(Object.isFrozen(env)).toBe(true);
  });

  it('treats an empty OTLP endpoint as tracing off', () => {
    expect(
      loadEnv({ ...base, OTEL_EXPORTER_OTLP_ENDPOINT: '' }).OTEL_EXPORTER_OTLP_ENDPOINT,
    ).toBeUndefined();
  });

  it('parses a comma-separated list of exact origins', () => {
    const env = loadEnv({ ...base, CORS_ORIGINS: 'http://localhost:5173, https://app.fibrex.qa' });
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:5173', 'https://app.fibrex.qa']);
  });

  it('rejects wildcards and paths in origins', () => {
    expect(() => loadEnv({ ...base, CORS_ORIGINS: '*' })).toThrow(ConfigError);
    expect(() => loadEnv({ ...base, CORS_ORIGINS: 'https://app.fibrex.qa/path' })).toThrow(
      ConfigError,
    );
  });

  it('requires https origins in production', () => {
    expect(() =>
      loadEnv({ ...base, NODE_ENV: 'production', CORS_ORIGINS: 'http://app.fibrex.qa' }),
    ).toThrow(/https/);
  });

  it('lists every problem at once and never echoes values', () => {
    try {
      loadEnv({ DATABASE_URL: 'mysql://user:topsecret@db/x', PORT: 'abc' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const problems = (err as ConfigError).problems;
      expect(problems.some((p) => p.startsWith('DATABASE_URL'))).toBe(true);
      expect(problems.some((p) => p.startsWith('REDIS_URL'))).toBe(true);
      expect(problems.some((p) => p.startsWith('PORT'))).toBe(true);
      expect((err as Error).message).not.toContain('topsecret');
    }
  });
});
