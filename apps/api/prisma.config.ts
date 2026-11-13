/**
 * Prisma CLI configuration (Prisma 7).
 *
 * Purpose: tells the Prisma CLI where the schema and the hand-written SQL migrations live,
 * and which database to migrate. Migrations always run as the owner role
 * (DATABASE_URL_OWNER); the running API uses the restricted fibrex_app role (DATABASE_URL).
 *
 * Local development reads the repository-root .env. CI and the integration tests set
 * DATABASE_URL_OWNER themselves, and an existing variable is never overwritten.
 *
 * Depends on: the `prisma` CLI. Used by: `pnpm db:migrate`, `pnpm db:generate`, tests.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'prisma/config';

const rootEnv = path.resolve(import.meta.dirname, '../../.env');
if (process.env.DATABASE_URL_OWNER === undefined && existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
}

export default defineConfig({
  schema: 'prisma/schema',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url: process.env.DATABASE_URL_OWNER ?? '',
  },
});
