/**
 * API server entry point.
 *
 * Purpose: load configuration, connect to PostgreSQL and Redis, build the Express app and
 * listen. On SIGTERM/SIGINT it stops accepting connections, lets in-flight requests finish
 * (up to 10 seconds), then closes the database pool and Redis, so deploys do not cut
 * requests off (SPEC 6.6 zero-downtime rollout).
 *
 * Local development reads the repository-root .env (an existing variable is never
 * overwritten). Run with `pnpm --filter @fibrex/api dev`.
 *
 * Depends on: src/app.ts, kernel/config, kernel/db/pool.ts, kernel/redis/client.ts,
 * kernel/observability/logger.ts. Used by: the `dev` and `start` scripts.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createApp } from './app.js';
import { ConfigError, loadEnv } from './kernel/config/env.js';
import { createPool } from './kernel/db/pool.js';
import { createLogger } from './kernel/observability/logger.js';
import { createRedis } from './kernel/redis/client.js';

const rootEnv = path.resolve(import.meta.dirname, '../../../.env');
if (process.env.DATABASE_URL === undefined && existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
}

function main(): void {
  const env = loadEnv();
  const logger = createLogger({
    level: env.LOG_LEVEL,
    pretty: env.LOG_PRETTY,
    serviceName: env.OTEL_SERVICE_NAME,
  });
  const pool = createPool(env.DATABASE_URL);
  const redis = createRedis(env.REDIS_URL);

  const app = createApp({
    env,
    logger,
    redis,
    readinessChecks: [
      {
        name: 'database',
        check: async () => {
          await pool.query('SELECT 1');
        },
      },
      {
        name: 'redis',
        check: async () => {
          await redis.ping();
        },
      },
    ],
  });

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'Fibrex API listening');
  });

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      logger.error('forced exit after 10 s');
      process.exit(1);
    }, 10_000);
    force.unref();
    server.close(() => {
      void Promise.allSettled([pool.end(), redis.quit()]).then(() => {
        logger.info('shutdown complete');
        process.exit(0);
      });
    });
  };
  process.on('SIGTERM', () => {
    stop('SIGTERM');
  });
  process.on('SIGINT', () => {
    stop('SIGINT');
  });
}

try {
  main();
} catch (err) {
  // The logger may not exist yet (bad configuration), so write plainly to stderr.
  if (err instanceof ConfigError) {
    process.stderr.write(`${err.message}\n`);
  } else {
    process.stderr.write(
      `Fatal start-up error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
  }
  process.exit(1);
}
