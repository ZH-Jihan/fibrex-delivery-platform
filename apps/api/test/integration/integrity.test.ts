/**
 * Database-level integrity rules from the foundation migration: row stamping and
 * optimistic-lock versions, fixed tenancy, soft-delete consistency, append-only tables,
 * monthly partitions, effective-dating exclusion, and UUIDv7 keys.
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixture, type Fixture } from './fixtures.js';
import { SQLSTATE, connect, inContext, sqlState } from './helpers.js';

let owner: pg.Client;
let app: pg.Client;
let f: Fixture;

beforeAll(async () => {
  owner = await connect('owner');
  app = await connect('app');
  f = await createFixture(owner);
});

afterAll(async () => {
  await app.end();
  await owner.end();
});

interface StampRow {
  id: string;
  version: number;
  created_at: Date;
  created_by: string | null;
  updated_by: string | null;
}

describe('row stamping and optimistic locking', () => {
  it('stamps creator and version on insert, bumps version on update', async () => {
    await inContext(
      app,
      { tenantId: f.tenantA, companyIds: [f.companyA1], userId: f.userA },
      async (c) => {
        const inserted = await c.query<StampRow>(
          `INSERT INTO platform.branch (tenant_id, company_id, code, name, version, created_by)
           VALUES ($1, $2, 'STAMP', 'Stamp test', 99, $3)
           RETURNING id, version, created_at, created_by, updated_by`,
          [f.tenantA, f.companyA1, f.userA],
        );
        const row = inserted.rows[0];
        if (!row) throw new Error('insert returned no row');
        // Caller-supplied version is ignored: versions always start at 1.
        expect(row.version).toBe(1);
        expect(row.created_by).toBe(f.userA);

        // Optimistic lock: the first update with version 1 wins...
        const first = await c.query<StampRow>(
          `UPDATE platform.branch SET name = 'v2', created_at = now() - interval '1 year'
           WHERE id = $1 AND version = 1 RETURNING id, version, created_at, created_by, updated_by`,
          [row.id],
        );
        expect(first.rowCount).toBe(1);
        expect(first.rows[0]?.version).toBe(2);
        // ...and created_at cannot be rewritten.
        expect(first.rows[0]?.created_at.getTime()).toBe(row.created_at.getTime());

        // ...a second writer still holding version 1 updates nothing (the API turns this
        // into HTTP 409 with a diff).
        const stale = await c.query(
          `UPDATE platform.branch SET name = 'v2-stale' WHERE id = $1 AND version = 1`,
          [row.id],
        );
        expect(stale.rowCount).toBe(0);
      },
    );
  });
});

describe('tenant and company are fixed after insert', () => {
  it('blocks moving a row to another company, even for the owner role', async () => {
    await owner.query('BEGIN');
    try {
      const code = await sqlState(
        owner.query('UPDATE platform.branch SET company_id = $1 WHERE id = $2', [
          f.companyA2,
          f.branchA1,
        ]),
      );
      expect(code).toBe(SQLSTATE.checkViolation);
    } finally {
      await owner.query('ROLLBACK');
    }
  });
});

describe('soft delete', () => {
  it('requires a reason and frees the unique code for reuse', async () => {
    await inContext(
      app,
      { tenantId: f.tenantA, companyIds: [f.companyA1], userId: f.userA },
      async (c) => {
        await c.query('SAVEPOINT s');
        expect(
          await sqlState(
            c.query('UPDATE platform.branch SET deleted_at = now() WHERE id = $1', [f.branchA1]),
          ),
        ).toBe(SQLSTATE.checkViolation);
        await c.query('ROLLBACK TO SAVEPOINT s');

        // A live duplicate code is refused...
        await c.query('SAVEPOINT s2');
        expect(
          await sqlState(
            c.query(
              `INSERT INTO platform.branch (tenant_id, company_id, code, name) VALUES ($1, $2, 'HQ', 'dup')`,
              [f.tenantA, f.companyA1],
            ),
          ),
        ).toBe(SQLSTATE.uniqueViolation);
        await c.query('ROLLBACK TO SAVEPOINT s2');

        // ...but after a soft delete with a reason, the code can be reused.
        await c.query(
          `UPDATE platform.branch SET deleted_at = now(), deleted_by = $2, delete_reason = 'Closed' WHERE id = $1`,
          [f.branchA1, f.userA],
        );
        const r = await c.query(
          `INSERT INTO platform.branch (tenant_id, company_id, code, name) VALUES ($1, $2, 'HQ', 'New HQ') RETURNING id`,
          [f.tenantA, f.companyA1],
        );
        expect(r.rowCount).toBe(1);
      },
    );
  });
});

describe('append-only tables and monthly partitions (iam.login_event)', () => {
  const insertLogin = (c: pg.Client, at: string) =>
    c.query(
      `INSERT INTO iam.login_event (tenant_id, at, user_id, identifier, method, result)
       VALUES ($1, $2, $3, 'alice', 'password', 'success') RETURNING id, at`,
      [f.tenantA, at, f.userA],
    );

  it('accepts inserts but refuses UPDATE and DELETE for the app role', async () => {
    await inContext(app, { tenantId: f.tenantA, companyIds: [f.companyA1] }, async (c) => {
      const r = await insertLogin(c, new Date().toISOString());
      expect(r.rowCount).toBe(1);
      await c.query('SAVEPOINT s');
      expect(await sqlState(c.query(`UPDATE iam.login_event SET result = 'locked'`))).toBe(
        SQLSTATE.insufficientPrivilege,
      );
      await c.query('ROLLBACK TO SAVEPOINT s');
      expect(await sqlState(c.query('DELETE FROM iam.login_event'))).toBe(
        SQLSTATE.insufficientPrivilege,
      );
    });
  });

  it('refuses UPDATE even for the owner role (trigger)', async () => {
    await owner.query('BEGIN');
    try {
      await owner.query(
        `INSERT INTO iam.login_event (tenant_id, user_id, identifier, method, result)
         VALUES ($1, $2, 'alice', 'password', 'success')`,
        [f.tenantA, f.userA],
      );
      expect(await sqlState(owner.query(`UPDATE iam.login_event SET result = 'locked'`))).toBe(
        SQLSTATE.insufficientPrivilege,
      );
    } finally {
      await owner.query('ROLLBACK');
    }
  });

  it('has partitions for the current month and three ahead; maintenance is idempotent', async () => {
    const created = await inContext(app, {}, (c) =>
      c.query<{ n: number }>('SELECT app.maintain_partitions() AS n'),
    );
    expect(created.rows[0]?.n).toBe(0);

    const parts = await owner.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'iam.login_event'::regclass ORDER BY 1`,
    );
    const now = new Date();
    const expected = [0, 1, 2, 3].map((k) => {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + k, 1));
      return `iam_login_event_${String(d.getUTCFullYear())}_${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    });
    for (const name of expected) expect(parts.rows.map((p) => p.name)).toContain(name);
  });

  it('routes rows by month and rejects rows with no partition instead of hiding them', async () => {
    await inContext(app, { tenantId: f.tenantA, companyIds: [f.companyA1] }, async (c) => {
      // Month boundary in UTC: the last instant of a month and the first of the next go to
      // different partitions.
      const now = new Date();
      const firstOfNext = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      await insertLogin(c, new Date(firstOfNext.getTime() - 1).toISOString());
      await insertLogin(c, firstOfNext.toISOString());
      const where = await c.query<{ part: string }>(
        `SELECT tableoid::regclass::text AS part FROM iam.login_event WHERE at IN ($1, $2) ORDER BY at`,
        [new Date(firstOfNext.getTime() - 1).toISOString(), firstOfNext.toISOString()],
      );
      expect(where.rows[0]?.part).not.toBe(where.rows[1]?.part);

      expect(await sqlState(insertLogin(c, '2099-01-01T00:00:00Z'))).toBe(SQLSTATE.noPartition);
    });
  });

  it('the app role cannot read partitions directly, only through the RLS-protected parent', async () => {
    const part = await owner.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'iam.login_event'::regclass LIMIT 1`,
    );
    const name = part.rows[0]?.name ?? '';
    const code = await inContext(app, {}, (c) =>
      sqlState(c.query(`SELECT * FROM partitions."${name}"`)),
    );
    expect(code).toBe(SQLSTATE.insufficientPrivilege);
  });
});

describe('effective dating', () => {
  it('refuses overlapping subscription periods for one tenant', async () => {
    await owner.query('BEGIN');
    try {
      const plan = await owner.query<{ id: string }>(
        `INSERT INTO platform.subscription_plan (code, name) VALUES ('test-plan-' || gen_random_uuid(), 'Test') RETURNING id`,
      );
      const planId = plan.rows[0]?.id;
      await owner.query(
        `INSERT INTO platform.tenant_subscription (tenant_id, plan_id, valid_from, valid_to) VALUES ($1, $2, '2026-01-01', '2026-12-31')`,
        [f.tenantA, planId],
      );
      // Inclusive end: starting on the last day overlaps.
      expect(
        await sqlState(
          owner.query(
            `INSERT INTO platform.tenant_subscription (tenant_id, plan_id, valid_from) VALUES ($1, $2, '2026-12-31')`,
            [f.tenantA, planId],
          ),
        ),
      ).toBe(SQLSTATE.exclusionViolation);
    } finally {
      await owner.query('ROLLBACK');
    }
  });
});

describe('UUIDv7 primary keys', () => {
  it('generates version-7, RFC-variant, time-ordered ids', async () => {
    const r = await owner.query<{ a: string; b: string }>(
      `SELECT app.uuid_generate_v7()::text AS a, (SELECT app.uuid_generate_v7() FROM pg_sleep(0.005))::text AS b`,
    );
    const { a, b } = r.rows[0] ?? { a: '', b: '' };
    for (const id of [a, b]) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    // The first 48 bits are a millisecond timestamp close to now.
    const ms = parseInt(a.replace(/-/g, '').slice(0, 12), 16);
    expect(Math.abs(ms - Date.now())).toBeLessThan(60_000);
    expect(a < b).toBe(true);
  });
});
