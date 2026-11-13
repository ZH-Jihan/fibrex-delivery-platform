/**
 * PostgreSQL connection pool.
 *
 * Purpose: one pg Pool per process, connected as the restricted `fibrex_app` role
 * (DATABASE_URL). The Prisma driver adapter (commit 5) and readiness checks share it, so the
 * process opens a single, bounded set of connections.
 *
 * Every connection's session time zone is UTC, so timestamps are always stored and compared
 * in UTC (SPEC 1, "store timestamps in UTC").
 *
 * Depends on: pg. Used by: src/main.ts, kernel/http/health.ts checks, kernel/db (commit 5).
 */
import pg from 'pg';

export type Pool = pg.Pool;

export function createPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'fibrex-api',
    options: '-c TimeZone=UTC',
  });
}
