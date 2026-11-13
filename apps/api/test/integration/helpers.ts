/**
 * Helpers for integration tests that talk to PostgreSQL directly.
 *
 * Purpose: open connections as a given role and run SQL inside a transaction that carries
 * the same request context the API sets (app.tenant_id, app.company_ids, app.user_id).
 * Plain `pg` is used on purpose: these tests prove that the *database* enforces isolation
 * and immutability, with no application code in between.
 *
 * Depends on: pg, ./global-setup (connection details). Used by: test/integration/*.test.ts.
 */
import pg from 'pg';
import { inject } from 'vitest';
import { connectionUrl, type TestDatabase } from './global-setup.js';

export type Role = 'superUser' | 'owner' | 'app' | 'bi';

export function testDatabase(): TestDatabase {
  return inject('testDatabase');
}

export async function connect(role: Role): Promise<pg.Client> {
  const db = testDatabase();
  const client = new pg.Client({ connectionString: connectionUrl(db, db[role]) });
  await client.connect();
  return client;
}

export interface RequestContext {
  tenantId?: string;
  companyIds?: string[];
  userId?: string;
}

/**
 * Runs `fn` inside BEGIN ... ROLLBACK with the request context set by `set_config(...,
 * true)`, the same as `SET LOCAL`. Always rolls back so tests do not leak rows.
 */
export async function inContext<T>(
  client: pg.Client,
  ctx: RequestContext,
  fn: (c: pg.Client) => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    if (ctx.tenantId !== undefined) {
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [ctx.tenantId]);
    }
    if (ctx.companyIds !== undefined) {
      await client.query("SELECT set_config('app.company_ids', $1, true)", [
        `{${ctx.companyIds.join(',')}}`,
      ]);
    }
    if (ctx.userId !== undefined) {
      await client.query("SELECT set_config('app.user_id', $1, true)", [ctx.userId]);
    }
    return await fn(client);
  } finally {
    await client.query('ROLLBACK');
  }
}

/** Resolves to the PostgreSQL error code (SQLSTATE) the promise rejected with. */
export async function sqlState(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof Error && 'code' in err && typeof err.code === 'string') return err.code;
    throw err;
  }
  throw new Error('Expected the statement to fail, but it succeeded');
}

/** SQLSTATE codes used in assertions. */
export const SQLSTATE = {
  insufficientPrivilege: '42501',
  checkViolation: '23514',
  uniqueViolation: '23505',
  exclusionViolation: '23P01',
  noPartition: '23514',
} as const;
