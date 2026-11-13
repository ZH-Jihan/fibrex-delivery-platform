/**
 * Environment configuration.
 *
 * Purpose: read every setting the API needs from environment variables once, validate it
 * with Zod, and expose a typed, frozen object. A misconfigured server must refuse to start
 * rather than run with a silent default (SPEC 6.3 "secrets only in environment variables").
 * Error messages name the variable and the problem but never echo the value, because
 * values can be secrets.
 *
 * Depends on: zod. Used by: src/main.ts, src/app.ts, tests.
 */
import { z } from 'zod';

const postgresUrl = z
  .string()
  .regex(/^postgres(ql)?:\/\/.+/, 'must be a postgres:// or postgresql:// URL');

const redisUrl = z.string().regex(/^rediss?:\/\/.+/, 'must be a redis:// or rediss:// URL');

/** True for "https://host[:port]" or "http://host[:port]" with no path, query or wildcard. */
function isExactOrigin(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === value;
  } catch {
    return false;
  }
}

/** Comma-separated list of exact origins, for example "https://app.fibrex.qa". No wildcards. */
const originList = z
  .string()
  .default('')
  .transform((raw, ctx) => {
    const origins = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    for (const origin of origins) {
      if (!isExactOrigin(origin)) {
        ctx.addIssue({
          code: 'custom',
          message: `"${origin}" is not an exact origin like https://app.example.com`,
        });
      }
    }
    return origins;
  });

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    DATABASE_URL: postgresUrl,
    REDIS_URL: redisUrl,
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    LOG_PRETTY: z
      .enum(['0', '1'])
      .default('0')
      .transform((v) => v === '1'),
    CORS_ORIGINS: originList,
    // Number of reverse proxies in front of the API, so req.ip is the real client address.
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
    BODY_LIMIT: z
      .string()
      .regex(/^\d+(kb|mb)$/, 'must look like 512kb or 1mb')
      .default('1mb'),
    RATE_LIMIT_WINDOW_SECONDS: positiveInt(60),
    RATE_LIMIT_ANONYMOUS: positiveInt(120),
    RATE_LIMIT_AUTHENTICATED: positiveInt(600),
    IDEMPOTENCY_TTL_SECONDS: positiveInt(24 * 60 * 60),
    IDEMPOTENCY_LOCK_SECONDS: positiveInt(60),
    // An empty value means "tracing off", the same as leaving the variable out.
    OTEL_EXPORTER_OTLP_ENDPOINT: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.url().optional(),
    ),
    OTEL_SERVICE_NAME: z.string().min(1).default('fibrex-api'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.CORS_ORIGINS.some((o) => o.startsWith('http:'))) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: 'production origins must use https',
      });
    }
  });

export type Env = Readonly<z.infer<typeof envSchema>>;

export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/**
 * Parses and validates the environment. Throws ConfigError listing every problem at once,
 * so an operator can fix them in one go.
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new ConfigError(problems);
  }
  return Object.freeze(result.data);
}
