/**
 * Seed: creates the demo tenant once, is safe to run twice, and the Super Admin can be
 * verified against the password it was given.
 *
 * Depends on: src/seed/seed.ts, ./helpers.ts. Used by: pnpm test.
 */
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { verifyPassword } from '../../src/kernel/auth/password-hasher.js';
import { ALL_PERMISSIONS, runSeed } from '../../src/seed/seed.js';
import { connect, testDatabase } from './helpers.js';
import { connectionUrl } from './global-setup.js';

const db = testDatabase();
const pool = new pg.Pool({ connectionString: connectionUrl(db, db.owner), max: 2 });
const PASSWORD = 'Seed-Test-Passw0rd-xyz!';

afterAll(() => pool.end());

describe('seed', () => {
  it('creates the demo tenant, roles, Super Admin and parties, and is idempotent', async () => {
    const first = await runSeed(pool, { superAdminPassword: PASSWORD, tenantSlug: 'seed-test' });
    const second = await runSeed(pool, {
      superAdminPassword: 'another-Passw0rd-123!',
      tenantSlug: 'seed-test',
    });
    expect(first.superAdminCreated).toBe(true);
    expect(second.superAdminCreated).toBe(false);
    expect(second.tenantId).toBe(first.tenantId);

    const owner = await connect('owner');
    try {
      const count = async (sql: string) =>
        Number((await owner.query<{ n: string }>(sql, [first.tenantId])).rows[0]?.n ?? 0);
      expect(await count(`SELECT count(*) n FROM iam.role WHERE tenant_id = $1`)).toBe(4);
      expect(await count(`SELECT count(*) n FROM platform.branch WHERE tenant_id = $1`)).toBe(1);
      expect(await count(`SELECT count(*) n FROM party.party WHERE tenant_id = $1`)).toBe(6);
      expect(await count(`SELECT count(*) n FROM iam.user_account WHERE tenant_id = $1`)).toBe(1);
      // Client 18/14 and pay 14/10 QAR per order, once (row 2.9b).
      const rates = await owner.query<{ key: string; profession: string; value: string }>(
        `SELECT t.key, r.dims->>'profession' AS profession, r.value::text AS value
         FROM cfg.rate_table_row r JOIN cfg.rate_table t ON t.id = r.rate_table_id
         WHERE t.tenant_id = $1 AND r.currency = 'QAR' ORDER BY 1, 2`,
        [first.tenantId],
      );
      expect(rates.rows.map((r) => `${r.key}:${r.profession}:${r.value}`)).toEqual([
        'client_rate_per_order:driver:18.0000',
        'client_rate_per_order:rider:14.0000',
        'pay_rate_per_order:driver:14.0000',
        'pay_rate_per_order:rider:10.0000',
      ]);

      // Six starting rules for the workflow events, once (row 2.11c).
      expect(
        await count(
          `SELECT count(*) n FROM notify.notification_rule
           WHERE tenant_id = $1 AND event_type_key LIKE 'workflow.%'`,
        ),
      ).toBe(6);

      // Super Admin holds every declared permission; Viewer holds only read/view keys, plus the
      // own-delegation keys (the API limits those to the viewer's own stand-ins).
      const sa = await owner.query<{ n: string }>(
        `SELECT count(*) n FROM iam.role_permission rp JOIN iam.role r ON r.id = rp.role_id
         WHERE r.tenant_id = $1 AND r.key = 'super_admin'`,
        [first.tenantId],
      );
      expect(Number(sa.rows[0]?.n)).toBeGreaterThanOrEqual(ALL_PERMISSIONS.length);
      const bad = await owner.query(
        `SELECT 1 FROM iam.role_permission rp JOIN iam.role r ON r.id = rp.role_id
         JOIN iam.permission p ON p.id = rp.permission_id
         WHERE r.tenant_id = $1 AND r.key = 'viewer' AND p.action NOT IN ('read', 'view')
           AND p.key NOT IN ('platform.workflow_delegation.create',
                             'platform.workflow_delegation.update',
                             'platform.workflow_delegation.delete')`,
        [first.tenantId],
      );
      expect(bad.rowCount).toBe(0);

      // The first password stays: the second run must not replace it.
      const hash = await owner.query<{ hash: string }>(
        `SELECT hash FROM iam.credential WHERE user_id = $1 AND is_current`,
        [first.superAdminId],
      );
      expect(await verifyPassword(hash.rows[0]?.hash ?? '', PASSWORD)).toBe(true);
    } finally {
      await owner.end();
    }
  });
});
