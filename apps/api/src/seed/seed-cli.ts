/**
 * Command line entry for the development seed (`pnpm db:seed`).
 *
 * Purpose: reads the root `.env`, connects as the owner role (DATABASE_URL_OWNER), and runs
 * `runSeed`. The Super Admin password comes from SEED_SUPERADMIN_PASSWORD in `.env`; when it
 * is missing a random one is generated and appended to `.env` (git-ignored) so the person
 * running the seed can find it. The password is never printed or committed.
 *
 * Refuses to run when NODE_ENV is production (the seed is for development and CI only).
 *
 * Depends on: ./seed.ts, kernel/db/pool.ts. Depended on by: the `db:seed` package script.
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createPool } from '../kernel/db/pool.js';
import { runSeed } from './seed.js';

const rootEnv = path.resolve(import.meta.dirname, '../../../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('The seed is for development and CI only; it will not run in production.');
  }
  const url = process.env.DATABASE_URL_OWNER;
  if (!url) throw new Error('DATABASE_URL_OWNER is not set (see .env.example).');

  let password = process.env.SEED_SUPERADMIN_PASSWORD;
  let generated = false;
  if (!password) {
    // 24 random bytes in base64url: long enough for the password policy, no ambiguous symbols.
    password = randomBytes(24).toString('base64url');
    generated = true;
  }

  const pool = createPool(url, 2);
  try {
    const result = await runSeed(pool, { superAdminPassword: password });
    if (generated && result.superAdminCreated) {
      if (!existsSync(rootEnv)) throw new Error('No .env to store the generated password in.');
      appendFileSync(
        rootEnv,
        `\n# Written by pnpm db:seed\nSEED_SUPERADMIN_PASSWORD=${password}\n`,
      );
      console.log('Super Admin created (username: superadmin). Password saved in .env.');
    } else if (result.superAdminCreated) {
      console.log('Super Admin created (username: superadmin) with SEED_SUPERADMIN_PASSWORD.');
    } else {
      console.log('Seed is up to date. Super Admin already existed; its password is unchanged.');
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
