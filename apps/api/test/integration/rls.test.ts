/**
 * Row-level security and grants (Phase 1 Done-when: "A second seeded tenant cannot read
 * the first tenant's rows even with the application filter removed").
 *
 * Every query here is raw SQL with NO tenant filter in the WHERE clause. Only the session
 * context differs, so any isolation observed comes from the database itself.
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

const ids = (r: pg.QueryResult) => r.rows.map((row: { id: string }) => row.id).sort();

describe('tenant isolation', () => {
  it('tenant B sees only its own rows in a company-scoped table', async () => {
    const rows = await inContext(app, { tenantId: f.tenantB, companyIds: [f.companyB1] }, (c) =>
      c.query('SELECT id FROM platform.branch'),
    );
    expect(ids(rows)).toEqual([f.branchB1]);
  });

  it('tenant B cannot read tenant A rows even when asking for them by id', async () => {
    const rows = await inContext(
      app,
      { tenantId: f.tenantB, companyIds: [f.companyA1, f.companyB1] },
      (c) => c.query('SELECT id FROM platform.branch WHERE id = $1', [f.branchA1]),
    );
    expect(rows.rowCount).toBe(0);
  });

  it('isolates tenant-scoped tables (users, companies, tenants)', async () => {
    await inContext(app, { tenantId: f.tenantB, companyIds: [f.companyB1] }, async (c) => {
      expect(ids(await c.query('SELECT id FROM iam.user_account'))).toEqual([f.userB]);
      expect(ids(await c.query('SELECT id FROM platform.company'))).toEqual([f.companyB1]);
      expect(ids(await c.query('SELECT id FROM platform.tenant'))).toEqual([f.tenantB]);
    });
  });

  it('fails closed: with no context the app sees nothing', async () => {
    await inContext(app, {}, async (c) => {
      expect((await c.query('SELECT id FROM platform.branch')).rowCount).toBe(0);
      expect((await c.query('SELECT id FROM iam.user_account')).rowCount).toBe(0);
      expect((await c.query('SELECT id FROM platform.tenant')).rowCount).toBe(0);
    });
  });
});

describe('company isolation inside one tenant', () => {
  it('a session limited to company A1 does not see A2', async () => {
    const rows = await inContext(app, { tenantId: f.tenantA, companyIds: [f.companyA1] }, (c) =>
      c.query('SELECT id FROM platform.branch'),
    );
    expect(ids(rows)).toEqual([f.branchA1]);
  });

  it('a consolidated session (owner view) sees both companies of its tenant only', async () => {
    const rows = await inContext(
      app,
      { tenantId: f.tenantA, companyIds: [f.companyA1, f.companyA2] },
      (c) => c.query('SELECT id FROM platform.branch'),
    );
    expect(ids(rows)).toEqual([f.branchA1, f.branchA2].sort());
  });
});

describe('writes are checked too (WITH CHECK)', () => {
  it('cannot insert a row into another tenant', async () => {
    const code = await inContext(app, { tenantId: f.tenantB, companyIds: [f.companyB1] }, (c) =>
      sqlState(
        c.query(
          `INSERT INTO platform.branch (tenant_id, company_id, code, name) VALUES ($1, $2, 'X', 'x')`,
          [f.tenantA, f.companyA1],
        ),
      ),
    );
    expect(code).toBe(SQLSTATE.insufficientPrivilege);
  });

  it('cannot insert into a company outside the session', async () => {
    const code = await inContext(app, { tenantId: f.tenantA, companyIds: [f.companyA1] }, (c) =>
      sqlState(
        c.query(
          `INSERT INTO platform.branch (tenant_id, company_id, code, name) VALUES ($1, $2, 'X', 'x')`,
          [f.tenantA, f.companyA2],
        ),
      ),
    );
    expect(code).toBe(SQLSTATE.insufficientPrivilege);
  });

  it('updates to invisible rows silently affect nothing', async () => {
    const r = await inContext(app, { tenantId: f.tenantB, companyIds: [f.companyB1] }, (c) =>
      c.query(`UPDATE platform.branch SET name = 'hacked' WHERE id = $1`, [f.branchA1]),
    );
    expect(r.rowCount).toBe(0);
  });
});

describe('grants: no physical deletes and no RLS bypass for the app role', () => {
  it('fibrex_app cannot DELETE or TRUNCATE', async () => {
    await inContext(app, { tenantId: f.tenantA, companyIds: [f.companyA1] }, async (c) => {
      await c.query('SAVEPOINT s');
      expect(
        await sqlState(c.query('DELETE FROM platform.branch WHERE id = $1', [f.branchA1])),
      ).toBe(SQLSTATE.insufficientPrivilege);
      await c.query('ROLLBACK TO SAVEPOINT s');
      expect(await sqlState(c.query('TRUNCATE platform.branch'))).toBe(
        SQLSTATE.insufficientPrivilege,
      );
    });
  });

  it('fibrex_app and fibrex_bi have no superuser or BYPASSRLS attribute', async () => {
    const r = await owner.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('fibrex_app', 'fibrex_bi')`,
    );
    expect(r.rows).toHaveLength(2);
    for (const row of r.rows) {
      expect(row.rolsuper).toBe(false);
      expect(row.rolbypassrls).toBe(false);
    }
  });

  it('global reference data is read-only for the app', async () => {
    await inContext(app, {}, async (c) => {
      expect(
        (await c.query(`SELECT code FROM platform.currency WHERE code = 'QAR'`)).rowCount,
      ).toBe(1);
      expect(
        await sqlState(
          c.query(`INSERT INTO platform.currency (code, name) VALUES ('XXX', 'Test')`),
        ),
      ).toBe(SQLSTATE.insufficientPrivilege);
    });
  });

  it('the permission catalogue can be registered by the app (global catalogue)', async () => {
    const r = await inContext(app, {}, (c) =>
      c.query(
        `INSERT INTO iam.permission (key, module_key, action, resource) VALUES ('test.widget.view', 'test', 'view', 'widget') RETURNING version`,
      ),
    );
    expect(r.rows[0]).toEqual({ version: 1 });
  });

  it('every table in the platform and iam schemas has RLS enabled, except global tables', async () => {
    const r = await owner.query<{ table: string }>(
      `SELECT n.nspname || '.' || c.relname AS table
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('platform', 'iam') AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
        ORDER BY 1`,
    );
    expect(r.rows.map((x) => x.table)).toEqual([
      'iam.permission',
      'platform.currency',
      'platform.subscription_plan',
    ]);
  });

  it('every non-global table has a tenant_id column', async () => {
    const r = await owner.query<{ table: string }>(
      `SELECT n.nspname || '.' || c.relname AS table
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('platform', 'iam') AND c.relkind IN ('r', 'p')
          AND c.relname NOT IN ('tenant', 'currency', 'subscription_plan', 'permission')
          AND NOT EXISTS (SELECT 1 FROM pg_attribute a
                           WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)`,
    );
    expect(r.rows).toEqual([]);
  });
});
