/**
 * Starts the API against the isolated e2e database (`pnpm --filter @fibrex/api e2e:serve`).
 * Purpose: Playwright must never touch the development database, so this prepares
 * `fibrex_e2e` (create, migrate, seed) and then runs the normal API with DATABASE_URL pointing
 * at it. Development and CI only. Depends on: ./e2e-db.ts, ../main.ts. Used by: playwright.config.ts.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { prepareE2eDatabase } from './e2e-db.js';

const rootEnv = path.resolve(import.meta.dirname, '../../../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const urls = await prepareE2eDatabase();
// Overrides go into the environment before main.ts reads it; main.ts keeps existing values.
process.env.DATABASE_URL = urls.app;
process.env.DATABASE_URL_OWNER = urls.owner;
// Queues share Redis with a running development API, whose workers would otherwise pick up
// this server's jobs (import commits, PDFs) and run them against the wrong database. Redis
// database 1 keeps the e2e queues apart.
if (process.env.REDIS_URL !== undefined) {
  process.env.REDIS_URL = `${process.env.REDIS_URL.replace(/\/\d*$/, '')}/1`;
}
process.env.PORT = process.env.E2E_API_PORT ?? '3100';
process.env.CORS_ORIGINS = process.env.E2E_WEB_ORIGIN ?? 'http://localhost:5174';
// Journeys sign in and reload constantly from one address; lift every limit for this server only.
process.env.AUTH_RATE_LIMIT = '1000';
process.env.RATE_LIMIT_ANONYMOUS = '100000';
process.env.RATE_LIMIT_AUTHENTICATED = '100000';
await import('../main.js');
