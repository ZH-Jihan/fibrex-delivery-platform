/**
 * Separate database for the Playwright journeys (`fibrex_e2e`), so browser tests never write
 * into the development database. Development and CI only.
 *
 * Purpose: derive the e2e connection URLs from the development ones (same server and roles,
 * different database name), create the database when missing (owner, grants and extensions
 * as in infra/docker/postgres/init/01-roles.sh), apply every migration, and seed the demo
 * tenant plus the two e2e users into it. Idempotent: safe to run before every e2e run.
 * Depends on: pg, the Prisma CLI, ./seed.ts, ./e2e-seed.ts. Used by: e2e-serve-cli.ts, e2e-db-cli.ts.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createPool } from '../kernel/db/pool.js';
import { E2E_DEFAULT_PASSWORD, runE2eSeed } from './e2e-seed.js';
import { runSeed } from './seed.js';

const apiDir = path.resolve(import.meta.dirname, '../..');

/** Same connection string with another database name. */
export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

export interface E2eUrls {
  database: string;
  owner: string;
  app: string;
}

export function e2eUrls(env: NodeJS.ProcessEnv = process.env): E2eUrls {
  const database = env.E2E_DB_NAME ?? 'fibrex_e2e';
  const owner = env.DATABASE_URL_OWNER;
  const app = env.DATABASE_URL;
  if (!owner || !app) throw new Error('DATABASE_URL_OWNER and DATABASE_URL must be set.');
  return { database, owner: withDatabase(owner, database), app: withDatabase(app, database) };
}

/** Creates the database (if missing) with the same ownership and grants as the dev one. */
async function ensureDatabase(env: NodeJS.ProcessEnv, urls: E2eUrls): Promise<void> {
  const base = new URL(env.DATABASE_URL_OWNER ?? '');
  const superUrl = (database: string) =>
    `postgresql://${encodeURIComponent(env.POSTGRES_USER ?? 'postgres')}:${encodeURIComponent(
      env.POSTGRES_PASSWORD ?? '',
    )}@${base.host}/${database}`;
  const quoted = `"${urls.database.replace(/"/g, '""')}"`;

  const admin = new pg.Client({ connectionString: superUrl('postgres') });
  await admin.connect();
  try {
    const found = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      urls.database,
    ]);
    if (found.rowCount === 0) {
      await admin.query(`CREATE DATABASE ${quoted} OWNER fibrex_owner`);
      await admin.query(`REVOKE ALL ON DATABASE ${quoted} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT, TEMPORARY ON DATABASE ${quoted} TO fibrex_app`);
      await admin.query(`GRANT CONNECT ON DATABASE ${quoted} TO fibrex_bi`);
      const inside = new pg.Client({ connectionString: superUrl(urls.database) });
      await inside.connect();
      try {
        await inside.query('ALTER SCHEMA public OWNER TO fibrex_owner');
        await inside.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
        for (const ext of ['pg_trgm', 'btree_gist', 'pgcrypto']) {
          await inside.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
        }
      } finally {
        await inside.end();
      }
    }
  } finally {
    await admin.end();
  }
}

/** Creates, migrates and seeds the e2e database. Returns its URLs. */
export async function prepareE2eDatabase(env: NodeJS.ProcessEnv = process.env): Promise<E2eUrls> {
  if (env.NODE_ENV === 'production')
    throw new Error('The e2e database is for development and CI only.');
  const urls = e2eUrls(env);
  await ensureDatabase(env, urls);

  execFileSync(
    process.execPath,
    [path.join(apiDir, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
    {
      cwd: apiDir,
      env: {
        ...env,
        DATABASE_URL_OWNER: urls.owner,
        PRISMA_HIDE_UPDATE_MESSAGE: '1',
        CHECKPOINT_DISABLE: '1',
      },
      stdio: 'pipe',
    },
  );

  const pool = createPool(urls.owner, 2);
  try {
    // The Super Admin password is never used by the journeys; any policy-valid value will do.
    await runSeed(pool, {
      superAdminPassword: env.SEED_SUPERADMIN_PASSWORD ?? E2E_DEFAULT_PASSWORD,
    });
    await runE2eSeed(pool, env.E2E_PASSWORD ?? E2E_DEFAULT_PASSWORD);
  } finally {
    await pool.end();
  }
  return urls;
}
