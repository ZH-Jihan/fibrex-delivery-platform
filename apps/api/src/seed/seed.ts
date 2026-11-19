/**
 * Development seed: demo tenant, company, branch, built-in roles, Super Admin, synthetic parties.
 *
 * Purpose: gives a fresh database something to sign in to and look at. Everything is created
 * only if it is missing (matched by slug, code, key or username), so running the seed twice
 * changes nothing and never overwrites what a person edited.
 *
 * Data rules (CLAUDE.md Safety): every person and organisation below is invented. Nothing is
 * derived from `reference/`. Built-in roles and their matrix rows are data in `iam.*`; the
 * seed only fills them the first time and tops up Super Admin with newly declared permissions.
 *
 * It connects as the owner role (the app role cannot insert tenants or currencies). It is a
 * development and CI tool: the CLI refuses to run when NODE_ENV is production.
 *
 * Depends on: pg, kernel/permissions/catalogue.ts, kernel/auth/password-hasher.ts.
 * Depended on by: ./seed-cli.ts, test/integration/seed.test.ts.
 */
import type pg from 'pg';
import { hashPassword } from '../kernel/auth/password-hasher.js';
import { createPrisma } from '../kernel/db/prisma.js';
import { seedLookups } from '../kernel/lookups/lookup-seed.js';
import { seedRates } from '../kernel/rates/rate-seed.js';
import { seedWorkflowNotificationRules } from '../kernel/workflows/workflow-notify-seed.js';
import { JOB_PERMISSIONS } from '../kernel/jobs/job-router.js';
import {
  KERNEL_PERMISSIONS,
  syncPermissionCatalogue,
  type PermissionDef,
} from '../kernel/permissions/catalogue.js';
import { FILES_PERMISSIONS } from '../modules/files/index.js';
import { GL_PERMISSIONS, seedLedger } from '../modules/gl/index.js';
import { NOTIFY_PERMISSIONS } from '../modules/notify/index.js';
import { PARTY_PERMISSIONS } from '../modules/party/index.js';
import {
  PEOPLE_PERMISSIONS,
  seedDocumentTypes,
  seedEmployeeStatus,
} from '../modules/people/index.js';

export interface SeedOptions {
  /** Plain password for the Super Admin. Only used when that user is created. */
  superAdminPassword: string;
  tenantSlug?: string;
  superAdminUsername?: string;
}

export interface SeedResult {
  tenantId: string;
  companyId: string;
  superAdminId: string;
  superAdminCreated: boolean;
}

/** Every permission the running code declares (same list main.ts syncs at start-up). */
export const ALL_PERMISSIONS: readonly PermissionDef[] = [
  ...KERNEL_PERMISSIONS,
  ...PARTY_PERMISSIONS,
  ...PEOPLE_PERMISSIONS,
  ...FILES_PERMISSIONS,
  ...NOTIFY_PERMISSIONS,
  ...GL_PERMISSIONS,
  ...JOB_PERMISSIONS,
];

interface RoleDef {
  key: string;
  name: string;
  description: string;
  /** Which permission keys the role holds, decided by this rule over the whole catalogue. */
  holds: (key: string) => boolean;
  /** Roles whose holders may give out the listed role keys. */
  mayGrant: string[];
}

// Keys only Super Admin keeps: they let a holder change who can do what, or act as someone else.
const SUPER_ONLY = new Set(['iam.role.assign_any', 'iam.user.impersonate']);
const isReadKey = (k: string) => /\.(read|view)$/.test(k);
// Self-service delegation: every ordinary role may arrange its own stand-in. The API limits
// these keys to the person's own delegations unless they also hold `manage_all` (admins).
const OWN_DELEGATION_KEYS = new Set(
  ['read', 'create', 'update', 'delete'].map((a) => `platform.workflow_delegation.${a}`),
);

const ROLES: RoleDef[] = [
  {
    key: 'super_admin',
    name: 'Super Admin',
    description: 'Holds every permission, including role assignment and impersonation.',
    holds: () => true,
    mayGrant: ['admin', 'manager', 'viewer'],
  },
  {
    key: 'admin',
    name: 'Admin',
    description: 'Runs the company day to day. Cannot give out any role or impersonate.',
    holds: (k) => !SUPER_ONLY.has(k),
    mayGrant: ['manager', 'viewer'],
  },
  {
    key: 'manager',
    name: 'Manager',
    description: 'Works with people and documents; reads everything else.',
    holds: (k) =>
      isReadKey(k) ||
      OWN_DELEGATION_KEYS.has(k) ||
      /^(party|files|people)\..*\.(create|update|delete|restore)$/.test(k),
    mayGrant: ['viewer'],
  },
  {
    key: 'viewer',
    name: 'Viewer',
    description: 'Read-only access.',
    holds: (k) => isReadKey(k) || OWN_DELEGATION_KEYS.has(k),
    mayGrant: [],
  },
];

const DEMO_PARTIES: { kind: 'person' | 'organisation'; name: string; role: string }[] = [
  { kind: 'person', name: 'Sample Worker One', role: 'worker' },
  { kind: 'person', name: 'Sample Worker Two', role: 'worker' },
  { kind: 'person', name: 'Sample Worker Three', role: 'worker' },
  { kind: 'person', name: 'Sample Supervisor', role: 'employee' },
  { kind: 'organisation', name: 'Demo Delivery Platform', role: 'client' },
  { kind: 'organisation', name: 'Demo Supplier Co', role: 'supplier' },
];

/** Runs the seed in one transaction. `pool` must connect as the owner role. */
export async function runSeed(pool: pg.Pool, opts: SeedOptions): Promise<SeedResult> {
  // Permission rows first, outside the transaction (idempotent, global reference data).
  const prisma = createPrisma(pool);
  try {
    await syncPermissionCatalogue(prisma, ALL_PERMISSIONS);
  } finally {
    await prisma.$disconnect();
  }

  const slug = opts.tenantSlug ?? 'demo';
  const username = opts.superAdminUsername ?? 'superadmin';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO platform.currency (code, name, minor_units) VALUES ('QAR', 'Qatari Riyal', 2)
       ON CONFLICT (code) DO NOTHING`,
    );

    // Tenant, company, branch: found by slug / legal name / code, created only when missing.
    const tenantId = await findOrCreate(
      client,
      `SELECT id FROM platform.tenant WHERE slug = $1 AND deleted_at IS NULL`,
      [slug],
      `INSERT INTO platform.tenant (name, slug, onboarded_at) VALUES ('Demo Tenant', $1, now()) RETURNING id`,
    );
    // Row-level security keys on these settings; the owner role passes anyway, but the audit
    // trigger and later reads expect the same context the API sets.
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);

    const companyId = await findOrCreate(
      client,
      `SELECT id FROM platform.company WHERE tenant_id = $1 AND legal_name = 'Demo Manpower Services' AND deleted_at IS NULL`,
      [tenantId],
      `INSERT INTO platform.company (tenant_id, legal_name, trade_name, country_code, base_currency)
       VALUES ($1, 'Demo Manpower Services', 'Demo Manpower', 'QA', 'QAR') RETURNING id`,
    );
    await findOrCreate(
      client,
      `SELECT id FROM platform.branch WHERE company_id = $1 AND code = 'HQ' AND deleted_at IS NULL`,
      [companyId],
      `INSERT INTO platform.branch (tenant_id, company_id, code, name, is_head_office)
       VALUES ($2, $1, 'HQ', 'Head office', true) RETURNING id`,
      [companyId, tenantId],
    );

    // Roles: create missing ones; give each role its rows only when the role is new, except
    // Super Admin, which always receives any permission declared since the last run.
    const roleIds = new Map<string, string>();
    const perms = await client.query<{ id: string; key: string }>(
      `SELECT id, key FROM iam.permission WHERE is_active`,
    );
    for (const role of ROLES) {
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM iam.role WHERE tenant_id = $1 AND key = $2 AND deleted_at IS NULL`,
        [tenantId, role.key],
      );
      let roleId = existing.rows[0]?.id;
      const isNew = roleId === undefined;
      if (roleId === undefined) {
        const ins = await client.query<{ id: string }>(
          `INSERT INTO iam.role (tenant_id, key, name, description, is_builtin)
           VALUES ($1, $2, $3, $4, true) RETURNING id`,
          [tenantId, role.key, role.name, role.description],
        );
        roleId = one(ins.rows).id;
      }
      roleIds.set(role.key, roleId);
      // Existing roles are left as the administrator set them, except that the built-in
      // manager and viewer receive the own-delegation keys (added in Phase 2.11c).
      // Only once: when the role has never had any of those rows (even a removed one), so an
      // administrator who later takes them away is not overruled by the next seed run.
      let topUp = false;
      if (!isNew && (role.key === 'manager' || role.key === 'viewer')) {
        const had = await client.query(
          `SELECT 1 FROM iam.role_permission rp JOIN iam.permission p ON p.id = rp.permission_id
            WHERE rp.role_id = $1 AND p.key = ANY($2::text[]) LIMIT 1`,
          [roleId, [...OWN_DELEGATION_KEYS]],
        );
        topUp = had.rowCount === 0;
      }
      if (isNew || role.key === 'super_admin' || topUp) {
        const ids = perms.rows
          .filter((p) => role.holds(p.key) && (!topUp || OWN_DELEGATION_KEYS.has(p.key)))
          .map((p) => p.id);
        await client.query(
          `INSERT INTO iam.role_permission (tenant_id, role_id, permission_id)
           SELECT $1, $2, unnest($3::uuid[])
           ON CONFLICT (role_id, permission_id) WHERE deleted_at IS NULL DO NOTHING`,
          [tenantId, roleId, ids],
        );
      }
    }
    for (const role of ROLES) {
      for (const target of role.mayGrant) {
        await client.query(
          `INSERT INTO iam.role_grantable (tenant_id, grantor_role_id, grantable_role_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (grantor_role_id, grantable_role_id) WHERE deleted_at IS NULL DO NOTHING`,
          [tenantId, roleIds.get(role.key), roleIds.get(target)],
        );
      }
    }

    // Super Admin: the password is set only when the user is first created.
    const found = await client.query<{ id: string }>(
      `SELECT id FROM iam.user_account WHERE tenant_id = $1 AND username = $2 AND deleted_at IS NULL`,
      [tenantId, username],
    );
    let superAdminId = found.rows[0]?.id;
    const superAdminCreated = superAdminId === undefined;
    if (superAdminId === undefined) {
      const user = await client.query<{ id: string }>(
        `INSERT INTO iam.user_account (tenant_id, username, email, display_name, must_change_password)
         VALUES ($1, $2, 'superadmin@demo.fibrex.local', 'Super Admin', false) RETURNING id`,
        [tenantId, username],
      );
      superAdminId = one(user.rows).id;
      await client.query(
        `INSERT INTO iam.credential (tenant_id, user_id, kind, hash) VALUES ($1, $2, 'password', $3)`,
        [tenantId, superAdminId, await hashPassword(opts.superAdminPassword)],
      );
      const membership = await client.query<{ id: string }>(
        `INSERT INTO iam.company_membership (tenant_id, user_id, company_id, is_default)
         VALUES ($1, $2, $3, true) RETURNING id`,
        [tenantId, superAdminId, companyId],
      );
      await client.query(
        `INSERT INTO iam.membership_role (tenant_id, membership_id, role_id) VALUES ($1, $2, $3)`,
        [tenantId, one(membership.rows).id, roleIds.get('super_admin')],
      );
    }

    // Synthetic parties (invented names, no identifiers, no contact details).
    for (const p of DEMO_PARTIES) {
      const partyId = await findOrCreate(
        client,
        `SELECT id FROM party.party WHERE company_id = $1 AND display_name = $2 AND deleted_at IS NULL`,
        [companyId, p.name],
        `INSERT INTO party.party (tenant_id, company_id, kind, display_name, names)
         VALUES ($3, $1, $4, $2, jsonb_build_object('en', $2::text)) RETURNING id`,
        [companyId, p.name, tenantId, p.kind],
      );
      await client.query(
        `INSERT INTO party.party_role (tenant_id, company_id, party_id, role_type)
         SELECT $1, $2, $3, $4
         WHERE NOT EXISTS (SELECT 1 FROM party.party_role
                           WHERE party_id = $3 AND role_type = $4 AND deleted_at IS NULL)`,
        [tenantId, companyId, partyId, p.role],
      );
    }

    // Starting dropdown lists (added only where missing; edits are never overwritten).
    await seedLookups(client, tenantId);
    // Starting client and pay rates per order (only for tables the tenant does not have).
    await seedRates(client, tenantId);
    // Starting notification rules for the workflow events (only those missing by name).
    await seedWorkflowNotificationRules(client, tenantId);
    // Standard chart of accounts, tax code NONE and this fiscal year (only where missing).
    await seedLedger(client, tenantId, companyId);
    // Employee status machine (active, inactive, blocked, terminated) when the tenant has none.
    await seedEmployeeStatus(client, tenantId);
    // Employee codes E0001, E0002 ... (owner's choice, phase 3 plan question 4).
    await client.query(
      `INSERT INTO platform.number_sequence (tenant_id, company_id, key, prefix, padding, reset_policy, format)
       SELECT $1, $2, 'employee', '', 4, 'never', 'E{0000}'
       WHERE NOT EXISTS (SELECT 1 FROM platform.number_sequence
                         WHERE company_id = $2 AND key = 'employee' AND deleted_at IS NULL)`,
      [tenantId, companyId],
    );
    // Standard document types and who must hold them (phase 3 plan question 3).
    await seedDocumentTypes(client, tenantId, companyId);

    await client.query('COMMIT');
    return { tenantId, companyId, superAdminId, superAdminCreated };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function findOrCreate(
  client: pg.PoolClient,
  select: string,
  params: unknown[],
  insert: string,
  insertParams: unknown[] = params,
): Promise<string> {
  const found = await client.query<{ id: string }>(select, params);
  if (found.rows[0]) return found.rows[0].id;
  const made = await client.query<{ id: string }>(insert, insertParams);
  return one(made.rows).id;
}

/** The single row an INSERT ... RETURNING produced; fails loudly if there is none. */
function one<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error('Seed: expected one row back from the database');
  return row;
}
