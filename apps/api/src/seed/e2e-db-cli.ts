/**
 * Creates, migrates and seeds the isolated e2e database (`pnpm db:e2e`). Development and CI only.
 * Depends on: ./e2e-db.ts. Used by: the `db:e2e` package script.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { prepareE2eDatabase } from './e2e-db.js';

const rootEnv = path.resolve(import.meta.dirname, '../../../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

prepareE2eDatabase()
  .then((u) => {
    console.log(`E2E database ${u.database} is ready.`);
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
