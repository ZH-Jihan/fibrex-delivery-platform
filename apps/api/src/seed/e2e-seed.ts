/**
 * Test users for the Playwright journeys (`pnpm db:seed:e2e`). Development and CI only.
 *
 * Purpose: the demo Super Admin must set up two-step sign-in (a role rule, SPEC 6.2), which
 * a scripted browser cannot do by hand. This adds two synthetic users to the demo tenant
 * with their own roles that do NOT require two-step sign-in, so the journeys can sign in:
 *   e2e.admin   role e2e_admin   every permission in the catalogue
 *   e2e.viewer  role e2e_viewer  read permissions only (proves that buttons are hidden)
 *   e2e.reviewer, e2e.owner, e2e.manager  roles e2e_reviewer / e2e_owner / e2e_manager: only
 *               the own-delegation keys (the workflow journey, row 2.11c)
 * The password comes from E2E_PASSWORD (a synthetic value for local and CI use only; the
 * default below is public, so never run this against a real tenant). Idempotent: existing
 * users and roles are left alone. Refuses to run in production.
 *
 * Depends on: ./seed.ts (the demo tenant must exist), kernel/auth/password-hasher.ts, pg.
 * Used by: ./e2e-seed-cli.ts (the `db:seed:e2e` script).
 */
import type pg from 'pg';
import { hashPassword } from '../kernel/auth/password-hasher.js';

export const E2E_DEFAULT_PASSWORD = 'e2e-Synthetic-Pass-2026';

// `grant` says which permissions the role gets: every one, the read keys only, or only the
// own-delegation keys (an ordinary approver: the inbox needs no permission, and arranging a
// stand-in is self-service). The workflow journey names these roles and people in a workflow.
const USERS = [
  { username: 'e2e.admin', displayName: 'E2E Admin', role: 'e2e_admin', grant: 'all' },
  { username: 'e2e.viewer', displayName: 'E2E Viewer', role: 'e2e_viewer', grant: 'read' },
  { username: 'e2e.reviewer', displayName: 'E2E Reviewer', role: 'e2e_reviewer', grant: 'own' },
  { username: 'e2e.owner', displayName: 'E2E Owner', role: 'e2e_owner', grant: 'own' },
  { username: 'e2e.manager', displayName: 'E2E Manager', role: 'e2e_manager', grant: 'own' },
] as const;

export async function runE2eSeed(pool: pg.Pool, password: string, slug = 'demo'): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tenant = await client.query<{ id: string }>(
      `SELECT id FROM platform.tenant WHERE slug = $1 AND deleted_at IS NULL`,
      [slug],
    );
    const tenantId = tenant.rows[0]?.id;
    if (tenantId === undefined) throw new Error('Run `pnpm db:seed` first: no demo tenant.');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const company = await client.query<{ id: string }>(
      `SELECT id FROM platform.company WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY created_at LIMIT 1`,
      [tenantId],
    );
    const companyId = company.rows[0]?.id;
    if (companyId === undefined) throw new Error('The demo tenant has no company.');

    for (const u of USERS) {
      // The role is found or made, and always topped up with the permissions declared since
      // the last run (a database kept from an earlier phase would otherwise miss them).
      const found = await client.query<{ id: string }>(
        `SELECT id FROM iam.role WHERE tenant_id = $1 AND key = $2 AND deleted_at IS NULL`,
        [tenantId, u.role],
      );
      let roleId = found.rows[0]?.id;
      if (roleId === undefined) {
        const role = await client.query<{ id: string }>(
          `INSERT INTO iam.role (tenant_id, key, name, description, is_builtin, mfa_required)
           VALUES ($1, $2, $3, 'Playwright test role', false, false) RETURNING id`,
          [tenantId, u.role, u.displayName],
        );
        roleId = role.rows[0]?.id;
      }
      await client.query(
        `INSERT INTO iam.role_permission (tenant_id, role_id, permission_id)
         SELECT $1, $2, id FROM iam.permission
         WHERE is_active AND (
           $3::text = 'all'
           OR ($3::text = 'read' AND (action = 'read' OR key = 'recycle_bin.view'))
           OR ($3::text = 'own' AND key IN (
                'platform.workflow_delegation.read', 'platform.workflow_delegation.create',
                'platform.workflow_delegation.update', 'platform.workflow_delegation.delete')))
         ON CONFLICT (role_id, permission_id) WHERE deleted_at IS NULL DO NOTHING`,
        [tenantId, roleId, u.grant],
      );
      const exists = await client.query(
        `SELECT 1 FROM iam.user_account WHERE tenant_id = $1 AND username = $2 AND deleted_at IS NULL`,
        [tenantId, u.username],
      );
      if (exists.rowCount !== 0) continue;
      const user = await client.query<{ id: string }>(
        `INSERT INTO iam.user_account (tenant_id, username, email, display_name, must_change_password)
         VALUES ($1, $2, $3, $4, false) RETURNING id`,
        [tenantId, u.username, `${u.username}@demo.fibrex.local`, u.displayName],
      );
      const userId = user.rows[0]?.id;
      await client.query(
        `INSERT INTO iam.credential (tenant_id, user_id, kind, hash) VALUES ($1, $2, 'password', $3)`,
        [tenantId, userId, await hashPassword(password)],
      );
      const membership = await client.query<{ id: string }>(
        `INSERT INTO iam.company_membership (tenant_id, user_id, company_id, is_default)
         VALUES ($1, $2, $3, true) RETURNING id`,
        [tenantId, userId, companyId],
      );
      await client.query(
        `INSERT INTO iam.membership_role (tenant_id, membership_id, role_id) VALUES ($1, $2, $3)`,
        [tenantId, membership.rows[0]?.id, roleId],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
