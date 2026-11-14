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

      // Super Admin holds every declared permission; Viewer holds only read/view keys.
      const sa = await owner.query<{ n: string }>(
        `SELECT count(*) n FROM iam.role_permission rp JOIN iam.role r ON r.id = rp.role_id
         WHERE r.tenant_id = $1 AND r.key = 'super_admin'`,
        [first.tenantId],
      );
      expect(Number(sa.rows[0]?.n)).toBeGreaterThanOrEqual(ALL_PERMISSIONS.length);
      const bad = await owner.query(
        `SELECT 1 FROM iam.role_permission rp JOIN iam.role r ON r.id = rp.role_id
         JOIN iam.permission p ON p.id = rp.permission_id
         WHERE r.tenant_id = $1 AND r.key = 'viewer' AND p.action NOT IN ('read', 'view')`,
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
