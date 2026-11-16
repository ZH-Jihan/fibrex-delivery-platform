/**
 * Permission catalogue: the list of permission keys that exist.
 *
 * Purpose: `iam.permission` is global reference data (no tenant). Code declares the keys
 * it checks; `syncPermissionCatalogue` writes them to the table at start-up, so the
 * matrix screen always offers exactly the permissions the running code enforces. Which
 * role holds which key is data in `iam.role_permission`, never code (SPEC 2.1, 2.6).
 *
 * Key shape: `<resource>.<action>`, where the resource is `<module>.<thing>` and the
 * standard actions are read, create, update, delete and restore (DECISIONS 2026-11-14).
 *
 * The kernel's own keys are declared here. Modules declare theirs (built with
 * `crudPermissions`) in their manifest; `main.ts` syncs the kernel list plus
 * `ModuleRegistry.permissions()` (kernel/module-registry).
 * The keys of custom record types (`custom.<key>.<action>`) are the one exception to "code
 * declares": they are written when an administrator first publishes the type
 * (kernel/entities/entity-definition-service.ts).
 * A key that code stops declaring is left in the table: removing it is a deliberate
 * migration, so no deploy can silently drop rows of the matrix.
 *
 * Depends on: kernel/db/prisma.ts. Used by: src/main.ts, ./permission-service.ts users,
 * integration tests.
 */
import type { Db } from '../db/prisma.js';

export interface PermissionDef {
  key: string;
  moduleKey: string;
  action: string;
  resource: string;
  description: string;
}

const KEY_FORMAT = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/** One definition; the key is `<resource>.<action>`. */
export function permission(
  moduleKey: string,
  resource: string,
  action: string,
  description: string,
): PermissionDef {
  return { key: `${resource}.${action}`, moduleKey, action, resource, description };
}

/** The five standard keys of a resource built with the CRUD router factory. */
export function crudPermissions(
  moduleKey: string,
  resource: string,
  label: string,
): PermissionDef[] {
  return [
    permission(moduleKey, resource, 'read', `View ${label}`),
    permission(moduleKey, resource, 'create', `Create ${label}`),
    permission(moduleKey, resource, 'update', `Change ${label}`),
    permission(moduleKey, resource, 'delete', `Delete ${label} (to the recycle bin)`),
    permission(moduleKey, resource, 'restore', `Restore deleted ${label}`),
  ];
}

export const KERNEL_PERMISSIONS: readonly PermissionDef[] = [
  ...crudPermissions('iam', 'iam.user', 'user accounts'),
  permission('iam', 'iam.user', 'lock', 'Lock, unlock and sign out a user'),
  permission('iam', 'iam.user', 'reset_password', 'Send a user a link to reset their password'),
  permission(
    'iam',
    'iam.user',
    'manage_access',
    "Change a user's companies, roles, permission overrides and data scope",
  ),
  ...crudPermissions('iam', 'iam.role', 'roles'),
  permission(
    'iam',
    'iam.role',
    'assign_any',
    'Give out any role in any company, and decide which roles other roles may give out',
  ),
  permission(
    'iam',
    'iam.user',
    'impersonate',
    'Act as another user for support (logged with both identities)',
  ),
  ...crudPermissions('iam', 'iam.api_client', 'API clients'),
  permission('iam', 'iam.api_client', 'manage_keys', 'Issue and revoke API keys of a client'),
  permission('iam', 'iam.permission_matrix', 'read', 'View the permission matrix'),
  permission('iam', 'iam.permission_matrix', 'update', 'Change the permission matrix'),
  permission('platform', 'platform.company', 'read', 'View company settings'),
  permission('platform', 'platform.company', 'update', 'Change company settings'),
  ...crudPermissions('platform', 'platform.branch', 'branches'),
  ...crudPermissions('platform', 'platform.number_sequence', 'numbering sequences'),
  ...crudPermissions('platform', 'platform.lookup_type', 'lookup types'),
  ...crudPermissions('platform', 'platform.lookup_value', 'lookup values'),
  ...crudPermissions('platform', 'platform.template', 'templates'),
  ...crudPermissions('platform', 'platform.template_version', 'template versions'),
  permission('platform', 'platform.template_version', 'publish', 'Publish a template version'),
  permission(
    'platform',
    'platform.template_version',
    'preview',
    'Preview a template version with sample data',
  ),
  ...crudPermissions('platform', 'platform.formula', 'formulas'),
  permission(
    'platform',
    'platform.formula',
    'evaluate',
    'Try a formula with sample inputs and see how it was calculated',
  ),
  ...crudPermissions('platform', 'platform.formula_version', 'formula versions'),
  permission('platform', 'platform.formula_version', 'test', 'Run the test cases of a formula'),
  permission(
    'platform',
    'platform.formula_version',
    'activate',
    'Put a formula version in force from its start date',
  ),
  ...crudPermissions('platform', 'platform.rate_table', 'rate tables'),
  ...crudPermissions('platform', 'platform.rate_table_row', 'rates in rate tables'),
  ...crudPermissions('platform', 'platform.state_machine', 'state machines'),
  ...crudPermissions('platform', 'platform.state', 'states of state machines'),
  ...crudPermissions('platform', 'platform.state_transition', 'transitions of state machines'),
  ...crudPermissions('platform', 'platform.entity_definition', 'record types'),
  permission(
    'platform',
    'platform.entity_definition',
    'publish',
    'Publish a record type so its changes take effect',
  ),
  ...crudPermissions('platform', 'platform.field_definition', 'fields of record types'),
  ...crudPermissions('integration', 'integration.import_mapping', 'saved import mappings'),
  ...crudPermissions('integration', 'integration.export_job', 'bulk exports'),
  ...crudPermissions('integration', 'integration.import_job', 'imports'),
  permission(
    'integration',
    'integration.import_job',
    'commit',
    'Start the import of previewed rows',
  ),
  permission(
    'integration',
    'integration.import_job',
    'rollback',
    'Undo a committed import (the records it created go to the recycle bin)',
  ),
  permission('audit', 'audit.log', 'read', 'View the audit log and record history'),
  permission('audit', 'audit.log', 'export', 'Export the audit log'),
  permission('audit', 'audit.log', 'verify', 'Verify the audit log hash chain'),
  permission('audit', 'recycle_bin', 'view', 'View the recycle bin'),
  permission('audit', 'recycle_bin', 'restore', 'Restore records from the recycle bin'),
];

/**
 * Writes the definitions to `iam.permission`: new keys are inserted, changed wording is
 * updated, unchanged rows are not touched (so their version does not move on every start).
 * Safe to run from several API instances at once. Takes the process-wide client (start-up)
 * or a unit of work's client (publishing a custom record type adds its keys, row 2.5).
 */
export async function syncPermissionCatalogue(
  prisma: Pick<Db, '$executeRaw'>,
  defs: readonly PermissionDef[] = KERNEL_PERMISSIONS,
): Promise<void> {
  const seen = new Set<string>();
  for (const def of defs) {
    if (!KEY_FORMAT.test(def.key)) throw new Error(`Invalid permission key: ${def.key}`);
    if (seen.has(def.key)) throw new Error(`Permission declared twice: ${def.key}`);
    seen.add(def.key);
  }
  if (defs.length === 0) return;
  await prisma.$executeRaw`
    INSERT INTO iam.permission (key, module_key, action, resource, description)
    SELECT * FROM unnest(
      ${defs.map((d) => d.key)}::text[],
      ${defs.map((d) => d.moduleKey)}::text[],
      ${defs.map((d) => d.action)}::text[],
      ${defs.map((d) => d.resource)}::text[],
      ${defs.map((d) => d.description)}::text[])
    ON CONFLICT (key) DO UPDATE
      SET module_key = EXCLUDED.module_key,
          action = EXCLUDED.action,
          resource = EXCLUDED.resource,
          description = EXCLUDED.description,
          is_active = true
      WHERE (permission.module_key, permission.action, permission.resource,
             permission.description, permission.is_active)
            IS DISTINCT FROM
            (EXCLUDED.module_key, EXCLUDED.action, EXCLUDED.resource, EXCLUDED.description, true)`;
}
