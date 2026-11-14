/**
 * Command line entry for the Playwright test users (`pnpm db:seed:e2e`). Development and CI
 * only; refuses to run in production. See ./e2e-seed.ts for what it creates.
 * Depends on: ./e2e-seed.ts, kernel/db/pool.ts. Used by: the `db:seed:e2e` package script.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createPool } from '../kernel/db/pool.js';
import { E2E_DEFAULT_PASSWORD, runE2eSeed } from './e2e-seed.js';

const rootEnv = path.resolve(import.meta.dirname, '../../../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('The e2e seed is for development and CI only.');
  }
  const url = process.env.DATABASE_URL_OWNER;
  if (!url) throw new Error('DATABASE_URL_OWNER is not set (see .env.example).');
  const pool = createPool(url, 2);
  try {
    await runE2eSeed(pool, process.env.E2E_PASSWORD ?? E2E_DEFAULT_PASSWORD);
    console.log('E2E users ready: e2e.admin, e2e.viewer.');
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
