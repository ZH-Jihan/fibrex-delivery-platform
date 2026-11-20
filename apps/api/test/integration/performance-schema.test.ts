/**
 * Performance and tracking, row 4.1: the schema rules the database enforces on its own,
 * plus the Snoonu seed and the module manifests.
 *
 * Plain SQL as the app role inside a request context (no application code in between), so
 * these prove RLS, the audit trigger, no deletes, the retire-only daily performance rows,
 * and the constraints of phase 4 plan section 4. All people and ids are invented.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ModuleRegistry } from '../../src/kernel/module-registry/index.js';
import {
  PERFORMANCE_PERMISSIONS,
  SNOONU_CYCLE_START_DAY,
  SNOONU_METRICS,
  createPerformanceModule,
  seedClientPlatforms,
} from '../../src/modules/performance/index.js';
import { TRACKING_PERMISSIONS, createTrackingModule } from '../../src/modules/tracking/index.js';
import { createFixture, type Fixture } from './fixtures.js';
import { SQLSTATE, connect, inContext, sqlState } from './helpers.js';

const TABLES = [
  'performance.client_platform',
  'performance.sync_source',
  'performance.column_mapping',
  'performance.metric_definition',
  'performance.sync_run',
  'performance.sync_run_error',
  'performance.daily_performance',
  'performance.unmatched_identifier',
  'tracking.tracking_entry',
  'tracking.id_operator_period',
  'tracking.call_log',
];

let owner: pg.Client;
let app: pg.Client;
let f: Fixture;
let platformId: string;
let sourceId: string;
let runId: string;
let riderId: string;
let identifierId: string;
let reasonId: string;
let outcomeId: string;

const a1 = () => ({ tenantId: f.tenantA, companyIds: [f.companyA1], userId: f.userA });
const sha = (c: string) => c.repeat(64);

/** The first row's id; fails loudly when the statement returned none. */
function firstId(r: pg.QueryResult<{ id: string }>): string {
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error('expected a row');
  return id;
}

function firstRow<T extends pg.QueryResultRow>(r: pg.QueryResult<T>): T {
  const row = r.rows[0];
  if (row === undefined) throw new Error('expected a row');
  return row;
}

beforeAll(async () => {
  owner = await connect('owner');
  app = await connect('app');
  f = await createFixture(owner);
  platformId = await seedClientPlatforms(owner, f.tenantA, f.companyA1);

  const rider = await owner.query<{ id: string }>(
    `INSERT INTO party.party (tenant_id, company_id, kind, display_name)
     VALUES ($1, $2, 'person', 'Test Rider One') RETURNING id`,
    [f.tenantA, f.companyA1],
  );
  riderId = firstId(rider);
  const ident = await owner.query<{ id: string }>(
    `INSERT INTO party.party_identifier
       (tenant_id, company_id, party_id, type, client_platform_id, value_encrypted, value_hash, value_masked, value_plain)
     VALUES ($1, $2, $3, 'falcon_id', $4, '\\x00', $5, '***001', 'F900001') RETURNING id`,
    [f.tenantA, f.companyA1, riderId, platformId, randomUUID()],
  );
  identifierId = firstId(ident);
  const source = await owner.query<{ id: string }>(
    `INSERT INTO performance.sync_source (tenant_id, company_id, client_platform_id, name, adapter_kind)
     VALUES ($1, $2, $3, 'Snoonu Daily Report', 'sheet') RETURNING id`,
    [f.tenantA, f.companyA1, platformId],
  );
  sourceId = firstId(source);
  const run = await owner.query<{ id: string }>(
    `INSERT INTO performance.sync_run (tenant_id, company_id, sync_source_id, business_date, trigger)
     VALUES ($1, $2, $3, '2026-11-20', 'manual') RETURNING id`,
    [f.tenantA, f.companyA1, sourceId],
  );
  runId = firstId(run);

  const lookup = async (key: string, code: string) => {
    const type = await owner.query<{ id: string }>(
      `INSERT INTO cfg.lookup_type (tenant_id, key, name) VALUES ($1, $2, $2) RETURNING id`,
      [f.tenantA, key],
    );
    const value = await owner.query<{ id: string }>(
      `INSERT INTO cfg.lookup_value (tenant_id, lookup_type_id, code, labels)
       VALUES ($1, $2, $3, '{"en": "x"}') RETURNING id`,
      [f.tenantA, firstId(type), code],
    );
    return firstId(value);
  };
  reasonId = await lookup('status_reason', 'absconded');
  outcomeId = await lookup('call_outcome', 'no_answer');
});

afterAll(async () => {
  await app.end();
  await owner.end();
});

describe('performance and tracking tables', () => {
  it('every table has RLS, tenant and company columns, and no DELETE grant', async () => {
    for (const t of TABLES) {
      const r = await owner.query<{ rls: boolean; del: boolean; cols: string }>(
        `SELECT c.relrowsecurity AS rls,
                has_table_privilege('fibrex_app', $1, 'DELETE') AS del,
                (SELECT string_agg(attname, ',') FROM pg_attribute
                  WHERE attrelid = c.oid AND attname IN ('tenant_id', 'company_id', 'created_at')) AS cols
           FROM pg_class c WHERE c.oid = $1::regclass`,
        [t],
      );
      expect(r.rows[0], t).toMatchObject({ rls: true, del: false });
      expect(firstRow(r).cols.split(',').sort(), t).toEqual([
        'company_id',
        'created_at',
        'tenant_id',
      ]);
    }
  });

  it('daily_performance is partitioned by month', async () => {
    const r = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_inherits WHERE inhparent = 'performance.daily_performance'::regclass`,
    );
    expect(Number(firstRow(r).n)).toBeGreaterThanOrEqual(11);
  });
});

describe('Snoonu seed', () => {
  it('creates the platform with a 26th-to-25th cycle and the seven metrics, once', async () => {
    const again = await seedClientPlatforms(owner, f.tenantA, f.companyA1);
    expect(again).toBe(platformId);
    const p = await owner.query(
      `SELECT p.code, p.adapter_kind, p.cycle_start_day, party.kind
         FROM performance.client_platform p JOIN party.party party ON party.id = p.party_id
        WHERE p.id = $1`,
      [platformId],
    );
    expect(p.rows[0]).toEqual({
      code: 'snoonu',
      adapter_kind: 'sheet',
      cycle_start_day: SNOONU_CYCLE_START_DAY,
      kind: 'organisation',
    });
    expect(SNOONU_CYCLE_START_DAY).toBe(26);
    const m = await owner.query<{ key: string; is_core: boolean }>(
      `SELECT key, is_core FROM performance.metric_definition
        WHERE client_platform_id = $1 ORDER BY sort_order`,
      [platformId],
    );
    expect(m.rows.map((r) => r.key)).toEqual(SNOONU_METRICS.map((x) => x.key));
    expect(m.rows.filter((r) => r.is_core).map((r) => r.key)).toEqual([
      'delivered',
      'working_hours',
      'late_minutes',
    ]);
  });

  it('refuses a cycle start day that some months do not have', async () => {
    expect(
      await sqlState(
        owner.query(`UPDATE performance.client_platform SET cycle_start_day = 31 WHERE id = $1`, [
          platformId,
        ]),
      ),
    ).toBe(SQLSTATE.checkViolation);
  });
});

describe('row-level security and audit', () => {
  it('shows a platform only inside its own tenant and company', async () => {
    const count = (ctx: Parameters<typeof inContext>[1]) =>
      inContext(app, ctx, async (c) => {
        const r = await c.query(`SELECT id FROM performance.client_platform WHERE id = $1`, [
          platformId,
        ]);
        return r.rowCount;
      });
    expect(await count(a1())).toBe(1);
    expect(await count({ tenantId: f.tenantA, companyIds: [f.companyA2] })).toBe(0);
    expect(await count({ tenantId: f.tenantB, companyIds: [f.companyB1] })).toBe(0);
  });

  it('refuses a row written into another company', async () => {
    const state = await inContext(app, a1(), (c) =>
      sqlState(
        c.query(
          `INSERT INTO tracking.call_log (tenant_id, company_id, party_id, business_date, outcome_id)
           VALUES ($1, $2, $3, '2026-11-20', $4)`,
          [f.tenantA, f.companyA2, riderId, outcomeId],
        ),
      ),
    );
    expect(state).toBe(SQLSTATE.insufficientPrivilege);
  });

  it('audits a change to a platform', async () => {
    const actions = await inContext(app, a1(), async (c) => {
      await c.query(`UPDATE performance.client_platform SET status = 'inactive' WHERE id = $1`, [
        platformId,
      ]);
      const r = await c.query<{ action: string; entity_type: string }>(
        `SELECT action, entity_type FROM audit.audit_log WHERE entity_id = $1 AND action = 'update'`,
        [platformId],
      );
      return r.rows;
    });
    expect(actions).toEqual([{ action: 'update', entity_type: 'performance.client_platform' }]);
  });

  it('keeps the call log insert-only', async () => {
    const state = await inContext(app, a1(), async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO tracking.call_log (tenant_id, company_id, party_id, business_date, outcome_id)
         VALUES ($1, $2, $3, '2026-11-20', $4) RETURNING id`,
        [f.tenantA, f.companyA1, riderId, outcomeId],
      );
      return sqlState(
        c.query(`UPDATE tracking.call_log SET note = 'x' WHERE id = $1`, [firstId(r)]),
      );
    });
    expect(state).toBe(SQLSTATE.insufficientPrivilege);
  });
});

describe('daily_performance', () => {
  const insert = (c: pg.Client, externalId: string, orders: number, partyId: string | null) =>
    c.query<{ id: string }>(
      `INSERT INTO performance.daily_performance
         (tenant_id, company_id, sync_run_id, client_platform_id, business_date, party_id, external_id,
          orders_completed, working_minutes, metrics)
       VALUES ($1, $2, $3, $4, '2026-11-19', $5, $6, $7, 450, '{"kms": 61.2}') RETURNING id`,
      [f.tenantA, f.companyA1, runId, platformId, partyId, externalId, orders],
    );

  it('keeps one current row per sheet id and person; a re-import retires the old row', async () => {
    await inContext(app, a1(), async (c) => {
      const first = await insert(c, 'F900001', 18, riderId);
      await c.query('SAVEPOINT s');
      expect(await sqlState(insert(c, 'F900001', 20, riderId))).toBe(SQLSTATE.uniqueViolation);
      await c.query('ROLLBACK TO SAVEPOINT s');
      // Same person under another sheet id on the same date: still one current row.
      expect(await sqlState(insert(c, 'F900002', 20, riderId))).toBe(SQLSTATE.uniqueViolation);
      await c.query('ROLLBACK TO SAVEPOINT s');

      await c.query(
        `UPDATE performance.daily_performance SET is_current = false
          WHERE id = $1 AND business_date = '2026-11-19'`,
        [firstId(first)],
      );
      await insert(c, 'F900001', 20, riderId);
      const r = await c.query<{ orders_completed: number; is_current: boolean }>(
        `SELECT orders_completed, is_current FROM performance.daily_performance
          WHERE external_id = 'F900001' ORDER BY orders_completed`,
      );
      expect(r.rows).toEqual([
        { orders_completed: 18, is_current: false },
        { orders_completed: 20, is_current: true },
      ]);
    });
  });

  it('refuses any other change and any delete', async () => {
    await inContext(app, a1(), async (c) => {
      const row = await insert(c, 'F900003', 5, null);
      const id = firstId(row);
      const attempt = async (sql: string) => {
        await c.query('SAVEPOINT s');
        const state = await sqlState(c.query(sql, [id]));
        await c.query('ROLLBACK TO SAVEPOINT s');
        return state;
      };
      expect(
        await attempt(
          `UPDATE performance.daily_performance SET orders_completed = 99 WHERE id = $1`,
        ),
      ).toBe(SQLSTATE.insufficientPrivilege);
      expect(await attempt(`DELETE FROM performance.daily_performance WHERE id = $1`)).toBe(
        SQLSTATE.insufficientPrivilege,
      );
      await c.query(`UPDATE performance.daily_performance SET is_current = false WHERE id = $1`, [
        id,
      ]);
      // A retired row is never brought back.
      expect(
        await attempt(`UPDATE performance.daily_performance SET is_current = true WHERE id = $1`),
      ).toBe(SQLSTATE.insufficientPrivilege);
    });
  });
});

describe('sync runs and the unmatched queue', () => {
  it('stores the same snapshot for the same date once; later runs reuse it', async () => {
    await inContext(app, a1(), async (c) => {
      const raw = await c.query<{ id: string }>(
        `INSERT INTO files.raw_input (tenant_id, company_id, kind, source, sha256)
         VALUES ($1, $2, 'sheet_snapshot', 'snoonu', $3) RETURNING id`,
        [f.tenantA, f.companyA1, sha('a')],
      );
      const run = (reused: boolean) =>
        c.query(
          `INSERT INTO performance.sync_run
             (tenant_id, company_id, sync_source_id, business_date, trigger, raw_input_id, snapshot_sha256, snapshot_reused)
           VALUES ($1, $2, $3, '2026-11-21', 'scheduled', $4, $5, $6)`,
          [f.tenantA, f.companyA1, sourceId, firstId(raw), sha('a'), reused],
        );
      await run(false);
      await run(true);
      expect(await sqlState(run(false))).toBe(SQLSTATE.uniqueViolation);
    });
  });

  it('needs a person for a linked id and none for an open one', async () => {
    const state = await inContext(app, a1(), (c) =>
      sqlState(
        c.query(
          `INSERT INTO performance.unmatched_identifier
             (tenant_id, company_id, client_platform_id, external_id, first_seen, last_seen, status)
           VALUES ($1, $2, $3, 'F999999', '2026-11-19', '2026-11-20', 'linked')`,
          [f.tenantA, f.companyA1, platformId],
        ),
      ),
    );
    expect(state).toBe(SQLSTATE.checkViolation);
  });
});

describe('tracking', () => {
  it('needs a reason to make someone inactive, blocked or terminated', async () => {
    await inContext(app, a1(), async (c) => {
      const entry = (status: string, reason: string | null) =>
        c.query(
          `INSERT INTO tracking.tracking_entry
             (tenant_id, company_id, party_id, business_date, status_code, reason_id, effective_date, caller_user_id)
           VALUES ($1, $2, $3, '2026-11-20', $4, $5, '2026-11-20', $6)`,
          [f.tenantA, f.companyA1, riderId, status, reason, f.userA],
        );
      await entry('active', null);
      await entry('blocked', reasonId);
      expect(await sqlState(entry('blocked', null))).toBe(SQLSTATE.checkViolation);
    });
  });

  it('allows one operator per platform id at a time', async () => {
    await inContext(app, a1(), async (c) => {
      const period = (from: string, to: string | null) =>
        c.query(
          `INSERT INTO tracking.id_operator_period
             (tenant_id, company_id, party_identifier_id, owner_party_id, operator_name, from_date, to_date)
           VALUES ($1, $2, $3, $4, 'Test Stand In', $5, $6)`,
          [f.tenantA, f.companyA1, identifierId, riderId, from, to],
        );
      await period('2026-11-01', '2026-11-10');
      await period('2026-11-11', null);
      expect(await sqlState(period('2026-11-10', '2026-11-12'))).toBe(SQLSTATE.exclusionViolation);
    });
  });
});

describe('module manifests', () => {
  it('register the performance.* and tracking.* permissions', () => {
    const modules = new ModuleRegistry({ kernelPermissions: [] });
    modules.register(createPerformanceModule());
    modules.register(createTrackingModule());
    const keys = modules.permissions().map((p) => p.key);
    expect(keys).toContain('performance.sync_run.run');
    expect(keys).toContain('tracking.entry.create');
    expect(keys.every((k) => /^(performance|tracking)\./.test(k))).toBe(true);
    expect(keys).toHaveLength(PERFORMANCE_PERMISSIONS.length + TRACKING_PERMISSIONS.length);
  });
});
