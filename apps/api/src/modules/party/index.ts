/**
 * Party module: public entry point (SPEC 2.13: other modules import only this file).
 *
 * Purpose: every person and organisation exactly once (SPEC 2.8), with roles, identifiers,
 * contacts, addresses, relationships, bank accounts, duplicate review and merge.
 * Other modules hold `party_id` and ask this module for the rest; a module that keeps a
 * party id registers it with `references` so a merge can move it.
 *
 * `createPartyModule` returns the module manifest (routes, permissions, recycle-bin
 * types, the attachable party, the People menu entry) for the kernel module registry.
 *
 * Depends on: ./party-router.ts, ./identifier-router.ts, ./bank-account-router.ts,
 * ./duplicates.ts, ./merge.ts, ./vault.ts, ./party-service.ts, kernel/module-registry.
 * Used by: src/main.ts, modules/people (PartyService).
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import type { AuditService } from '../../kernel/audit/audit-service.js';
import type { RecycleBinType } from '../../kernel/audit/recycle-bin.js';
import type { BaseRow, Repository } from '../../kernel/db/repository.js';
import type { UnitOfWork } from '../../kernel/db/unit-of-work.js';
import type { ModuleManifest } from '../../kernel/module-registry/index.js';
import {
  crudPermissions,
  permission,
  type PermissionDef,
} from '../../kernel/permissions/catalogue.js';
import type { PermissionService } from '../../kernel/permissions/permission-service.js';
import { createBankAccountRepository, createBankAccountRouter } from './bank-account-router.js';
import { createDuplicateRouter } from './duplicates.js';
import { createIdentifierRepository, createIdentifierRouter } from './identifier-router.js';
import { PartyMergeService, createMergeRouter, type PartyReferenceRegistry } from './merge.js';
import { createPartyRepositories, createPartyRouter } from './party-router.js';
import type { PartyVault } from './vault.js';

export { PartyReferenceRegistry, type PartyReference } from './merge.js';
export { PartyVault } from './vault.js';
export {
  PartyService,
  type IdentityMatch,
  type IdentityMatchReason,
  type NewPerson,
  type PartySummary,
} from './party-service.js';

export const PARTY_PERMISSIONS: readonly PermissionDef[] = [
  ...crudPermissions('party', 'party.party', 'parties'),
  permission('party', 'party.party', 'merge', 'Merge two parties into one'),
  ...crudPermissions('party', 'party.role', 'party roles'),
  ...crudPermissions('party', 'party.contact', 'party contacts'),
  ...crudPermissions('party', 'party.address', 'party addresses'),
  ...crudPermissions('party', 'party.relationship', 'party relationships'),
  ...crudPermissions('party', 'party.identifier', 'party identifiers'),
  permission(
    'party',
    'party.identifier',
    'reveal',
    'Show the real value of a sensitive identifier',
  ),
  ...crudPermissions('party', 'party.bank_account', 'party bank accounts'),
  permission(
    'party',
    'party.bank_account',
    'verify',
    'Mark a bank account proof document as checked',
  ),
  permission(
    'party',
    'party.bank_account',
    'approve',
    'Approve or reject a bank account (second person)',
  ),
  permission('party', 'party.bank_account', 'reveal', 'Show the real bank account number'),
  permission('party', 'party.duplicate', 'read', 'View likely duplicate parties'),
  permission('party', 'party.duplicate', 'update', 'Dismiss duplicates and search for them'),
];

export interface PartyModuleDeps {
  uow: UnitOfWork;
  registry: OpenAPIRegistry;
  permissions: PermissionService;
  audit: AuditService;
  vault: PartyVault;
  references: PartyReferenceRegistry;
}

export function createPartyModule(deps: PartyModuleDeps): ModuleManifest {
  const { uow, registry, permissions, audit, vault, references } = deps;
  const repositories = createPartyRepositories();
  const identifiers = createIdentifierRepository(vault);
  const bankAccounts = createBankAccountRepository(vault);
  const merges = new PartyMergeService({ permissions, audit, references });

  // One recycle-bin entry; the cast only widens the row type, the repository is unchanged.
  const recycle = <TRow extends BaseRow>(
    entityType: string,
    label: string,
    repository: Repository<TRow>,
    describe: (row: TRow) => string,
  ): RecycleBinType =>
    ({ entityType, moduleKey: 'party', label, repository, describe }) as unknown as RecycleBinType;

  return {
    key: 'party',
    label: 'People and organisations',
    permissions: PARTY_PERMISSIONS,
    routers: [
      createPartyRouter({ uow, registry, permissions }),
      createIdentifierRouter({ uow, registry, permissions, audit, vault, repository: identifiers }),
      createBankAccountRouter({
        uow,
        registry,
        permissions,
        audit,
        vault,
        repository: bankAccounts,
      }),
      createDuplicateRouter({ uow, registry, permissions }),
      createMergeRouter({ uow, registry, merges }),
    ],
    nav: [
      {
        path: '/people',
        labelKey: 'nav.people',
        groupKey: 'nav.people.group',
        permission: 'party.party.read',
      },
    ],
    recycleTypes: [
      recycle('party.party', 'Party', repositories.party, (r) => r.displayName),
      recycle('party.party_role', 'Party role', repositories.role, (r) => r.roleType),
      recycle(
        'party.party_identifier',
        'Party identifier',
        identifiers,
        (r) => `${r.type} ${r.valueMasked}`,
      ),
      recycle(
        'party.party_contact',
        'Party contact',
        repositories.contact,
        (r) => `${r.kind} ${r.value}`,
      ),
      recycle('party.party_address', 'Party address', repositories.address, (r) => r.kind),
      recycle(
        'party.party_relationship',
        'Party relationship',
        repositories.relationship,
        (r) => r.type,
      ),
      recycle(
        'party.party_bank_account',
        'Party bank account',
        bankAccounts,
        (r) => `${r.accountName} ${r.ibanMasked}`,
      ),
    ],
    // Administrators may add custom fields to people and organisations (phase 2 row 2.4).
    entities: [{ key: 'party.party', name: { en: 'People and organisations' } }],
    attachables: [
      {
        entityType: 'party.party',
        readPermission: 'party.party.read',
        attachPermission: 'party.party.update',
        exists: async (db, id) =>
          (await db.party.findFirst({ where: { id }, select: { id: true } })) !== null,
      },
    ],
  };
}
