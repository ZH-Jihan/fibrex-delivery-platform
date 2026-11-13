/**
 * Integration test database.
 *
 * Purpose: start a disposable Redis 7.4 container (for HTTP kernel tests) and a disposable
 * PostgreSQL 16 container that is built exactly like the
 * development database (same image, same role script in infra/docker/postgres/init), apply
 * every migration with `prisma migrate deploy` as the owner role, and hand the connection
 * details to the tests. Passwords are random per run; the container is removed afterwards.
 *
 * Depends on: Docker, @testcontainers/postgresql, the Prisma CLI, prisma/migrations.
 * Used by: every file in test/integration.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import type { TestProject } from 'vitest/node';

export interface TestDatabase {
  host: string;
  port: number;
  database: string;
  superUser: { user: string; password: string };
  owner: { user: string; password: string };
  app: { user: string; password: string };
  bi: { user: string; password: string };
}

declare module 'vitest' {
  export interface ProvidedContext {
    testDatabase: TestDatabase;
    /** redis:// URL of a throwaway Redis 7.4 (same image as docker-compose). */
    redisUrl: string;
  }
}

const apiDir = path.resolve(import.meta.dirname, '../..');
const repoRoot = path.resolve(apiDir, '../..');
const pw = () => randomBytes(18).toString('hex');

export function connectionUrl(db: TestDatabase, role: { user: string; password: string }): string {
  return `postgresql://${role.user}:${role.password}@${db.host}:${String(db.port)}/${db.database}`;
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const superPassword = pw();
  const ownerPassword = pw();
  const appPassword = pw();
  const biPassword = pw();

  const redisPassword = pw();
  const redisContainerPromise = new RedisContainer('redis:7.4.12-alpine')
    .withPassword(redisPassword)
    .start();

  const container = await new PostgreSqlContainer('postgres:16.16-alpine')
    .withDatabase('fibrex')
    .withUsername('postgres')
    .withPassword(superPassword)
    .withEnvironment({
      FIBREX_OWNER_PASSWORD: ownerPassword,
      FIBREX_APP_PASSWORD: appPassword,
      FIBREX_BI_PASSWORD: biPassword,
      TZ: 'UTC',
    })
    .withCopyDirectoriesToContainer([
      {
        source: path.join(repoRoot, 'infra/docker/postgres/init'),
        target: '/docker-entrypoint-initdb.d',
      },
    ])
    .start();

  const db: TestDatabase = {
    host: container.getHost(),
    port: container.getPort(),
    database: 'fibrex',
    superUser: { user: 'postgres', password: superPassword },
    owner: { user: 'fibrex_owner', password: ownerPassword },
    app: { user: 'fibrex_app', password: appPassword },
    bi: { user: 'fibrex_bi', password: biPassword },
  };

  // Apply migrations exactly as deployments do.
  execFileSync(
    process.execPath,
    [path.join(apiDir, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
    {
      cwd: apiDir,
      env: {
        ...process.env,
        DATABASE_URL_OWNER: connectionUrl(db, db.owner),
        PRISMA_HIDE_UPDATE_MESSAGE: '1',
        CHECKPOINT_DISABLE: '1',
      },
      stdio: 'pipe',
    },
  );

  project.provide('testDatabase', db);
  const redisContainer = await redisContainerPromise;
  project.provide(
    'redisUrl',
    `redis://:${redisPassword}@${redisContainer.getHost()}:${String(redisContainer.getPort())}/0`,
  );

  return async () => {
    await Promise.all([container.stop(), redisContainer.stop()]);
  };
}
